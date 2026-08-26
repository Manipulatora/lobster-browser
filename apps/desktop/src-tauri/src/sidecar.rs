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
    // Kept alive for the process lifetime. Dropping it kills the sidecar ONLY because
    // `kill_on_drop(true)` is set in spawn_command — tokio's default is false, so this comment used
    // to describe a guarantee nothing provided. See the note there.
    _child: Child,
}

/// Kill the sidecar when THIS process dies, however it dies (Windows).
///
/// `kill_on_drop` covers the orderly case: the client is dropped and tokio reaps the child. It
/// cannot cover the disorderly ones — `std::process::exit`, a panic-abort, or the user ending the
/// app from Task Manager all skip destructors, and the sidecar simply keeps running.
///
/// Measured 2026-08-26: after the app was closed, three orphaned `node.exe` processes were still
/// alive, each running the INSTALLED `node.exe` and holding it open. The uninstaller then removed
/// everything else — including the 0.57 GB engine — and left `node\node.exe` behind, 87 MB, in a
/// directory it could not delete. Each orphan also still owned its loopback agent bridge and the
/// per-profile secrets it was started with, which matters more than the disk.
///
/// A Job Object with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` is the OS-level form of the guarantee:
/// when the last handle to the job closes — which the kernel does for us when this process exits, by
/// any route — every process assigned to it is terminated. It is the same mechanism Chromium uses
/// for its own children.
#[cfg(windows)]
mod job {
    use std::sync::OnceLock;
    use windows_sys::Win32::Foundation::{CloseHandle, HANDLE};
    use windows_sys::Win32::System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectExtendedLimitInformation,
        SetInformationJobObject, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    };

    /// `HANDLE` is a raw pointer. It is only ever read here, and the job lives for the whole process
    /// lifetime, so sharing it across threads is sound.
    struct JobHandle(HANDLE);
    unsafe impl Send for JobHandle {}
    unsafe impl Sync for JobHandle {}

    static JOB: OnceLock<Option<JobHandle>> = OnceLock::new();

    fn job() -> Option<HANDLE> {
        JOB.get_or_init(|| {
            // SAFETY: a null name creates an anonymous job owned by this process.
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            if handle.is_null() {
                tracing::warn!(
                    "could not create a job object; the sidecar will not be reaped on a hard exit"
                );
                return None;
            }
            let mut info: JOBOBJECT_EXTENDED_LIMIT_INFORMATION = unsafe { std::mem::zeroed() };
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            // SAFETY: `info` is a fully initialised structure of exactly the class named, and the
            // size passed is its own.
            let ok = unsafe {
                SetInformationJobObject(
                    handle,
                    JobObjectExtendedLimitInformation,
                    std::ptr::addr_of!(info).cast(),
                    std::mem::size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
                )
            };
            if ok == 0 {
                tracing::warn!(
                    "could not set KILL_ON_JOB_CLOSE; the sidecar will not be reaped on a hard exit"
                );
                // SAFETY: a live handle this function created, not used again.
                unsafe { CloseHandle(handle) };
                return None;
            }
            Some(JobHandle(handle))
        })
        .as_ref()
        .map(|handle| handle.0)
    }

    /// Assign a spawned child to the kill-on-close job.
    ///
    /// Never fatal. A failure here means the sidecar may outlive a hard exit — which is the state
    /// the product was already in — so it is logged rather than allowed to stop the app starting.
    pub fn adopt(raw_handle: HANDLE) {
        let Some(job) = job() else { return };
        // SAFETY: `raw_handle` is the live process handle tokio owns for the child just spawned.
        if unsafe { AssignProcessToJobObject(job, raw_handle) } == 0 {
            tracing::warn!(
                "could not assign the sidecar to the job object; it may outlive a hard exit"
            );
        }
    }
}

impl SidecarClient {
    /// Spawn `node <sidecar_js>` and start the response reader.
    pub async fn spawn(node_path: &str, sidecar_js: &str) -> Result<Arc<Self>> {
        let mut command = Command::new(node_path);
        command.arg(sidecar_js);
        Self::spawn_command(command).await
    }

    #[cfg(test)]
    pub(crate) async fn spawn_test_sidecar(mode: &str) -> Result<Arc<Self>> {
        let mut command = Command::new(std::env::current_exe()?);
        command
            .args([
                "--exact",
                "sidecar::tests::fake_sidecar_process",
                "--nocapture",
            ])
            .env("LOBSTER_TEST_SIDECAR_MODE", mode);
        Self::spawn_command(command).await
    }

    async fn spawn_command(mut command: Command) -> Result<Arc<Self>> {
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            // PIPED, NOT INHERITED. A GUI process has no console to inherit, so on Windows this is
            // the difference between the sidecar's diagnostics going to our log and Windows opening
            // a console window to put them in — which is what users saw: a terminal appearing beside
            // the app, printing the local API's 127.0.0.1 address. It is also better behaviour
            // everywhere else: sidecar stderr now reaches `tracing` instead of a stream nobody reads.
            .stderr(Stdio::piped())
            // Tokio's default is FALSE, and the `_child` field used to claim the opposite. Nothing
            // killed the sidecar, so every app exit left a `node.exe` running: measured 2026-08-26,
            // three of them at once, each still holding its loopback agent bridge and the installed
            // node.exe binary open. See the `job` module above for the hard-exit half.
            .kill_on_drop(true);

        // Belt and braces on Windows. `node.exe` is a CONSOLE-subsystem binary, so launching it
        // from a windows-subsystem process allocates a fresh console for the child regardless of
        // where its handles point. CREATE_NO_WINDOW suppresses that allocation.
        #[cfg(windows)]
        {
            // `creation_flags` is inherent on tokio's Command (it mirrors the std extension trait),
            // so importing std::os::windows::process::CommandExt here would be an unused import.
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        let mut child = command.spawn()?;

        // Adopt into the kill-on-close job before anything else can fail, so a sidecar that is alive
        // is always a sidecar the OS will reap with us.
        #[cfg(windows)]
        {
            if let Some(handle) = child.raw_handle() {
                job::adopt(handle as _);
            }
        }

        // Drain stderr into the log. Without a reader the pipe's buffer fills and the sidecar blocks
        // on its next write — a deadlock that only appears once it has logged a few kilobytes, which
        // is exactly the situation where the output matters.
        if let Some(stderr) = child.stderr.take() {
            tokio::spawn(async move {
                let mut lines = BufReader::new(stderr).lines();
                while let Ok(Some(line)) = lines.next_line().await {
                    tracing::debug!(target: "sidecar", "{line}");
                }
            });
        }

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
    use std::io::{BufRead, Write};

    /// A child copy of this test executable is the fake sidecar. This keeps process behavior under
    /// the test's control on every platform instead of depending on POSIX `true`/`head` or Node on
    /// PATH. In the parent test process the mode is absent, so this registered test returns at once.
    #[test]
    fn fake_sidecar_process() {
        let Ok(mode) = std::env::var("LOBSTER_TEST_SIDECAR_MODE") else {
            return;
        };

        if mode == "exit" {
            std::process::exit(0);
        }

        let stdin = std::io::stdin();
        let mut stdout = std::io::stdout().lock();
        for line in stdin.lock().lines() {
            let line = line.expect("read fake-sidecar request");
            if mode == "close-after-request" {
                // Start on a fresh line in case libtest printed its own progress prefix. The byte is
                // deliberately not JSON: the production reader must ignore it, observe EOF, and
                // cancel the in-flight request.
                stdout.write_all(b"\nx\n").unwrap();
                stdout.flush().unwrap();
                std::process::exit(0);
            }

            assert_eq!(mode, "rpc", "unknown fake-sidecar mode {mode}");
            let request: Value = serde_json::from_str(&line).expect("parse fake-sidecar request");
            let id = request.get("id").cloned().expect("request id");
            let method = request
                .get("method")
                .and_then(Value::as_str)
                .expect("request method");
            let response = match method {
                "ping" => serde_json::json!({ "id": id, "ok": true, "result": { "pong": true } }),
                "status" => {
                    serde_json::json!({ "id": id, "ok": true, "result": { "running": [] } })
                }
                "startProfile" => {
                    let params = request.get("params").expect("startProfile params");
                    if params.get("profileName").and_then(Value::as_str) == Some("Fail import") {
                        serde_json::json!({
                            "id": id,
                            "ok": false,
                            "error": { "code": "inject", "message": "cookie injection failed" }
                        })
                    } else {
                        serde_json::json!({
                            "id": id,
                            "ok": true,
                            "result": {
                                "profileId": params.get("profileId").cloned().unwrap_or(Value::Null),
                                "fingerprintSeed": params
                                    .get("fingerprintSeed")
                                    .cloned()
                                    .unwrap_or(Value::Null),
                                "pid": 7,
                                "ws": "ws://test",
                                "debuggerAddress": "127.0.0.1:7",
                                "cookieImportApplied": params
                                    .get("cookiesImport")
                                    .is_some_and(|value| !value.is_null()),
                                "proxyHost": params.pointer("/proxy/host").cloned().unwrap_or(Value::Null)
                            }
                        })
                    }
                }
                other => panic!("unexpected fake-sidecar method {other}"),
            };
            // See the close-after-request branch: isolate JSON from libtest's progress output.
            writeln!(stdout, "\n{response}").unwrap();
            stdout.flush().unwrap();
        }
    }

    /// Round-trip two requests through a real child process and the production stdio reader.
    #[tokio::test]
    async fn ping_and_status_roundtrip() {
        let client = SidecarClient::spawn_test_sidecar("rpc")
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
    /// pending entry. The fake child exits immediately, so its
    /// reader task ends *before* we call and the stdin write hits a broken pipe. The
    /// call must return an error quickly and leave the pending map empty.
    #[tokio::test]
    async fn call_removes_pending_on_send_failure() {
        let client = SidecarClient::spawn_test_sidecar("exit")
            .await
            .expect("spawn fake sidecar");

        // Let the child exit and its reader task finish so the write below fails fast.
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
    /// the caller must fail fast rather than block for the full 90s timeout. The fake child
    /// accepts our request (so the write succeeds), emits one byte, then closes stdout
    /// without a real response — ending the reader loop, which must clear `pending` and
    /// cancel the waiting oneshot.
    #[tokio::test]
    async fn call_fails_fast_when_reader_exits() {
        let client = SidecarClient::spawn_test_sidecar("close-after-request")
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
