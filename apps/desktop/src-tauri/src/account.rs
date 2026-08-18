//! The account facts the shell displays: Credit balance, plan, and the profile allowance.
//!
//! One call to `/billing/overview`, reshaped to the three things the UI actually renders. The server
//! returns considerably more (the deposit rails, the plan catalogue, whether deposits are available),
//! and forwarding all of it would make the topbar's data contract change every time billing does.
//!
//! FAILURES ARE NOT FATAL. A launcher whose profile list refuses to load because a billing endpoint
//! was slow would be a worse product than one that shows the list and omits a balance, so every
//! caller treats this as optional detail.

use anyhow::{anyhow, bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::time::Duration;

use crate::cloud_auth;

/// Short, because this is decoration on a screen the user wants NOW. The list renders without it.
const HTTP_TIMEOUT: Duration = Duration::from_secs(8);

/// What the shell shows: the balance, the plan, and how much of the profile allowance is used.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountSummary {
    /// Credit balance in USD cents. The UI renders this as Credit, never with a currency symbol.
    pub balance_cents: i64,
    /// `free` | `light` | `plus` | `pro` | `max`.
    pub tier: String,
    /// Profiles this plan allows. The cap the server actually enforces on create.
    pub profile_limit: i64,
}

#[derive(Deserialize)]
struct Subscription {
    tier: Option<String>,
    status: Option<String>,
    #[serde(rename = "profileLimit")]
    profile_limit: Option<i64>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Overview {
    balance_cents: Option<i64>,
    subscription: Option<Subscription>,
    free_plan_profile_limit: Option<i64>,
}

/// Fetch the summary for the signed-in account.
pub async fn fetch() -> Result<AccountSummary> {
    let token = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
    let res = client
        .get(format!("{}/billing/overview", cloud_auth::api_origin()))
        .bearer_auth(&token)
        .send()
        .await
        .context("fetching the account summary")?;

    if !res.status().is_success() {
        bail!("account summary failed: HTTP {}", res.status());
    }

    #[derive(Deserialize)]
    struct Envelope {
        code: i32,
        data: Option<Overview>,
        msg: Option<String>,
    }
    let body: Envelope = res.json().await.context("parsing the account summary")?;
    if body.code != 0 {
        bail!(
            "account summary refused: {}",
            body.msg.unwrap_or_else(|| "unknown error".to_string())
        );
    }
    let overview = body
        .data
        .ok_or_else(|| anyhow!("the account summary response carried no data"))?;

    Ok(summarize(overview))
}

/// Reduce the overview to what the shell renders.
///
/// A LAPSED SUBSCRIPTION IS NOT A PLAN. `past_due` or `canceled` means the paid allowance is not
/// being honoured, so the UI must show the free tier and its smaller cap — showing "Pro · 12/200"
/// to someone whose payment failed invites them to create profiles the server will refuse.
fn summarize(overview: Overview) -> AccountSummary {
    let active = overview
        .subscription
        .as_ref()
        .filter(|s| s.status.as_deref() == Some("active"));

    AccountSummary {
        balance_cents: overview.balance_cents.unwrap_or(0),
        tier: active
            .and_then(|s| s.tier.clone())
            .unwrap_or_else(|| "free".to_string()),
        profile_limit: active
            .and_then(|s| s.profile_limit)
            // Falls back to the server's own free allowance rather than a constant here: duplicating
            // the number is how the sign-up screen ended up promising five profiles when the server
            // had already moved to three.
            .or(overview.free_plan_profile_limit)
            .unwrap_or(0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn overview(tier: &str, status: &str, limit: i64) -> Overview {
        Overview {
            balance_cents: Some(12_34),
            subscription: Some(Subscription {
                tier: Some(tier.to_string()),
                status: Some(status.to_string()),
                profile_limit: Some(limit),
            }),
            free_plan_profile_limit: Some(3),
        }
    }

    #[test]
    fn an_active_subscription_supplies_the_plan_and_cap() {
        let s = summarize(overview("pro", "active", 200));
        assert_eq!(s.tier, "pro");
        assert_eq!(s.profile_limit, 200);
        assert_eq!(s.balance_cents, 1234);
    }

    #[test]
    fn a_lapsed_subscription_shows_the_free_allowance_it_is_actually_getting() {
        // Showing "Pro / 200" to someone whose payment failed invites them to create profiles the
        // server will refuse.
        for status in ["past_due", "canceled", "trialing"] {
            let s = summarize(overview("pro", status, 200));
            assert_eq!(s.tier, "free", "{status} must not read as a paid plan");
            assert_eq!(s.profile_limit, 3, "{status} gets the free cap");
        }
    }

    #[test]
    fn no_subscription_falls_back_to_the_servers_own_free_limit() {
        let s = summarize(Overview {
            balance_cents: None,
            subscription: None,
            free_plan_profile_limit: Some(3),
        });
        assert_eq!(s.tier, "free");
        assert_eq!(s.profile_limit, 3);
        assert_eq!(
            s.balance_cents, 0,
            "a missing balance is zero, not an error"
        );
    }
}
