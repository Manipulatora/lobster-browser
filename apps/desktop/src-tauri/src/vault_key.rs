//! The key this account's snapshots are scrambled with.
//!
//! A snapshot uploaded from one machine has to be readable on another, so it cannot be sealed with
//! anything that only exists on the machine that made it. The account's key is fetched from the
//! server after sign-in and used to derive a separate key per profile, so one profile's key does not
//! open another's.
//!
//! ```text
//!   sign in ──▶ GET /vault/key ──▶ account key ──HKDF(key, profileId)──▶ per-profile key ──▶ seal
//! ```
//!
//! THE SERVER HOLDS THE KEY. Deriving it from the account password instead would mean the server
//! could not read profile data — but it would also mean a forgotten password destroys every profile
//! permanently, with nothing support could do. Signing in is all a user needs, and a password reset
//! costs them nothing.
//!
//! It is held in memory only. Persisting it would put a copy on this machine's disk for no benefit:
//! it is re-fetchable from the server at any time by anyone who can sign in.

use anyhow::{anyhow, bail, Context, Result};
use base64::Engine as _;
use serde::Deserialize;
use std::time::Duration;
use zeroize::Zeroizing;

use crate::blob_crypto::{self, LB_V1_KEY_LEN};
use crate::cloud_auth;

/// A network call that must not hang the UI behind it.
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// The account key, held for this session. Zeroized on drop.
pub struct AccountKey {
    key: Zeroizing<[u8; LB_V1_KEY_LEN]>,
}

impl AccountKey {
    /// The key a profile's snapshot is sealed under. Derived per profile, so compromising one
    /// profile's key does not expose another's.
    pub fn profile_content_key(&self, profile_id: &str) -> Result<[u8; LB_V1_KEY_LEN]> {
        blob_crypto::derive_profile_content_key(&self.key, profile_id)
    }
}

impl std::fmt::Debug for AccountKey {
    /// Deliberately opaque: an accidental `{:?}` on a struct holding this must not print key bytes.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("AccountKey")
            .field("key", &"<redacted>")
            .finish()
    }
}

/// Fetch the account key, which the server creates on first use.
pub async fn fetch() -> Result<AccountKey> {
    let token = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
    let res = client
        .get(format!("{}/vault/key", cloud_auth::api_origin()))
        .bearer_auth(&token)
        .send()
        .await
        .context("fetching the account key")?;

    if !res.status().is_success() {
        bail!("could not fetch the account key: HTTP {}", res.status());
    }

    #[derive(Deserialize)]
    struct Data {
        #[serde(rename = "dataKey")]
        data_key: String,
    }
    #[derive(Deserialize)]
    struct Envelope {
        code: i32,
        data: Option<Data>,
        msg: Option<String>,
    }

    let body: Envelope = res
        .json()
        .await
        .context("parsing the account-key response")?;
    if body.code != 0 {
        bail!(
            "account key refused: {}",
            body.msg.unwrap_or_else(|| "unknown error".to_string())
        );
    }
    let encoded = body
        .data
        .ok_or_else(|| anyhow!("the account-key response carried no key"))?
        .data_key;

    let raw = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("the account key is not valid base64")?;
    let key: [u8; LB_V1_KEY_LEN] = raw.as_slice().try_into().map_err(|_| {
        anyhow!(
            "the account key is {} bytes, expected {LB_V1_KEY_LEN}",
            raw.len()
        )
    })?;

    Ok(AccountKey {
        key: Zeroizing::new(key),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_are_per_profile_and_stable() {
        let account = AccountKey {
            key: Zeroizing::new([7u8; LB_V1_KEY_LEN]),
        };
        // Stable, or a snapshot sealed today would not open tomorrow.
        assert_eq!(
            account.profile_content_key("prf_1").unwrap(),
            account.profile_content_key("prf_1").unwrap()
        );
        // ...and distinct per profile, so one profile's key does not open another's.
        assert_ne!(
            account.profile_content_key("prf_1").unwrap(),
            account.profile_content_key("prf_2").unwrap()
        );
    }

    #[test]
    fn a_different_account_derives_different_profile_keys() {
        let mine = AccountKey {
            key: Zeroizing::new([1u8; LB_V1_KEY_LEN]),
        };
        let theirs = AccountKey {
            key: Zeroizing::new([2u8; LB_V1_KEY_LEN]),
        };
        assert_ne!(
            mine.profile_content_key("prf_1").unwrap(),
            theirs.profile_content_key("prf_1").unwrap()
        );
    }

    #[test]
    fn the_key_never_appears_in_debug_output() {
        let account = AccountKey {
            key: Zeroizing::new([0xAB; LB_V1_KEY_LEN]),
        };
        assert!(format!("{account:?}").contains("<redacted>"));
    }
}
