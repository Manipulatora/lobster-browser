//! Account-derived key material: turning a password into the key a snapshot is sealed under.
//!
//! ## Why this exists
//!
//! The snapshot ledger seals artifacts under the per-install Local Store Key, which is regenerated on
//! every install. That is correct for a purely local backup and useless for a cloud one: a snapshot
//! uploaded from one machine could not be opened on another, so sync would be a backup nobody can
//! restore. This module derives the key from the ACCOUNT instead, so the same key is reachable
//! anywhere the user can sign in and supply their password.
//!
//! ## The hierarchy, and who holds what
//!
//! ```text
//!   password ──Argon2id(salt, cost)──▶ wrapping key ──unwrap──▶ Team Data Key
//!   recovery code ──Argon2id(salt', cost)──▶ wrapping key' ──unwrap──▶ (the same TDK)
//!                                                                │
//!                                                  HKDF(TDK, profileId)
//!                                                                ▼
//!                                                   Profile Content Key ──▶ LBv1 seal
//! ```
//!
//! The server stores only the two wraps and the salts. It never sees the password, the recovery code,
//! the Team Data Key, or any key derived from it — a property of what the API exposes, not a promise.
//!
//! ## Nothing is persisted here
//!
//! The unwrapped Team Data Key lives in memory for the lifetime of the unlock and is zeroized on
//! drop. Writing it to disk would recreate exactly the problem this module solves — a key sitting on
//! one machine — and would hand an attacker with the disk everything the password protects.

use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::Deserialize;
use std::time::Duration;
use zeroize::{Zeroize, Zeroizing};

use crate::blob_crypto::{self, LB_V1_KEY_LEN};
use crate::cloud_auth;

/// Wraps are `LKw1 | nonce(12) | ct(32) + tag(16)`.
const WRAP_LEN: usize = 4 + 12 + 32 + 16;

/// Argon2id output length. Matches `@lobster/crypto` ARGON2ID_HASH_LEN.
const ARGON_HASH_LEN: usize = 32;

/// A network call that must not hang the UI behind it.
const HTTP_TIMEOUT: Duration = Duration::from_secs(20);

/// The Argon2id cost an enrollment was created with.
///
/// Carried per enrollment rather than assumed, because parameters get raised over time and an unlock
/// MUST use the cost its own wrap was made with — a global constant would strand every user enrolled
/// before the change.
#[derive(Debug, Clone, Copy, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArgonCost {
    pub memory_ki_b: u32,
    pub iterations: u32,
    pub parallelism: u32,
}

/// The enrollment as the server returns it: opaque blobs plus the cost to reproduce the key.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VaultEnrollment {
    pub password_salt: String,
    pub recovery_salt: String,
    pub wrapped_by_password: String,
    pub wrapped_by_recovery: String,
    pub key_fingerprint: String,
    pub argon: ArgonCost,
}

/// Which secret is being used to open the vault.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum UnlockWith {
    Password,
    /// The printed code. The caller should report the use so support can see it left its paper copy.
    RecoveryCode,
}

/// An unlocked Team Data Key. Zeroized on drop.
pub struct UnlockedVault {
    team_data_key: Zeroizing<[u8; LB_V1_KEY_LEN]>,
    fingerprint: String,
}

impl UnlockedVault {
    /// The key a profile's artifacts are sealed under. Derived per profile, never reused across them,
    /// so compromising one profile's key does not expose another's.
    pub fn profile_content_key(&self, profile_id: &str) -> Result<[u8; LB_V1_KEY_LEN]> {
        blob_crypto::derive_profile_content_key(&self.team_data_key, profile_id)
    }

    /// Non-secret identifier of the unlocked key, for telling "wrong password" apart from "this is a
    /// different vault than my snapshots were sealed under".
    pub fn fingerprint(&self) -> &str {
        &self.fingerprint
    }
}

impl std::fmt::Debug for UnlockedVault {
    /// Deliberately opaque: an accidental `{:?}` on a struct holding this must not print key bytes.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("UnlockedVault")
            .field("fingerprint", &self.fingerprint)
            .field("team_data_key", &"<redacted>")
            .finish()
    }
}

/// Fetch the caller's enrollment. `Ok(None)` means they have never enrolled.
pub async fn fetch_enrollment() -> Result<Option<VaultEnrollment>> {
    let token = cloud_auth::load_token().ok_or_else(|| anyhow!("not signed in"))?;
    let client = reqwest::Client::builder().timeout(HTTP_TIMEOUT).build()?;
    let res = client
        .get(format!("{}/vault", cloud_auth::api_origin()))
        .bearer_auth(&token)
        .send()
        .await
        .context("fetching vault key material")?;

    if !res.status().is_success() {
        bail!("vault fetch failed: HTTP {}", res.status());
    }

    #[derive(Deserialize)]
    struct Envelope {
        code: i32,
        data: Option<VaultEnrollment>,
        msg: Option<String>,
    }
    let body: Envelope = res.json().await.context("parsing the vault response")?;
    if body.code != 0 {
        bail!(
            "vault fetch refused: {}",
            body.msg.unwrap_or_else(|| "unknown error".to_string())
        );
    }
    Ok(body.data)
}

/// Derive the wrapping key and unwrap the Team Data Key.
///
/// Fails closed on a wrong secret: AES-256-GCM's tag makes a wrong wrapping key a decryption failure,
/// never a plausible-looking wrong key that would seal snapshots nothing can open.
pub fn unlock(
    enrollment: &VaultEnrollment,
    secret: &str,
    using: UnlockWith,
) -> Result<UnlockedVault> {
    if secret.is_empty() {
        bail!("no {} supplied", label(using));
    }
    let (salt_b64, wrap_b64) = match using {
        UnlockWith::Password => (&enrollment.password_salt, &enrollment.wrapped_by_password),
        UnlockWith::RecoveryCode => (&enrollment.recovery_salt, &enrollment.wrapped_by_recovery),
    };

    let salt = decode_b64(salt_b64, "salt")?;
    let wrap = decode_b64(wrap_b64, "wrap")?;
    if wrap.len() != WRAP_LEN {
        bail!("wrapped key is {} bytes, expected {WRAP_LEN}", wrap.len());
    }

    // The recovery code is normalised the same way the issuing side does, so a code typed off paper
    // in lowercase with spaces still derives the right key. A password is used exactly as given.
    let material = match using {
        UnlockWith::Password => secret.to_string(),
        UnlockWith::RecoveryCode => normalize_recovery_code(secret)?,
    };

    let mut wrapping_key = derive_wrapping_key(&material, &salt, enrollment.argon)?;
    let unwrapped = blob_crypto::unwrap_key(&wrap, &wrapping_key);
    wrapping_key.zeroize();

    let team_data_key = unwrapped.map_err(|_| {
        anyhow!(
            "that {} did not open the vault (wrong secret, or key material from another account)",
            label(using)
        )
    })?;

    Ok(UnlockedVault {
        team_data_key: Zeroizing::new(team_data_key),
        fingerprint: enrollment.key_fingerprint.clone(),
    })
}

fn label(using: UnlockWith) -> &'static str {
    match using {
        UnlockWith::Password => "password",
        UnlockWith::RecoveryCode => "recovery code",
    }
}

/// Argon2id, with the cost the enrollment was created under.
fn derive_wrapping_key(
    material: &str,
    salt: &[u8],
    cost: ArgonCost,
) -> Result<[u8; LB_V1_KEY_LEN]> {
    // Refused rather than accepted-and-slow: a trivial cost means the wrap it produced is cheap to
    // attack offline, and a client that silently honoured one would defeat the server's own floor.
    if cost.memory_ki_b < 8 * 1024 || cost.iterations < 2 || cost.parallelism < 1 {
        bail!(
            "enrollment declares an Argon2id cost below the accepted minimum \
             (m={}KiB t={} p={})",
            cost.memory_ki_b,
            cost.iterations,
            cost.parallelism
        );
    }
    let params = Params::new(
        cost.memory_ki_b,
        cost.iterations,
        cost.parallelism,
        Some(ARGON_HASH_LEN),
    )
    .map_err(|e| anyhow!("invalid Argon2id parameters: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut out = [0u8; LB_V1_KEY_LEN];
    argon
        .hash_password_into(material.as_bytes(), salt, &mut out)
        .map_err(|e| anyhow!("Argon2id derivation failed: {e}"))?;
    Ok(out)
}

/// Fold a typed recovery code to its canonical symbols. Mirrors `normalizeRecoveryCode` in
/// `@lobster/crypto` — including that `U` is REFUSED rather than folded, since it is excluded from the
/// alphabet precisely so it cannot be read as `V`.
fn normalize_recovery_code(code: &str) -> Result<String> {
    const ALPHABET: &str = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
    const EXPECTED: usize = 30;

    let folded: String = code
        .to_uppercase()
        .chars()
        .filter(|c| !c.is_whitespace() && *c != '-')
        .map(|c| match c {
            'I' | 'L' => '1',
            'O' => '0',
            other => other,
        })
        .collect();

    if folded.chars().count() != EXPECTED {
        bail!(
            "recovery code must be {EXPECTED} symbols (got {} after normalising)",
            folded.chars().count()
        );
    }
    if let Some(bad) = folded.chars().find(|c| !ALPHABET.contains(*c)) {
        bail!("recovery code contains '{bad}', which is not in the alphabet");
    }
    Ok(folded)
}

fn decode_b64(value: &str, what: &str) -> Result<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .with_context(|| format!("{what} is not valid base64"))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Cost floor for tests: above the accepted minimum, fast enough to run in a suite.
    const CHEAP: ArgonCost = ArgonCost {
        memory_ki_b: 8 * 1024,
        iterations: 2,
        parallelism: 1,
    };

    fn enrollment_for(password: &str, code: &str, tdk: &[u8; LB_V1_KEY_LEN]) -> VaultEnrollment {
        use base64::Engine as _;
        let b64 = base64::engine::general_purpose::STANDARD;
        let password_salt = [1u8; 16];
        let recovery_salt = [2u8; 16];
        let pk = derive_wrapping_key(password, &password_salt, CHEAP).unwrap();
        let rk = derive_wrapping_key(
            &normalize_recovery_code(code).unwrap(),
            &recovery_salt,
            CHEAP,
        )
        .unwrap();
        VaultEnrollment {
            password_salt: b64.encode(password_salt),
            recovery_salt: b64.encode(recovery_salt),
            wrapped_by_password: b64.encode(blob_crypto::wrap_key(tdk, &pk).unwrap()),
            wrapped_by_recovery: b64.encode(blob_crypto::wrap_key(tdk, &rk).unwrap()),
            key_fingerprint: "abcdef0123456789".to_string(),
            argon: CHEAP,
        }
    }

    #[test]
    fn either_secret_opens_the_same_key_and_a_wrong_one_fails_closed() {
        let tdk = [7u8; LB_V1_KEY_LEN];
        let code = "ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789";
        let enrollment = enrollment_for("correct horse", code, &tdk);

        let by_password = unlock(&enrollment, "correct horse", UnlockWith::Password).unwrap();
        let by_code = unlock(&enrollment, code, UnlockWith::RecoveryCode).unwrap();

        // Both paths must reach the SAME key, or one of them is a recovery route that recovers
        // nothing. Compared through a derived PCK so the raw key is never copied out.
        assert_eq!(
            by_password.profile_content_key("prf_1").unwrap(),
            by_code.profile_content_key("prf_1").unwrap()
        );
        // ...and the key is genuinely per-profile.
        assert_ne!(
            by_password.profile_content_key("prf_1").unwrap(),
            by_password.profile_content_key("prf_2").unwrap()
        );

        let wrong = unlock(&enrollment, "not the password", UnlockWith::Password);
        assert!(wrong.is_err(), "a wrong password must not yield a key");
        assert!(format!("{:#}", wrong.unwrap_err()).contains("did not open the vault"));
    }

    #[test]
    fn a_code_typed_off_paper_still_opens_it() {
        let tdk = [9u8; LB_V1_KEY_LEN];
        let code = "ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789";
        let enrollment = enrollment_for("pw", code, &tdk);
        let canonical = unlock(&enrollment, code, UnlockWith::RecoveryCode).unwrap();

        // Lowercase, spaces for dashes: how someone actually types it back.
        for typed in [
            "abcde fghjk mnpqr stvwx yz234 56789",
            "abcdefghjkmnpqrstvwxyz23456789",
            "  ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789  ",
        ] {
            let opened = unlock(&enrollment, typed, UnlockWith::RecoveryCode)
                .unwrap_or_else(|e| panic!("{typed:?} should open the vault: {e:#}"));
            assert_eq!(
                opened.profile_content_key("prf_1").unwrap(),
                canonical.profile_content_key("prf_1").unwrap()
            );
        }
    }

    #[test]
    fn the_ambiguous_symbols_fold_the_way_the_issuer_folds_them() {
        // I/L read as 1 and O as 0 — the slips Crockford is designed to absorb.
        assert_eq!(
            normalize_recovery_code("IIIII-LLLLL-OOOOO-00000-11111-22222").unwrap(),
            "111111111100000000001111122222"
        );
        // U is excluded so it cannot be confused with V; folding it would accept a code never issued.
        assert!(normalize_recovery_code("UUUUU-UUUUU-UUUUU-UUUUU-UUUUU-UUUUU").is_err());
        assert!(normalize_recovery_code("TOO-SHORT").is_err());
    }

    #[test]
    fn an_enrollment_declaring_a_trivial_cost_is_refused() {
        // The server enforces a floor; a client that honoured a weak cost anyway would undo it, and
        // the resulting wrap would be cheap to attack offline.
        let weak = ArgonCost {
            memory_ki_b: 64,
            iterations: 1,
            parallelism: 1,
        };
        let err = derive_wrapping_key("pw", &[0u8; 16], weak).unwrap_err();
        assert!(format!("{err:#}").contains("below the accepted minimum"));
    }

    /// THE CROSS-MACHINE PATH: an enrollment made by the TypeScript side, opened here.
    ///
    /// The web enrolls a user; the desktop has to reach the same Team Data Key from the password or
    /// the printed code, or every uploaded snapshot is unopenable on the machine that needs it. The
    /// two sides run different Argon2id implementations (`@noble/hashes` and the `argon2` crate) and
    /// different AES-GCM libraries, so this agreeing is a real claim about two stacks, not one.
    #[test]
    fn an_enrollment_made_by_typescript_unlocks_here() {
        let raw = include_str!("../../../../packages/crypto/fixtures/vault-unlock-interop.json");
        let fixture: serde_json::Value = serde_json::from_str(raw).expect("fixture parses");

        let enrollment = VaultEnrollment {
            password_salt: fixture["passwordSalt"].as_str().unwrap().to_string(),
            recovery_salt: fixture["recoverySalt"].as_str().unwrap().to_string(),
            wrapped_by_password: fixture["wrappedByPassword"].as_str().unwrap().to_string(),
            wrapped_by_recovery: fixture["wrappedByRecovery"].as_str().unwrap().to_string(),
            key_fingerprint: "interop".to_string(),
            argon: CHEAP,
        };

        let expected_pck = fixture["pckForProfile1"].as_str().unwrap();
        for (secret, using) in [
            ("interop-password", UnlockWith::Password),
            (
                "ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789",
                UnlockWith::RecoveryCode,
            ),
            // ...and the way it is actually typed off a printout.
            (
                "abcde fghjk mnpqr stvwx yz234 56789",
                UnlockWith::RecoveryCode,
            ),
        ] {
            let vault = unlock(&enrollment, secret, using)
                .unwrap_or_else(|e| panic!("{using:?} unlock failed: {e:#}"));
            let pck = vault.profile_content_key("prf_1").unwrap();
            let hex: String = pck.iter().map(|b| format!("{b:02x}")).collect();
            assert_eq!(
                hex, expected_pck,
                "the desktop derived a different content key than TypeScript did ({using:?})"
            );
        }
    }

    #[test]
    fn the_unlocked_key_never_appears_in_debug_output() {
        let tdk = [0xAB; LB_V1_KEY_LEN];
        let enrollment = enrollment_for("pw", "ABCDE-FGHJK-MNPQR-STVWX-YZ234-56789", &tdk);
        let vault = unlock(&enrollment, "pw", UnlockWith::Password).unwrap();
        let printed = format!("{vault:?}");
        assert!(printed.contains("<redacted>"));
        assert!(!printed.contains("ab, ab") && !printed.contains("171"));
    }
}
