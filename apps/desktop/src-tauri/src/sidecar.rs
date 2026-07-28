//! Client for the Node `@lobster/engine-runner` sidecar (newline-delimited JSON-RPC over stdio).
//!
//! The Rust core spawns the sidecar once and talks to it over stdin/stdout. A background reader task
//! dispatches each response to the matching request by `id`, so concurrent `call`s are safe.
//! See docs/OPERATIONS.md (§4).

use std::collections::HashMap;
use std::process::Stdio;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Result};
use serde::Serialize;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{broadcast, oneshot, Mutex};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub struct SidecarClient {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
    // Out-of-band sidecar notifications (lines with a `notify` field, no `id`) — today the per-profile
    // agent's live AgentEvents. Subscribers (the Tauri event forwarder) receive each notification's
    // JSON; a lagged/absent subscriber never blocks the sidecar reader.
    notifications: broadcast::Sender<Value>,
    // Kept alive for the process lifetime; dropping it kills the sidecar.
    _child: Child,
}

impl SidecarClient {
    /// Spawn `node <sidecar_js>` and start the response reader.
    pub async fn spawn(node_path: &str, sidecar_js: &str) -> Result<Arc<Self>> {
        let mut child = Command::new(node_path)
            .arg(sidecar_js)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| anyhow!("sidecar: no stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| anyhow!("sidecar: no stdout"))?;
        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let (notifications, _) = broadcast::channel::<Value>(256);

        let reader_pending = pending.clone();
        let reader_notif = notifications.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            loop {
                let line = match lines.next_line().await {
                    Ok(Some(line)) => line,
                    Ok(None) => break, // EOF: the sidecar closed stdout (process exited).
                    // A transient read error (e.g. one invalid-UTF-8 line) must NOT permanently kill the
                    // reader and fail every future call while the child is still alive — skip and continue.
                    Err(_) => continue,
                };
                if line.trim().is_empty() {
                    continue;
                }
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if let Some(id) = value.get("id").and_then(Value::as_str) {
                    if let Some(tx) = reader_pending.lock().await.remove(id) {
                        let _ = tx.send(value);
                    }
                } else if value.get("notify").is_some() {
                    // Out-of-band notification (agent event). Best-effort fan-out; drop if no subscriber.
                    let _ = reader_notif.send(value);
                }
            }
            // Reader loop ended: the sidecar closed stdout or crashed. Drop every pending
            // sender so each in-flight caller's oneshot receiver resolves with a cancelled
            // error and fails fast, instead of blocking until the 90s timeout.
            reader_pending.lock().await.clear();
        });

        Ok(Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            notifications,
            _child: child,
        }))
    }

    /// Subscribe to out-of-band sidecar notifications (agent events). Each item is the full
    /// `{ "notify": "agent", "event": {...} }` line as JSON.
    pub fn subscribe(&self) -> broadcast::Receiver<Value> {
        self.notifications.subscribe()
    }

    /// Send a request and await its response `result` (or the sidecar's error).
    pub async fn call<P: Serialize>(&self, method: &str, params: P) -> Result<Value> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        // Send the request and await its response inside a single fallible future so we can
        // guarantee the pending entry is removed on *every* early return (serialization
        // failure, stdin write/flush error, or timeout). Otherwise the map would grow
        // unbounded, and on timeout a late response would arrive with no receiver.
        let sent: Result<Value> = async {
            let request = serde_json::json!({ "id": id, "method": method, "params": params });
            let mut line = serde_json::to_string(&request)?;
            line.push('\n');
            {
                let mut stdin = self.stdin.lock().await;
                stdin.write_all(line.as_bytes()).await?;
                stdin.flush().await?;
            }

            tokio::time::timeout(Duration::from_secs(90), rx)
                .await
                .map_err(|_| anyhow!("sidecar call '{method}' timed out"))?
                .map_err(|_| anyhow!("sidecar closed before responding to '{method}'"))
        }
        .await;

        let response = match sent {
            Ok(response) => response,
            Err(err) => {
                self.pending.lock().await.remove(&id);
                return Err(err);
            }
        };

        if response.get("ok").and_then(Value::as_bool).unwrap_or(false) {
            Ok(response.get("result").cloned().unwrap_or(Value::Null))
        } else {
            let message = response
                .get("error")
                .and_then(|e| e.get("message"))
                .and_then(Value::as_str)
                .unwrap_or("sidecar error")
                .to_string();
            Err(anyhow!(message))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Spawns the built sidecar and round-trips `ping` + `status` (no browser needed).
    #[tokio::test]
    async fn ping_and_status_roundtrip() {
        // Resolve relative to THIS crate, not the test's CWD (which was wrong before: the crate lives
        // at apps/desktop/src-tauri, so the sidecar bundle is THREE levels up under packages/). Using
        // CARGO_MANIFEST_DIR makes `cargo test --lib` pass without needing LOBSTER_SIDECAR set.
        let sidecar_js = std::env::var("LOBSTER_SIDECAR").unwrap_or_else(|_| {
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../packages/engine-runner/dist/index.js")
                .to_string_lossy()
                .into_owned()
        });
        let client = SidecarClient::spawn("node", &sidecar_js)
            .await
            .expect("spawn sidecar");

        let pong = client
            .call("ping", serde_json::json!({}))
            .await
            .expect("ping");
        assert_eq!(pong.get("pong").and_then(Value::as_bool), Some(true));

        let status = client
            .call("status", serde_json::json!({}))
            .await
            .expect("status");
        assert!(status.get("running").is_some(), "status has a running list");
    }

    /// Regression (bug 1): a `call` that fails to reach the sidecar must not leak its
    /// pending entry. We use `true` as a fake sidecar: it exits immediately, so its
    /// reader task ends *before* we call and the stdin write hits a broken pipe. The
    /// call must return an error quickly and leave the pending map empty.
    #[tokio::test]
    async fn call_removes_pending_on_send_failure() {
        let client = SidecarClient::spawn("true", "")
            .await
            .expect("spawn fake sidecar");

        // Let `true` exit and its reader task finish so the write below fails fast.
        tokio::time::sleep(Duration::from_millis(300)).await;

        let result = tokio::time::timeout(
            Duration::from_secs(10),
            client.call("ping", serde_json::json!({})),
        )
        .await;

        assert!(
            result.is_ok(),
            "call must not hang when the sidecar is gone"
        );
        assert!(
            result.unwrap().is_err(),
            "call must fail when the sidecar is gone"
        );
        assert!(
            client.pending.lock().await.is_empty(),
            "pending entry must be removed after a failed send (no unbounded growth)"
        );
    }

    /// Regression (bug 2): when the reader task exits with an in-flight caller waiting,
    /// the caller must fail fast rather than block for the full 90s timeout. `head -c1`
    /// accepts our request (so the write succeeds), emits one byte, then closes stdout
    /// without a real response — ending the reader loop, which must clear `pending` and
    /// cancel the waiting oneshot.
    #[tokio::test]
    async fn call_fails_fast_when_reader_exits() {
        let client = SidecarClient::spawn("head", "-c1")
            .await
            .expect("spawn fake sidecar");

        let result = tokio::time::timeout(
            Duration::from_secs(15),
            client.call("ping", serde_json::json!({})),
        )
        .await;

        assert!(
            result.is_ok(),
            "call must fail fast (well under 90s) when the reader task exits"
        );
        assert!(
            result.unwrap().is_err(),
            "call must surface an error when the sidecar closes without responding"
        );
    }
}
