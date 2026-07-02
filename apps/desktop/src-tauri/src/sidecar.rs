//! Client for the Node `@lobster/engine-runner` sidecar (newline-delimited JSON-RPC over stdio).
//!
//! The Rust core spawns the sidecar once and talks to it over stdin/stdout. A background reader task
//! dispatches each response to the matching request by `id`, so concurrent `call`s are safe.
//! See docs/contracts/sidecar-ipc.md.

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
use tokio::sync::{oneshot, Mutex};

type Pending = Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>;

pub struct SidecarClient {
    stdin: Mutex<ChildStdin>,
    pending: Pending,
    next_id: AtomicU64,
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

        let reader_pending = pending.clone();
        tokio::spawn(async move {
            let mut lines = BufReader::new(stdout).lines();
            while let Ok(Some(line)) = lines.next_line().await {
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
                }
            }
        });

        Ok(Arc::new(Self {
            stdin: Mutex::new(stdin),
            pending,
            next_id: AtomicU64::new(1),
            _child: child,
        }))
    }

    /// Send a request and await its response `result` (or the sidecar's error).
    pub async fn call<P: Serialize>(&self, method: &str, params: P) -> Result<Value> {
        let id = format!("r{}", self.next_id.fetch_add(1, Ordering::SeqCst));
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id.clone(), tx);

        let request = serde_json::json!({ "id": id, "method": method, "params": params });
        let mut line = serde_json::to_string(&request)?;
        line.push('\n');
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await?;
            stdin.flush().await?;
        }

        let response = tokio::time::timeout(Duration::from_secs(90), rx)
            .await
            .map_err(|_| anyhow!("sidecar call '{method}' timed out"))?
            .map_err(|_| anyhow!("sidecar closed before responding to '{method}'"))?;

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
        let sidecar_js = std::env::var("LOBSTER_SIDECAR")
            .unwrap_or_else(|_| "../../packages/engine-runner/dist/index.js".to_string());
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
}
