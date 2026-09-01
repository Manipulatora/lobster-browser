//! Managed-Lobee credentials: where the agent proxy is, and the short-lived token that authenticates
//! the signed-in user to it.
//!
//! WHAT THIS REPLACED. Managed mode used to demand `LOBSTER_AGENT_PROXY_URL` and
//! `LOBSTER_AGENT_PROXY_TOKEN` from the process environment. No installer has ever set either, so on
//! a real Windows install every managed run failed at the first line of `agent_start` — the feature
//! was reachable in the UI and dead in the product. Worse, the token it wanted was one static string
//! shared by every installation: it named nobody, so the backend could not tell whose wallet to
//! charge, and one copy of it spent the operator's model balance for everyone.
//!
//! WHAT HAPPENS INSTEAD. The proxy URL is derived from the API origin the rest of the app already
//! signs in and syncs against, so the launcher cannot authenticate against one deployment and spend
//! on another. The token is minted per user from the session already in the keychain
//! (`POST /agent/token`), lives half an hour, and carries the user and team — so the spend is
//! attributable and a leaked copy is worth minutes rather than forever.
//!
//! THE ENVIRONMENT PAIR STILL WORKS, and only as an override: `ci/validation/agent-battery*.mjs`
//! drives the sidecar against an operator proxy with no desktop session in the picture, and a
//! developer pointing at a local backend should not have to sign in first.
//!
//! A REFUSAL IS A RESULT, NOT AN ERROR. `free` and `light` may not run Lobee, and the backend says so
//! with a typed 403. That answer is carried to the sidecar as the credential state, so the panel can
//! name the user's package and what Plus unlocks before a task is typed.

use std::sync::Mutex;
use std::time::Duration;

use anyhow::{anyhow, Context, Result};
use serde::Deserialize;

use crate::cloud_auth;

/// Short: this runs inside the launch path of a run the user is waiting on.
const HTTP_TIMEOUT: Duration = Duration::from_secs(15);

/// Re-mint this far before expiry.
///
/// Comfortably wider than the renewal loop's interval on purpose: a token is replaced a whole tick
/// before it dies, so no window exists in which the sidecar holds one the proxy has stopped
/// accepting and a run has to pay for the discovery.
const RENEW_BEFORE_EXPIRY_SECS: i64 = 600;

/// Why the account cannot run Lobee. Mirrors the backend's `AgentRefusalReason` plus the two states
/// only the desktop can be in: no session at all, and no configured deployment.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RefusalCode {
    PlanRequired,
    InsufficientCredit,
    SignedOut,
    /// The backend failed, not the account. The panel already renders this code
    /// (`packages/lobee-app/src/types.ts`) with the right copy — "This is on our side, not yours" —
    /// and only ever showed the generic "Lobee is not connected yet" because the desktop had no
    /// code to send for it.
    ProviderUnavailable,
}

impl RefusalCode {
    fn as_str(self) -> &'static str {
        match self {
            RefusalCode::PlanRequired => "plan_required",
            RefusalCode::InsufficientCredit => "insufficient_credit",
            RefusalCode::SignedOut => "signed_out",
            RefusalCode::ProviderUnavailable => "provider_unavailable",
        }
    }
}

/// The account may not run the agent, and this is what to tell it.
#[derive(Debug, Clone)]
pub struct Refusal {
    pub code: RefusalCode,
    pub message: String,
    pub tier: Option<String>,
}

/// A live agent credential: the proxy base, the minted token, and how long it is good for.
#[derive(Debug, Clone)]
pub struct Credential {
    pub base_url: String,
    pub token: String,
    pub expires_in_seconds: i64,
    pub tier: Option<String>,
    /// Epoch seconds this token stops being accepted; used to decide when to re-mint.
    expires_at: i64,
}

/// What the desktop knows about this account's agent access right now.
#[derive(Debug, Clone)]
pub enum Access {
    Granted(Credential),
    Denied(Refusal),
}

/// Cached so a run, a panel launch and the renewal loop share one token rather than minting three.
static CACHE: Mutex<Option<Credential>> = Mutex::new(None);

/// The backend's managed LLM proxy base.
///
/// Derived from the same origin sign-in and sync use — `LOBSTER_AGENT_PROXY_URL` overrides it for
/// development and CI only.
pub fn base_url() -> String {
    match std::env::var("LOBSTER_AGENT_PROXY_URL") {
        Ok(value) if !value.trim().is_empty() => value.trim().trim_end_matches('/').to_string(),
        _ => format!(
            "{}/agent/llm",
            cloud_auth::api_origin().trim_end_matches('/')
        ),
    }
}

fn now_secs() -> i64 {
    chrono::Utc::now().timestamp()
}

/// The operator-supplied pair, when both halves are present. Development and CI only.
fn env_credential() -> Option<Credential> {
    let token = std::env::var("LOBSTER_AGENT_PROXY_TOKEN")
        .ok()
        .filter(|value| !value.trim().is_empty())?;
    Some(Credential {
        base_url: base_url(),
        token: token.trim().to_string(),
        // An operator token is not ours to renew, so it is never treated as expiring.
        expires_in_seconds: 0,
        tier: None,
        expires_at: i64::MAX,
    })
}

/// The typed refusal body the agent endpoints answer with (`AgentRefusalFilter` keeps it intact).
#[derive(Deserialize)]
struct RefusalBody {
    #[serde(default)]
    reason: Option<String>,
    #[serde(rename = "currentTier", default)]
    current_tier: Option<String>,
    #[serde(default)]
    error: Option<RefusalError>,
}

#[derive(Deserialize)]
struct RefusalError {
    #[serde(default)]
    message: Option<String>,
}

#[derive(Deserialize)]
struct TokenData {
    token: String,
    #[serde(rename = "expiresInSeconds", default)]
    expires_in_seconds: Option<i64>,
    #[serde(default)]
    tier: Option<String>,
}

#[derive(Deserialize)]
struct TokenEnvelope {
    code: i32,
    #[serde(default)]
    data: Option<TokenData>,
    #[serde(default)]
    msg: Option<String>,
}

/// Mint a fresh agent token for the signed-in session.
async fn mint() -> Result<Access> {
    let session = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
    let res = client
        .post(format!("{}/agent/token", cloud_auth::api_origin()))
        .bearer_auth(&session)
        .json(&serde_json::json!({}))
        .send()
        .await
        .context("could not reach the Lobster API to authorise Lobee")?;

    let status = res.status();
    let body = res.text().await.unwrap_or_default();

    if status.is_success() {
        let envelope: TokenEnvelope =
            serde_json::from_str(&body).context("the agent token response could not be read")?;
        let data = envelope
            .data
            .filter(|_| envelope.code == 0)
            .ok_or_else(|| anyhow!(envelope.msg.unwrap_or_else(|| "agent token refused".into())))?;
        let ttl = data.expires_in_seconds.unwrap_or(0).max(0);
        return Ok(Access::Granted(Credential {
            base_url: base_url(),
            token: data.token,
            expires_in_seconds: ttl,
            tier: data.tier,
            // A token with no stated lifetime is renewed on its next use rather than trusted
            // indefinitely: guessing long is how a run ends up holding a credential the server
            // stopped accepting.
            expires_at: if ttl > 0 { now_secs() + ttl } else { 0 },
        }));
    }

    classify_token_refusal(status, &body)
}

/// Map a NON-success `POST /agent/token` response to an [`Access`] decision, split out of
/// [`mint`] so every branch is testable without a live HTTP round trip — which is why the 5xx
/// branch below shipped untested. Pure: it touches neither the network nor the keychain.
fn classify_token_refusal(status: reqwest::StatusCode, body: &str) -> Result<Access> {
    // 403 is the plan refusal and 402 the empty wallet. Both are product states with a next action,
    // so they are carried to the panel rather than raised as failures.
    if status == reqwest::StatusCode::FORBIDDEN || status == reqwest::StatusCode::PAYMENT_REQUIRED {
        let parsed: Option<RefusalBody> = serde_json::from_str(body).ok();
        let reason = parsed.as_ref().and_then(|b| b.reason.clone());
        let code = match reason.as_deref() {
            Some("insufficient_credit") => RefusalCode::InsufficientCredit,
            _ if status == reqwest::StatusCode::PAYMENT_REQUIRED => RefusalCode::InsufficientCredit,
            _ => RefusalCode::PlanRequired,
        };
        return Ok(Access::Denied(Refusal {
            code,
            message: parsed
                .as_ref()
                .and_then(|b| b.error.as_ref())
                .and_then(|e| e.message.clone())
                .unwrap_or_else(|| {
                    "Lobee is included with Plus, Pro and Max. Upgrade to Plus to run it."
                        .to_string()
                }),
            tier: parsed.and_then(|b| b.current_tier),
        }));
    }
    if status == reqwest::StatusCode::UNAUTHORIZED {
        return Ok(Access::Denied(Refusal {
            code: RefusalCode::SignedOut,
            message: "Sign in to the Lobster app to use Lobee.".to_string(),
            tier: None,
        }));
    }
    // A 5xx is the SERVER failing, not a decision about this account. Falling through to Err here
    // made the panel show "Lobee is not connected yet … this usually clears within a moment of
    // signing in", which points the user at their own sign-in for a fault they cannot affect and
    // sends them looking in entirely the wrong place. Observed against production returning 500
    // from POST /agent/token while the account was signed in perfectly well.
    if status.is_server_error() {
        return Ok(Access::Denied(Refusal {
            code: RefusalCode::ProviderUnavailable,
            message: format!(
                "The Lobster service could not authorise Lobee (HTTP {}). This is on our side — \
                 your account and Credit are untouched.",
                status.as_u16()
            ),
            tier: None,
        }));
    }
    Err(anyhow!(
        "could not authorise Lobee (HTTP {})",
        status.as_u16()
    ))
}

/// The credential to use now: the cached one while it is comfortably valid, otherwise a fresh mint.
///
/// `force` re-mints even when the cache looks good — what the sidecar's refresh request asks for,
/// since the sidecar only asks after the proxy rejected what it had.
pub async fn access(force: bool) -> Result<Access> {
    if let Some(credential) = env_credential() {
        return Ok(Access::Granted(credential));
    }
    if !force {
        if let Ok(cache) = CACHE.lock() {
            if let Some(cached) = cache.as_ref() {
                if cached.expires_at > now_secs() + RENEW_BEFORE_EXPIRY_SECS {
                    return Ok(Access::Granted(cached.clone()));
                }
            }
        }
    }
    if cloud_auth::load_token().is_none() {
        if let Ok(mut cache) = CACHE.lock() {
            *cache = None;
        }
        return Ok(Access::Denied(Refusal {
            code: RefusalCode::SignedOut,
            message: "Sign in to the Lobster app to use Lobee.".to_string(),
            tier: None,
        }));
    }
    let result = mint().await?;
    if let Ok(mut cache) = CACHE.lock() {
        *cache = match &result {
            Access::Granted(credential) => Some(credential.clone()),
            Access::Denied(_) => None,
        };
    }
    Ok(result)
}

/// Drop the cached token (sign-out). The next run mints under whoever signs in next.
pub fn forget() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

/// The `agent.setCredential` payload for the sidecar.
pub fn sidecar_params(access: &Access) -> serde_json::Value {
    match access {
        Access::Granted(credential) => serde_json::json!({
            "baseUrl": credential.base_url,
            "token": credential.token,
            "expiresInSeconds": credential.expires_in_seconds,
            "tier": credential.tier,
        }),
        Access::Denied(refusal) => serde_json::json!({
            "refusal": refusal.code.as_str(),
            "message": refusal.message,
            "tier": refusal.tier,
        }),
    }
}

/// Mint (or reuse) a credential and push it to the sidecar, so panel-started runs can authenticate.
///
/// Failures are logged, never fatal: a launcher that refused to start because a billing endpoint was
/// slow would be a worse product than one that starts and reports the agent as unavailable.
pub async fn push(sidecar: &crate::sidecar::SidecarClient, force: bool) {
    let access = match access(force).await {
        Ok(access) => access,
        Err(err) => {
            tracing::warn!(error = %format!("{err:#}"), "managed agent credential unavailable");
            return;
        }
    };
    if let Err(err) = sidecar
        .call("agent.setCredential", sidecar_params(&access))
        .await
    {
        tracing::warn!(%err, "could not hand the managed agent credential to the sidecar");
    }
}

/// Tell the sidecar there is no credential at all (sign-out), so a stale token cannot outlive it.
pub async fn clear(sidecar: &crate::sidecar::SidecarClient) {
    forget();
    if let Err(err) = sidecar
        .call("agent.setCredential", serde_json::json!({ "clear": true }))
        .await
    {
        tracing::warn!(%err, "could not clear the managed agent credential in the sidecar");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Both resolutions in ONE test: cargo runs tests in threads of a single process, so two tests
    /// mutating the same variables would race each other rather than assert anything.
    ///
    /// The proxy must follow the API origin the app already authenticates against — resolving them
    /// independently is how a launcher ends up signed in to one deployment and spending on another.
    /// The explicit override stays for CI and local backends, where no session exists to mint from.
    #[test]
    fn the_proxy_base_follows_the_api_origin_unless_explicitly_overridden() {
        std::env::remove_var("LOBSTER_AGENT_PROXY_URL");
        std::env::set_var("LOBSTER_API_ORIGIN", "https://api.staging.example");
        assert_eq!(base_url(), "https://api.staging.example/agent/llm");

        // A trailing slash in the override must not produce a doubled separator.
        std::env::set_var(
            "LOBSTER_AGENT_PROXY_URL",
            "http://127.0.0.1:3000/agent/llm/",
        );
        assert_eq!(base_url(), "http://127.0.0.1:3000/agent/llm");

        std::env::remove_var("LOBSTER_AGENT_PROXY_URL");
        std::env::remove_var("LOBSTER_API_ORIGIN");
    }

    /// A refusal must reach the sidecar as a state the panel can render, not as a missing token.
    #[test]
    fn a_refusal_is_pushed_as_its_reason_and_tier() {
        let params = sidecar_params(&Access::Denied(Refusal {
            code: RefusalCode::PlanRequired,
            message: "Lobee is included with Plus, Pro and Max.".to_string(),
            tier: Some("light".to_string()),
        }));
        assert_eq!(params["refusal"], "plan_required");
        assert_eq!(params["tier"], "light");
        assert!(params.get("token").is_none(), "a refusal carries no token");
    }

    fn denied(status: u16, body: &str) -> Refusal {
        match classify_token_refusal(reqwest::StatusCode::from_u16(status).unwrap(), body)
            .expect("a refusal must be Ok(Denied), never Err")
        {
            Access::Denied(r) => r,
            Access::Granted(_) => panic!("a non-2xx status must not grant access"),
        }
    }

    /// The whole point of extracting `classify_token_refusal`: a 5xx is the SERVER failing, and it
    /// must reach the panel as `provider_unavailable` ("this is on our side"), NOT as `signed_out`
    /// (which sends the user to re-authenticate for a fault they cannot affect) and NOT as an `Err`
    /// (which the panel renders as the generic "not connected yet"). This branch shipped untested
    /// and produced exactly that misdirection against a production 500.
    #[test]
    fn a_server_error_is_an_outage_on_our_side_not_a_sign_in_problem() {
        for status in [500u16, 502, 503, 504] {
            let r = denied(status, "");
            assert_eq!(
                r.code,
                RefusalCode::ProviderUnavailable,
                "HTTP {status} must map to provider_unavailable"
            );
            assert_eq!(r.code.as_str(), "provider_unavailable");
            assert!(r.tier.is_none());
            assert!(
                r.message.contains("on our side"),
                "the panel copy must not blame the user: {:?}",
                r.message
            );
        }
    }

    /// The account-state branches this shares a function with must keep their existing mapping,
    /// so the extraction cannot have silently changed them.
    #[test]
    fn the_account_state_branches_are_unchanged_by_the_extraction() {
        assert_eq!(denied(401, "").code, RefusalCode::SignedOut);
        assert_eq!(denied(402, "").code, RefusalCode::InsufficientCredit);
        assert_eq!(denied(403, "").code, RefusalCode::PlanRequired);
        // A 403 whose body names the empty wallet is the credit refusal, not the plan refusal.
        assert_eq!(
            denied(403, r#"{"reason":"insufficient_credit"}"#).code,
            RefusalCode::InsufficientCredit,
        );
    }

    /// A status this function has no rule for is a genuine failure, not a silent Denied — it must
    /// stay an `Err` so it is logged rather than rendered as a calm panel state.
    #[test]
    fn an_unclassified_status_stays_an_error() {
        assert!(classify_token_refusal(reqwest::StatusCode::IM_A_TEAPOT, "").is_err());
    }
}
