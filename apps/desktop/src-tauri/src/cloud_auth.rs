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
//!   6. [`wait`] exchanges the code — plus the PKCE verifier, over HTTPS — for a real token, and
//!      stores it in the OS keychain.
//!
//! WHAT PROTECTS WHAT, since a loopback redirect has more than one weakness:
//! * `state`    — a callback meant for a different launcher instance, and CSRF on the listener.
//! * PKCE       — a hostile local process that binds the port first and steals the code. It cannot
//!   redeem it: the verifier never leaves this process.
//! * 127.0.0.1  — binding the loopback interface only, so nothing off-machine can reach it.
//! * timeout    — the listener does not outlive the sign-in attempt.

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

struct CallbackResult {
    code: String,
    state: String,
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
    /// Wait for the browser callback, redeem the code, and persist the token.
    ///
    /// Consumes the attempt: a code is single-use, so there is nothing to retry with.
    pub async fn wait(mut self) -> Result<CloudUser> {
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

        let result = exchange(&callback.code, &self.state, &self.verifier).await?;
        store_token(&result.token)?;
        // Cache the identity HERE, not only in `current_user`.
        //
        // Without this a fresh sign-in stored the token but no cached user, so the next cold start
        // asked `auth_status_cached` who was signed in, got None, and showed the sign-in screen to
        // someone who had signed in minutes earlier. The token was valid the whole time — only the
        // thing first paint reads was missing. Signing in is precisely the moment the identity is
        // known and proven, so it is the right place to record it.
        cache_user(&result.user);
        Ok(result.user)
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

/// Remember who the token belongs to.
///
/// NOT a security control — the token is the credential and it is stored beside this. It exists so a
/// cold start can render the signed-in UI immediately instead of holding first paint on `/auth/me`,
/// which has a 15-second timeout and therefore made a slow network look like a hung app.
pub fn cache_user(user: &CloudUser) {
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
    let entry = keyring::Entry::new(TOKEN_SERVICE, USER_ACCOUNT).ok()?;
    let json = entry.get_password().ok()?;
    serde_json::from_str(&json).ok()
}

/// Forget the cached identity. Called on sign-out so the next start does not flash a stale name.
pub fn clear_cached_user() {
    if let Ok(entry) = keyring::Entry::new(TOKEN_SERVICE, USER_ACCOUNT) {
        let _ = entry.delete_credential();
    }
}

pub fn store_token(token: &str) -> Result<()> {
    let entry = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT)
        .context("no OS keychain available to store the sign-in")?;
    entry
        .set_password(token)
        .context("could not save the sign-in to the OS keychain")?;
    Ok(())
}

pub fn load_token() -> Option<String> {
    let entry = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT).ok()?;
    match entry.get_password() {
        Ok(token) if !token.is_empty() => Some(token),
        _ => None,
    }
}

pub fn clear_token() {
    if let Ok(entry) = keyring::Entry::new(TOKEN_SERVICE, TOKEN_ACCOUNT) {
        let _ = entry.delete_credential();
    }
    // ...and the cached identity with it, or the next cold start paints a name that is signed out.
    clear_cached_user();
}

/// Resolve the stored token to a user, confirming it is still valid.
pub async fn current_user() -> Result<Option<CloudUser>> {
    let Some(token) = load_token() else {
        return Ok(None);
    };

    let client = reqwest::Client::builder()
        .timeout(Duration::from_secs(15))
        .build()?;
    let res = client
        .get(format!("{}/auth/me", api_origin()))
        .bearer_auth(&token)
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
                        cache_user(user);
                    }
                    Ok(env.data)
                }
                _ => Ok(None),
            }
        }
        Ok(res) if res.status() == reqwest::StatusCode::UNAUTHORIZED => {
            // Definitively rejected: drop it so the UI stops trying and shows sign-in.
            clear_token();
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
