//! Cloud sign-in for the launcher, via a browser loopback redirect (RFC 8252).
//!
//! WHY THIS DANCE INSTEAD OF AN IN-APP LOGIN FORM. A native form would have to handle the
//! password itself, and then keep handling it forever — password resets, email verification, rate
//! limiting, eventually 2FA — each duplicated in a second place. Sending the user to the website
//! keeps exactly one implementation of all of that, and the launcher never touches a credential.
//!
//! THE FLOW:
//!   1. [`begin`] picks a random `state` and PKCE `verifier`, binds a listener on 127.0.0.1:0
//!      (the OS assigns a free port), and returns the URL to open.
//!   2. The UI opens that URL in the system browser.
//!   3. The user signs up or logs in on lobrowser.com.
//!   4. The site redirects to `http://127.0.0.1:<port>/callback?code=…&state=…`.
//!   5. The listener answers with a "you can close this" page and hands the code back.
//!   6. [`SignInAttempt::wait`] exchanges the code — plus the PKCE verifier, over HTTPS — for a real
//!      token, then stores it only if that exact attempt still owns the sign-in slot.
//!
//! WHAT PROTECTS WHAT, since a loopback redirect has more than one weakness:
//! * `state`    — a callback meant for a different launcher instance, and CSRF on the listener.
//! * PKCE       — a hostile local process that binds the port first and steals the code. It cannot
//!   redeem it: the verifier never leaves this process.
//! * 127.0.0.1  — binding the loopback interface only, so nothing off-machine can reach it.
//! * timeout    — the listener does not outlive the sign-in attempt.

use std::collections::VecDeque;
use std::net::{Ipv4Addr, SocketAddr};
use std::sync::Arc;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::URL_SAFE_NO_PAD as BASE64URL;
use base64::Engine;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use tokio::sync::oneshot;

/// Keychain account holding the cloud bearer token.
const TOKEN_SERVICE: &str = "com.lobster.browser";
const TOKEN_ACCOUNT: &str = "cloud-token";

/// How long to wait for the user to finish in the browser before giving up.
///
/// Generous: this covers reading a pricing page, checking email for a verification link, and
/// finding a password. The listener is bound the whole time, so it is not unbounded either.
const SIGN_IN_TIMEOUT: Duration = Duration::from_secs(10 * 60);
/// Bounds pre-registration cancels and finished ids retained to order racing IPC commands.
const RECENT_ATTEMPT_LIMIT: usize = 32;

/// Default web origin. Overridable for staging via `LOBSTER_WEB_ORIGIN`.
const DEFAULT_WEB_ORIGIN: &str = "https://lobrowser.com";
/// Default API origin. Overridable via `LOBSTER_API_ORIGIN`.
const DEFAULT_API_ORIGIN: &str = "https://api.lobrowser.com";

/// The signed-in user, as the UI needs it.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CloudUser {
    pub id: String,
    pub email: String,
    #[serde(rename = "displayName", skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
}

/// What [`begin`] hands the UI so it can open a browser and then wait.
#[derive(Debug, Clone, Serialize)]
pub struct SignInHandle {
    /// The URL to open in the system browser.
    pub url: String,
    /// Loopback port the listener bound, for diagnostics.
    pub port: u16,
}

/// A sign-in attempt in progress: the listener plus the secrets that redeem its code.
pub struct PendingSignIn {
    state: String,
    verifier: String,
    /// Resolves with the `code` once the browser hits `/callback`.
    ///
    /// `Option` purely so `wait` can take it: this type implements `Drop` (to shut the listener
    /// down), and Rust forbids moving a field out of a value that has a destructor.
    code_rx: Option<oneshot::Receiver<CallbackResult>>,
    /// Dropping this shuts the listener down.
    shutdown: Option<oneshot::Sender<()>>,
}

/// Owns the one sign-in attempt this launcher may have in flight.
///
/// Cancellation and credential commit take the same mutex. Whichever gets it first wins: an
/// accepted cancellation removes the attempt before any keychain mutation, while a commit that
/// already started makes a later cancel return `false` so the UI accepts the completed sign-in.
#[derive(Clone, Default)]
pub struct SignInCoordinator {
    inner: Arc<std::sync::Mutex<SignInState>>,
}

#[derive(Default)]
struct SignInState {
    active: Option<ActiveSignIn>,
    pending_cancels: VecDeque<String>,
    finished: VecDeque<String>,
}

struct ActiveSignIn {
    id: String,
    cancel: Option<oneshot::Sender<()>>,
}

/// Registration for one IPC call. Dropping it releases only its own id, never a newer attempt.
pub struct SignInAttempt {
    coordinator: SignInCoordinator,
    id: String,
    cancel_rx: Option<oneshot::Receiver<()>>,
}

impl SignInState {
    fn contains_finished(&self, id: &str) -> bool {
        self.finished.iter().any(|candidate| candidate == id)
    }

    fn take_pending_cancel(&mut self, id: &str) -> bool {
        let Some(index) = self
            .pending_cancels
            .iter()
            .position(|candidate| candidate == id)
        else {
            return false;
        };
        self.pending_cancels.remove(index);
        true
    }

    fn remember_pending_cancel(&mut self, id: &str) {
        if self.pending_cancels.iter().any(|candidate| candidate == id) {
            return;
        }
        self.pending_cancels.push_back(id.to_owned());
        while self.pending_cancels.len() > RECENT_ATTEMPT_LIMIT {
            self.pending_cancels.pop_front();
        }
    }

    fn remember_finished(&mut self, id: &str) {
        if let Some(index) = self.finished.iter().position(|candidate| candidate == id) {
            self.finished.remove(index);
        }
        self.finished.push_back(id.to_owned());
        while self.finished.len() > RECENT_ATTEMPT_LIMIT {
            self.finished.pop_front();
        }
    }
}

struct CallbackResult {
    code: String,
    state: String,
}

impl SignInCoordinator {
    /// Reserve the single desktop sign-in slot for this UI-generated UUID.
    pub fn register(&self, id: &str) -> Result<SignInAttempt> {
        uuid::Uuid::parse_str(id).context("invalid sign-in attempt id")?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| anyhow!("sign-in coordinator lock was poisoned"))?;
        if state.contains_finished(id) {
            return Err(anyhow!("sign-in attempt already finished"));
        }
        if state.active.is_some() {
            return Err(anyhow!("another sign-in attempt is already in progress"));
        }
        if state.take_pending_cancel(id) {
            state.remember_finished(id);
            return Err(anyhow!("sign-in was cancelled"));
        }

        let (cancel, cancel_rx) = oneshot::channel();
        state.active = Some(ActiveSignIn {
            id: id.to_owned(),
            cancel: Some(cancel),
        });
        Ok(SignInAttempt {
            coordinator: self.clone(),
            id: id.to_owned(),
            cancel_rx: Some(cancel_rx),
        })
    }

    /// Cancel only the attempt the caller names, remembering a cancel that beats registration.
    ///
    /// `true` means cancellation was accepted (immediately or queued); `false` means that exact id
    /// already reached a terminal/committed state and its real result remains authoritative.
    pub fn cancel(&self, id: &str) -> Result<bool> {
        uuid::Uuid::parse_str(id).context("invalid sign-in attempt id")?;
        let mut state = self
            .inner
            .lock()
            .map_err(|_| anyhow!("sign-in coordinator lock was poisoned"))?;
        if state.contains_finished(id) {
            return Ok(false);
        }
        if state.active.as_ref().map(|attempt| attempt.id.as_str()) == Some(id) {
            let mut cancelled = state
                .active
                .take()
                .expect("matching active sign-in disappeared");
            state.remember_finished(id);
            if let Some(cancel) = cancelled.cancel.take() {
                let _ = cancel.send(());
            }
        } else {
            state.remember_pending_cancel(id);
        }
        Ok(true)
    }

    fn commit(&self, id: &str, result: ExchangeData) -> Result<CloudUser> {
        self.commit_with(id, result, |result| {
            store_session(&result.token, &result.user)
        })
    }

    fn commit_with<F>(&self, id: &str, result: ExchangeData, persist: F) -> Result<CloudUser>
    where
        F: FnOnce(&ExchangeData) -> Result<()>,
    {
        let mut state = self
            .inner
            .lock()
            .map_err(|_| anyhow!("sign-in coordinator lock was poisoned"))?;
        if state.active.as_ref().map(|attempt| attempt.id.as_str()) != Some(id) {
            return Err(anyhow!("sign-in was cancelled"));
        }

        // Keep the ownership lock through both credential writes. This is the cancellation boundary:
        // after this check an exact-id cancel cannot report success until the commit is complete.
        persist(&result)?;
        state.active.take();
        state.remember_finished(id);
        Ok(result.user)
    }

    fn release(&self, id: &str) {
        let Ok(mut state) = self.inner.lock() else {
            return;
        };
        if state.active.as_ref().map(|attempt| attempt.id.as_str()) == Some(id) {
            state.active.take();
            state.remember_finished(id);
        }
    }
}

impl SignInAttempt {
    /// Race explicit cancellation against the loopback callback, then commit only while still owner.
    pub async fn wait(mut self, pending: PendingSignIn) -> Result<CloudUser> {
        let mut cancel_rx = self
            .cancel_rx
            .take()
            .ok_or_else(|| anyhow!("sign-in attempt already consumed"))?;
        let result = tokio::select! {
            biased;
            _ = &mut cancel_rx => return Err(anyhow!("sign-in was cancelled")),
            result = pending.redeem() => result?,
        };
        self.coordinator.commit(&self.id, result)
    }
}

impl Drop for SignInAttempt {
    fn drop(&mut self) {
        self.coordinator.release(&self.id);
    }
}

/// Website origin. `pub(crate)` so the shell can send the user to the billing page, which is where
/// top-ups actually happen — the launcher never handles payment, for the same reason it never
/// handles a password.
pub(crate) fn web_origin() -> String {
    std::env::var("LOBSTER_WEB_ORIGIN").unwrap_or_else(|_| DEFAULT_WEB_ORIGIN.to_string())
}

/// API origin for cloud calls. `pub(crate)` so the sync client targets the same host as sign-in —
/// two modules resolving it independently is how a desktop ends up authenticating against one
/// deployment and syncing to another.
pub(crate) fn api_origin() -> String {
    std::env::var("LOBSTER_API_ORIGIN").unwrap_or_else(|_| DEFAULT_API_ORIGIN.to_string())
}

/// Random URL-safe token of `bytes` entropy.
fn random_token(bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    use aes_gcm::aead::rand_core::RngCore;
    aes_gcm::aead::OsRng.fill_bytes(&mut buf);
    BASE64URL.encode(buf)
}

/// PKCE challenge: base64url(SHA256(verifier)), unpadded (RFC 7636 §4.2).
fn code_challenge(verifier: &str) -> String {
    BASE64URL.encode(Sha256::digest(verifier.as_bytes()))
}

/// Start a sign-in: bind the loopback listener and build the browser URL.
///
/// `mode` is `"signup"` or `"login"` — it only decides which page opens; both produce the same
/// session.
pub async fn begin(mode: &str) -> Result<(SignInHandle, PendingSignIn)> {
    let state = random_token(24);
    // 32 bytes → 43 base64url chars, the RFC 7636 minimum, and what the backend DTO enforces.
    let verifier = random_token(32);
    let challenge = code_challenge(&verifier);

    // Port 0 asks the OS for any free port. Picking one ourselves would mean either a fixed port
    // (which another app can hold, and which makes the callback predictable) or a retry loop.
    // Binding 127.0.0.1 specifically, not 0.0.0.0: this must never be reachable off-machine.
    let listener = tokio::net::TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))
        .await
        .context("could not bind a loopback port for sign-in")?;
    let port = listener.local_addr()?.port();

    let (code_tx, code_rx) = oneshot::channel::<CallbackResult>();
    let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();

    let code_tx = Arc::new(std::sync::Mutex::new(Some(code_tx)));
    let app = axum::Router::new().route(
        "/callback",
        axum::routing::get({
            let code_tx = Arc::clone(&code_tx);
            move |axum::extract::Query(params): axum::extract::Query<CallbackQuery>| {
                let code_tx = Arc::clone(&code_tx);
                async move {
                    let responded = match (params.code, params.state) {
                        (Some(code), Some(state)) => {
                            // `take()`: the channel accepts one value. A second callback — a
                            // refresh, or a probe — must not panic on a consumed sender.
                            if let Some(tx) = code_tx.lock().ok().and_then(|mut g| g.take()) {
                                let _ = tx.send(CallbackResult { code, state });
                            }
                            true
                        }
                        _ => false,
                    };
                    axum::response::Html(callback_page(responded))
                }
            }
        }),
    );

    tokio::spawn(async move {
        let served = axum::serve(listener, app).with_graceful_shutdown(async {
            let _ = shutdown_rx.await;
        });
        if let Err(err) = served.await {
            tracing::warn!(%err, "sign-in loopback listener stopped");
        }
    });

    let url = format!(
        "{}/{}?desktop=1&state={}&port={}&challenge={}",
        web_origin(),
        if mode == "signup" { "signup" } else { "login" },
        urlencode(&state),
        port,
        urlencode(&challenge),
    );

    Ok((
        SignInHandle { url, port },
        PendingSignIn {
            state,
            verifier,
            code_rx: Some(code_rx),
            shutdown: Some(shutdown_tx),
        },
    ))
}

impl PendingSignIn {
    /// Wait for the browser callback and redeem its code, without mutating the signed-in account.
    ///
    /// Consumes the attempt: a code is single-use, so there is nothing to retry with.
    async fn redeem(mut self) -> Result<ExchangeData> {
        let code_rx = self
            .code_rx
            .take()
            .ok_or_else(|| anyhow!("sign-in attempt already consumed"))?;

        let callback = tokio::time::timeout(SIGN_IN_TIMEOUT, code_rx)
            .await
            .map_err(|_| anyhow!("sign-in timed out — no response from the browser"))?
            .map_err(|_| anyhow!("sign-in was cancelled"))?;

        // Re-check `state` here as well as on the server. The server's check stops a code being
        // redeemed by a different launcher; this one stops THIS launcher from redeeming a code it
        // never asked for — someone visiting the loopback URL with a code of their own.
        if callback.state != self.state {
            return Err(anyhow!("sign-in state mismatch — ignoring this callback"));
        }

        // Shut the listener down before the network call: the code is spent either way, and the
        // port should not stay bound while an HTTPS request is in flight.
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }

        exchange(&callback.code, &self.state, &self.verifier).await
    }
}

impl Drop for PendingSignIn {
    fn drop(&mut self) {
        // An abandoned attempt must not leave a listener bound on the loopback interface.
        if let Some(tx) = self.shutdown.take() {
            let _ = tx.send(());
        }
    }
}

#[derive(Debug, Deserialize)]
struct CallbackQuery {
    code: Option<String>,
    state: Option<String>,
}

#[derive(Debug, Deserialize)]
struct ExchangeEnvelope {
    code: i32,
    #[serde(default)]
    data: Option<ExchangeData>,
    #[serde(default)]
    msg: String,
}

#[derive(Debug, Deserialize)]
struct ExchangeData {
    user: CloudUser,
    token: String,
}

/// Trade the one-time code for a real token, over HTTPS, directly to the API.
async fn exchange(code: &str, state: &str, verifier: &str) -> Result<ExchangeData> {
    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(20))
        .build()?;

    let res = client
        .post(format!("{}/auth/desktop/exchange", api_origin()))
        .json(&serde_json::json!({
            "code": code,
            "state": state,
            "codeVerifier": verifier,
        }))
        .send()
        .await
        .context("could not reach the Lobster API to complete sign-in")?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();

    // The API answers business failures inside the envelope with HTTP 200, and auth failures with
    // 401 and a Nest error body. Parse the envelope first, then fall back to the status.
    if let Ok(envelope) = serde_json::from_str::<ExchangeEnvelope>(&body) {
        if envelope.code == 0 {
            if let Some(data) = envelope.data {
                return Ok(data);
            }
        }
        if !envelope.msg.is_empty() {
            return Err(anyhow!(envelope.msg));
        }
    }
    Err(anyhow!("sign-in failed (HTTP {})", status.as_u16()))
}

// --- Token storage -----------------------------------------------------------
//
// The keychain only — no file fallback, unlike the Local Store Key.
//
// The LSK falls back to a 0600 file because losing it makes every stored secret permanently
// undecryptable, so availability wins. A session token is the opposite: it expires, and it can
// always be obtained again by signing in. Writing it to disk to save the user one sign-in would
// trade a real, permanent exposure for a small convenience.

/// Keychain account holding the last verified user, so the app can paint before the network answers.
const USER_ACCOUNT: &str = "cloud-user";

/// Process-local logical session generation. Token bytes alone are insufficient: two logins in the
/// same second can mint an identical JWT, while their in-flight responses still belong to different
/// sessions. Every credential mutation advances this value under the same lock as keychain access.
static TOKEN_REVISION: std::sync::OnceLock<std::sync::Mutex<u64>> = std::sync::OnceLock::new();

#[derive(Debug, Clone)]
struct TokenSnapshot {
    token: String,
    revision: u64,
}

fn token_revision_guard() -> std::sync::MutexGuard<'static, u64> {
    TOKEN_REVISION
        .get_or_init(|| std::sync::Mutex::new(0))
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn token_snapshot_matches(
    snapshot: &TokenSnapshot,
    revision: u64,
    current_token: Option<&str>,
) -> bool {
    snapshot.revision == revision && current_token == Some(snapshot.token.as_str())
}

/// Remember who the token belongs to.
///
/// NOT a security control — the token is the credential and it is stored beside this. It exists so a
/// cold start can render the signed-in UI immediately instead of holding first paint on `/auth/me`,
/// which has a 15-second timeout and therefore made a slow network look like a hung app.
fn cache_user_unlocked(user: &CloudUser) {
    let Ok(entry) = keyring::Entry::new(TOKEN_SERVICE, USER_ACCOUNT) else {
        return;
    };
    if let Ok(json) = serde_json::to_string(user) {
        // Best-effort: a machine with no usable keychain still works, it just paints a little later.
        let _ = entry.set_password(&json);
    }
}

/// The last verified user, if one was cached. Purely local — never a network call.
pub fn cached_user() -> Option<CloudUser> {
    let _revision = token_revision_guard();
    let entry = keyring::Entry::new(TOKEN_SERVICE, USER_ACCOUNT).ok()?;
    let json = entry.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

/// Forget the cached identity. Called on sign-out so the next start does not flash a stale name.
fn clear_cached_user_unlocked() {
    if let Ok(entry) = keyring::Entry::new(TOKEN_SERVICE, USER_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

fn store_session(token: &str, user: &CloudUser) -> Result<()> {
    let mut revision = token_revision_guard();
    let entry = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT)
        .context("no OS keychain available to store the sign-in")?;
    entry
        .set_password(token)
        .context("could not save the sign-in to the OS keychain")?;
    // Token and cached owner become visible as one logical mutation to current_user's stale guards.
    cache_user_unlocked(user);
    *revision = revision.wrapping_add(1);
    Ok(())
}

fn load_token_unlocked() -> Option<String> {
    let entry = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(token) if !token.is_empty() => Some(token),
        _ => None,
    }
}

pub fn load_token() -> Option<String> {
    let _revision = token_revision_guard();
    load_token_unlocked()
}

fn token_snapshot() -> Option<TokenSnapshot> {
    let revision = token_revision_guard();
    let token = load_token_unlocked()?;
    Some(TokenSnapshot {
        token,
        revision: *revision,
    })
}

pub fn clear_token() {
    let mut revision = token_revision_guard();
    clear_token_unlocked();
    *revision = revision.wrapping_add(1);
}

fn clear_token_unlocked() {
    if let Ok(entry) = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT) {
        let _ = entry.delete_credential();
    }
    // ...and the cached identity with it, or the next cold start paints a name that is signed out.
    clear_cached_user_unlocked();
}

fn session_is_current(snapshot: &TokenSnapshot) -> bool {
    let revision = token_revision_guard();
    let token = load_token_unlocked();
    token_snapshot_matches(snapshot, *revision, token.as_deref())
}

fn cache_user_if_current(snapshot: &TokenSnapshot, user: &CloudUser) -> bool {
    let revision = token_revision_guard();
    let token = load_token_unlocked();
    if !token_snapshot_matches(snapshot, *revision, token.as_deref()) {
        return false;
    }
    cache_user_unlocked(user);
    true
}

fn clear_token_if_current(snapshot: &TokenSnapshot) -> bool {
    let mut revision = token_revision_guard();
    let token = load_token_unlocked();
    if !token_snapshot_matches(snapshot, *revision, token.as_deref()) {
        return false;
    }
    clear_token_unlocked();
    *revision = revision.wrapping_add(1);
    true
}

/// Resolve the stored token to a user, confirming it is still valid.
pub async fn current_user() -> Result<Option<CloudUser>> {
    let Some(session) = token_snapshot() else {
        return Ok(None);
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let res = client
        .get(format!("{}/auth/me", api_origin()))
        .bearer_auth(&session.token)
        .send()
        .await;

    match res {
        Ok(res) if res.status().is_success() => {
            let body = res.text().await.unwrap_or_default();
            #[derive(Deserialize)]
            struct MeEnvelope {
                code: i32,
                data: Option<CloudUser>,
            }
            match serde_json::from_str::<MeEnvelope>(&body) {
                Ok(env) if env.code == 0 => {
                    // Remember who this is, so the next cold start can paint before the network
                    // answers. The cache tracks reality because it is only written here, after a
                    // successful verification.
                    if let Some(user) = env.data.as_ref() {
                        if !cache_user_if_current(&session, user) {
                            return Ok(None);
                        }
                    } else if !session_is_current(&session) {
                        return Ok(None);
                    }
                    Ok(env.data)
                }
                _ => Ok(None),
            }
        }
        Ok(res) if res.status() == reqwest::StatusCode::UNAUTHORIZED => {
            // Definitively rejected, but only for the logical session that issued this request. A
            // slow token-A response must never delete a token-B sign-in that completed meanwhile.
            clear_token_if_current(&session);
            Ok(None)
        }
        Ok(_) => Ok(None),
        Err(err) => {
            // OFFLINE IS NOT SIGNED OUT. A network failure must not clear the token or force a
            // sign-in the user cannot complete without connectivity — it is reported so the UI can
            // let them continue working locally.
            Err(anyhow!(err).context("could not reach the Lobster API"))
        }
    }
}

/// Minimal percent-encoding for the query values this module builds.
///
/// Hand-rolled rather than adding a URL crate for two parameters. Both values are base64url
/// (`A-Z a-z 0-9 - _`), so in practice nothing needs escaping; this is here so a future caller
/// passing something else cannot silently produce a malformed URL.
fn urlencode(value: &str) -> String {
    let mut out = String::with_capacity(value.len());
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

/// The page the browser lands on after the redirect.
///
/// Self-contained and offline: it is served from a loopback port with no network access to our
/// assets, so everything is inline. Kept plain on purpose — it is on screen for a few seconds.
fn callback_page(ok: bool) -> String {
    let (title, message) = if ok {
        (
            "You're signed in",
            "Lobster Browser has been authorised. You can close this tab and return to the app.",
        )
    } else {
        (
            "Something went wrong",
            "This page was opened without a valid sign-in response. Start again from the app.",
        )
    };
    format!(
        r#"<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>{title} — Lobster Browser</title>
<style>
  :root {{ color-scheme: light dark; }}
  body {{
    margin: 0; min-height: 100vh; display: grid; place-items: center;
    font: 16px/1.55 system-ui, -apple-system, "Segoe UI", sans-serif;
    background: #fafafa; color: #18181b;
  }}
  @media (prefers-color-scheme: dark) {{ body {{ background: #0c0c0f; color: #f4f4f5; }} }}
  .card {{ max-width: 26rem; padding: 2.5rem; text-align: center; }}
  h1 {{ font-size: 1.5rem; font-weight: 600; margin: 0 0 .75rem; letter-spacing: -.02em; }}
  p {{ margin: 0; opacity: .7; }}
  .mark {{ font-size: 2.5rem; margin-bottom: 1rem; }}
</style>
</head>
<body>
  <div class="card">
    <div class="mark">{mark}</div>
    <h1>{title}</h1>
    <p>{message}</p>
  </div>
</body>
</html>"#,
        mark = if ok { "&#10003;" } else { "&#33;" },
        title = title,
        message = message,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_challenge_matches_rfc7636_vector() {
        // RFC 7636 Appendix B.
        let verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
        assert_eq!(
            code_challenge(verifier),
            "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM"
        );
    }

    #[test]
    fn verifier_length_satisfies_the_rfc_minimum() {
        // 32 random bytes must encode to at least the 43 characters RFC 7636 requires, which the
        // backend DTO also enforces.
        let verifier = random_token(32);
        assert!(verifier.len() >= 43, "got {} chars", verifier.len());
        assert!(verifier.len() <= 128);
    }

    #[test]
    fn urlencode_leaves_base64url_untouched_and_escapes_the_rest() {
        assert_eq!(urlencode("aZ09-_.~"), "aZ09-_.~");
        assert_eq!(urlencode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn stale_native_auth_responses_require_both_token_bytes_and_logical_revision() {
        let snapshot = TokenSnapshot {
            token: "same-token".into(),
            revision: 7,
        };

        assert!(token_snapshot_matches(&snapshot, 7, Some("same-token")));
        assert!(!token_snapshot_matches(&snapshot, 7, Some("new-token")));
        assert!(
            !token_snapshot_matches(&snapshot, 8, Some("same-token")),
            "an identical-token re-login is still a different logical session"
        );
        assert!(!token_snapshot_matches(&snapshot, 7, None));
    }

    const FIRST_ATTEMPT: &str = "11111111-1111-4111-8111-111111111111";
    const SECOND_ATTEMPT: &str = "22222222-2222-4222-8222-222222222222";
    const THIRD_ATTEMPT: &str = "33333333-3333-4333-8333-333333333333";

    #[test]
    fn a_cancel_that_arrives_before_registration_is_not_lost() {
        let coordinator = SignInCoordinator::default();
        assert!(coordinator.cancel(FIRST_ATTEMPT).expect("early cancel"));

        let error = coordinator
            .register(FIRST_ATTEMPT)
            .err()
            .expect("pre-cancelled registration must fail");
        assert!(error.to_string().contains("cancelled"));
        assert!(!coordinator.cancel(FIRST_ATTEMPT).expect("finished cancel"));

        let next = coordinator
            .register(SECOND_ATTEMPT)
            .expect("a different id remains usable");
        drop(next);
    }

    #[test]
    fn cancellation_is_exact_and_a_dropped_old_attempt_cannot_release_a_new_one() {
        let coordinator = SignInCoordinator::default();
        let first = coordinator.register(FIRST_ATTEMPT).expect("first attempt");

        assert!(coordinator.register(SECOND_ATTEMPT).is_err());
        assert!(coordinator.cancel(SECOND_ATTEMPT).expect("queued cancel"));
        assert!(coordinator.register(SECOND_ATTEMPT).is_err());
        assert!(coordinator.cancel(FIRST_ATTEMPT).expect("exact cancel"));

        let second_error = coordinator
            .register(SECOND_ATTEMPT)
            .err()
            .expect("queued exact-id cancel must survive the other attempt");
        assert!(second_error.to_string().contains("cancelled"));
        let third = coordinator
            .register(THIRD_ATTEMPT)
            .expect("slot released after cancel");
        drop(first);
        assert!(
            !coordinator.cancel(FIRST_ATTEMPT).expect("stale cancel"),
            "the old id must not disturb the replacement attempt"
        );
        assert!(coordinator.cancel(THIRD_ATTEMPT).expect("new cancel"));
        drop(third);
    }

    #[test]
    fn an_accepted_cancel_prevents_the_credential_persistence_callback() {
        let coordinator = SignInCoordinator::default();
        let attempt = coordinator.register(FIRST_ATTEMPT).expect("attempt");
        assert!(coordinator.cancel(FIRST_ATTEMPT).expect("cancel"));

        let persisted = std::cell::Cell::new(false);
        let result = ExchangeData {
            user: CloudUser {
                id: "cancelled-user".into(),
                email: "cancelled@example.test".into(),
                display_name: None,
            },
            token: "must-not-be-stored".into(),
        };
        let error = coordinator
            .commit_with(FIRST_ATTEMPT, result, |_| {
                persisted.set(true);
                Ok(())
            })
            .expect_err("cancelled commit must fail");

        assert!(!persisted.get());
        assert!(error.to_string().contains("cancelled"));
        drop(attempt);
    }

    #[tokio::test]
    async fn cancelling_the_wait_releases_its_loopback_listener() {
        let coordinator = SignInCoordinator::default();
        let attempt = coordinator.register(FIRST_ATTEMPT).expect("attempt");
        let (handle, pending) = begin("login").await.expect("begin");
        assert!(coordinator.cancel(FIRST_ATTEMPT).expect("cancel"));

        let error = attempt
            .wait(pending)
            .await
            .expect_err("cancel must interrupt the wait");
        assert!(error.to_string().contains("cancelled"));

        let address = SocketAddr::from((Ipv4Addr::LOCALHOST, handle.port));
        for _ in 0..50 {
            if let Ok(listener) = tokio::net::TcpListener::bind(address).await {
                drop(listener);
                return;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        panic!(
            "loopback port {} stayed bound after cancellation",
            handle.port
        );
    }

    /// Every parameter the website needs must survive into the URL.
    ///
    /// REGRESSION GUARD. The URL itself was always built correctly; what broke desktop sign-in was
    /// DELIVERING it through `cmd /c start`, where `&` separates commands, so the browser received
    /// only `…/login?desktop=1`. The site then saw a handoff with no state, port or challenge,
    /// could not recognise it as one, and never redirected to the loopback listener.
    ///
    /// This asserts the four parameters are present and non-empty. It does not, and cannot, prove
    /// the delivery path leaves them intact — that lives in `open_in_browser`, which now calls
    /// ShellExecuteW precisely so no command line is parsed on the way.
    #[tokio::test]
    async fn the_sign_in_url_carries_every_handoff_parameter() {
        let (handle, pending) = begin("login").await.expect("begin");

        let query = handle.url.split_once('?').expect("a query string").1;
        let params: std::collections::HashMap<_, _> = query
            .split('&')
            .filter_map(|pair| pair.split_once('='))
            .collect();

        assert_eq!(params.get("desktop"), Some(&"1"));
        for key in ["state", "port", "challenge"] {
            let value = params
                .get(key)
                .unwrap_or_else(|| panic!("{key} missing from {}", handle.url));
            assert!(!value.is_empty(), "{key} is empty");
        }
        assert_eq!(params["port"], handle.port.to_string());

        // Dropping the attempt releases the loopback listener.
        drop(pending);
    }
}
