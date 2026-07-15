//! Client-side profile-blob encryption (SEC-1) — LBv1 envelope + SEC-2 HKDF PCK helpers.
//!
//! Normative wire format from `docs/OPERATIONS.md` §1.3:
//!
//! ```text
//! magic="LBv1" (4B) | key_id (16B) | alg (1B: 0x01=A256GCM) | nonce (12B) | ciphertext (…) | tag (16B)
//! ```
//!
//! Mirrors `@lobster/crypto`. Callers may supply a raw PCK or derive one from a Team Data Key
//! via {@link derive_profile_content_key}.
#![allow(dead_code)]

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, bail, Result};
use hkdf::Hkdf;
use sha2::Sha256;

/// ASCII magic `LBv1`.
pub const LB_V1_MAGIC: &[u8; 4] = b"LBv1";
/// AES-256-GCM algorithm id in the envelope header.
pub const LB_V1_ALG_A256GCM: u8 = 0x01;
pub const LB_V1_KEY_LEN: usize = 32;
pub const LB_V1_KEY_ID_LEN: usize = 16;
pub const LB_V1_NONCE_LEN: usize = 12;
pub const LB_V1_TAG_LEN: usize = 16;
pub const LB_V1_HEADER_LEN: usize = 4 + LB_V1_KEY_ID_LEN + 1 + LB_V1_NONCE_LEN;

/// AES-256-GCM cipher over a Profile Content Key (PCK).
pub struct BlobCipher {
    cipher: Aes256Gcm,
}

impl BlobCipher {
    /// Build from a raw 32-byte PCK.
    pub fn new(key: &[u8; LB_V1_KEY_LEN]) -> Self {
        Self {
            cipher: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)),
        }
    }

    /// Generate a fresh random PCK.
    pub fn generate_key() -> [u8; LB_V1_KEY_LEN] {
        let mut key = [0u8; LB_V1_KEY_LEN];
        OsRng.fill_bytes(&mut key);
        key
    }

    /// Generate a fresh random 16-byte key id.
    pub fn generate_key_id() -> [u8; LB_V1_KEY_ID_LEN] {
        let mut key_id = [0u8; LB_V1_KEY_ID_LEN];
        OsRng.fill_bytes(&mut key_id);
        key_id
    }

    /// True when `bytes` starts with the LBv1 magic.
    pub fn is_lbv1(bytes: &[u8]) -> bool {
        bytes.len() >= LB_V1_MAGIC.len() && &bytes[..LB_V1_MAGIC.len()] == LB_V1_MAGIC
    }

    /// Encrypt `plaintext` into an LBv1 envelope. `key_id` identifies which PCK version decrypts
    /// it (pass zeros for single-key installs). A fresh random nonce is used per call.
    pub fn encrypt(&self, plaintext: &[u8], key_id: &[u8; LB_V1_KEY_ID_LEN]) -> Result<Vec<u8>> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let sealed = self
            .cipher
            .encrypt(&nonce, plaintext)
            .map_err(|e| anyhow!("AES-GCM encrypt failed: {e}"))?;
        // aes-gcm crate appends the 16-byte tag to the ciphertext.
        let mut envelope =
            Vec::with_capacity(LB_V1_HEADER_LEN + sealed.len());
        envelope.extend_from_slice(LB_V1_MAGIC);
        envelope.extend_from_slice(key_id);
        envelope.push(LB_V1_ALG_A256GCM);
        envelope.extend_from_slice(nonce.as_slice());
        envelope.extend_from_slice(&sealed);
        Ok(envelope)
    }

    /// Decrypt an LBv1 envelope. Returns `(plaintext, key_id)`.
    pub fn decrypt(&self, envelope: &[u8]) -> Result<(Vec<u8>, [u8; LB_V1_KEY_ID_LEN])> {
        if envelope.len() < LB_V1_HEADER_LEN + LB_V1_TAG_LEN {
            bail!("envelope too short for LBv1 header + tag");
        }
        if !Self::is_lbv1(envelope) {
            bail!("envelope magic is not LBv1");
        }
        let mut offset = LB_V1_MAGIC.len();
        let mut key_id = [0u8; LB_V1_KEY_ID_LEN];
        key_id.copy_from_slice(&envelope[offset..offset + LB_V1_KEY_ID_LEN]);
        offset += LB_V1_KEY_ID_LEN;
        let alg = envelope[offset];
        offset += 1;
        if alg != LB_V1_ALG_A256GCM {
            bail!("unsupported LBv1 alg id 0x{alg:02x}");
        }
        let nonce = Nonce::from_slice(&envelope[offset..offset + LB_V1_NONCE_LEN]);
        offset += LB_V1_NONCE_LEN;
        let sealed = &envelope[offset..];
        let plaintext = self
            .cipher
            .decrypt(nonce, sealed)
            .map_err(|_| anyhow!("AES-GCM authentication failed (wrong key or tampered envelope)"))?;
        Ok((plaintext, key_id))
    }
}

/// HKDF info label — must match `@lobster/crypto` `HKDF_INFO_PCK`.
const HKDF_INFO_PCK: &[u8] = b"lobster/pck/v1:";
/// HKDF info label — must match `@lobster/crypto` `HKDF_INFO_KEY_ID`.
const HKDF_INFO_KEY_ID: &[u8] = b"lobster/pck-key-id/v1:";

/// Derive a stable Profile Content Key from TDK + profile id (HKDF-SHA256).
pub fn derive_profile_content_key(
    team_data_key: &[u8; LB_V1_KEY_LEN],
    profile_id: &str,
) -> Result<[u8; LB_V1_KEY_LEN]> {
    if profile_id.is_empty() {
        bail!("profileId must be non-empty");
    }
    let hk = Hkdf::<Sha256>::new(None, team_data_key);
    let mut okm = [0u8; LB_V1_KEY_LEN];
    let mut info = Vec::with_capacity(HKDF_INFO_PCK.len() + profile_id.len());
    info.extend_from_slice(HKDF_INFO_PCK);
    info.extend_from_slice(profile_id.as_bytes());
    hk.expand(&info, &mut okm)
        .map_err(|_| anyhow!("HKDF expand failed for PCK"))?;
    Ok(okm)
}

/// Derive a stable 16-byte LBv1 key_id from TDK + profile id.
pub fn derive_key_id(
    team_data_key: &[u8; LB_V1_KEY_LEN],
    profile_id: &str,
) -> Result<[u8; LB_V1_KEY_ID_LEN]> {
    let hk = Hkdf::<Sha256>::new(None, team_data_key);
    let mut okm = [0u8; LB_V1_KEY_ID_LEN];
    let mut info = Vec::with_capacity(HKDF_INFO_KEY_ID.len() + profile_id.len());
    info.extend_from_slice(HKDF_INFO_KEY_ID);
    info.extend_from_slice(profile_id.as_bytes());
    hk.expand(&info, &mut okm)
        .map_err(|_| anyhow!("HKDF expand failed for key_id"))?;
    Ok(okm)
}

/// AES-256-GCM wrap of a 32-byte key (LKw1 envelope — mirrors `@lobster/crypto` wrapKey).
pub fn wrap_key(plaintext_key: &[u8; LB_V1_KEY_LEN], wrapping_key: &[u8; LB_V1_KEY_LEN]) -> Result<Vec<u8>> {
    const MAGIC: &[u8; 4] = b"LKw1";
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(wrapping_key));
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let sealed = cipher
        .encrypt(&nonce, plaintext_key.as_slice())
        .map_err(|e| anyhow!("key wrap encrypt failed: {e}"))?;
    let mut out = Vec::with_capacity(4 + LB_V1_NONCE_LEN + sealed.len());
    out.extend_from_slice(MAGIC);
    out.extend_from_slice(nonce.as_slice());
    out.extend_from_slice(&sealed);
    Ok(out)
}

/// Unwrap an LKw1-wrapped key.
pub fn unwrap_key(wrapped: &[u8], wrapping_key: &[u8; LB_V1_KEY_LEN]) -> Result<[u8; LB_V1_KEY_LEN]> {
    const MAGIC: &[u8; 4] = b"LKw1";
    if wrapped.len() < 4 + LB_V1_NONCE_LEN + LB_V1_KEY_LEN + LB_V1_TAG_LEN {
        bail!("wrapped key too short");
    }
    if &wrapped[..4] != MAGIC {
        bail!("wrapped key magic is not LKw1");
    }
    let nonce = Nonce::from_slice(&wrapped[4..4 + LB_V1_NONCE_LEN]);
    let sealed = &wrapped[4 + LB_V1_NONCE_LEN..];
    let cipher = Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(wrapping_key));
    let pt = cipher
        .decrypt(nonce, sealed)
        .map_err(|_| anyhow!("key unwrap failed (wrong wrapping key or tampered wrap)"))?;
    let key: [u8; LB_V1_KEY_LEN] = pt
        .as_slice()
        .try_into()
        .map_err(|_| anyhow!("unwrapped key must be 32 bytes"))?;
    Ok(key)
}

#[cfg(test)]
mod tests {
    use super::*;

    const COOKIE_DOMAIN: &str = "accounts.example.com";
    const COOKIE_VALUE: &str = "session-token-hunter2-secret";

    #[test]
    fn round_trips_and_never_embeds_cleartext_secrets() {
        let key = BlobCipher::generate_key();
        let key_id = BlobCipher::generate_key_id();
        let cipher = BlobCipher::new(&key);
        let plaintext = format!(
            r#"{{"cookie":"{COOKIE_VALUE}","domain":"{COOKIE_DOMAIN}"}}"#
        );

        let envelope = cipher.encrypt(plaintext.as_bytes(), &key_id).unwrap();
        assert!(BlobCipher::is_lbv1(&envelope));
        assert_eq!(&envelope[..4], LB_V1_MAGIC);
        assert_eq!(envelope[4 + LB_V1_KEY_ID_LEN], LB_V1_ALG_A256GCM);

        let as_latin1 = String::from_utf8_lossy(&envelope);
        assert!(!as_latin1.contains(COOKIE_VALUE));
        assert!(!as_latin1.contains(COOKIE_DOMAIN));
        assert!(!as_latin1.contains("hunter2"));

        let (decrypted, got_id) = cipher.decrypt(&envelope).unwrap();
        assert_eq!(decrypted, plaintext.as_bytes());
        assert_eq!(got_id, key_id);
    }

    #[test]
    fn fresh_nonce_yields_distinct_envelopes() {
        let key = BlobCipher::generate_key();
        let key_id = [0u8; LB_V1_KEY_ID_LEN];
        let cipher = BlobCipher::new(&key);
        let a = cipher.encrypt(b"same-payload", &key_id).unwrap();
        let b = cipher.encrypt(b"same-payload", &key_id).unwrap();
        assert_ne!(a, b);
        assert_eq!(cipher.decrypt(&a).unwrap().0, b"same-payload");
        assert_eq!(cipher.decrypt(&b).unwrap().0, b"same-payload");
    }

    #[test]
    fn tamper_and_wrong_key_fail_closed() {
        let key = BlobCipher::generate_key();
        let key_id = BlobCipher::generate_key_id();
        let cipher = BlobCipher::new(&key);
        let mut envelope = cipher.encrypt(b"secret-blob", &key_id).unwrap();

        let last = envelope.len() - 1;
        envelope[last] ^= 0xff;
        assert!(cipher.decrypt(&envelope).is_err());

        // Restore and try the wrong key.
        envelope[last] ^= 0xff;
        let other = BlobCipher::new(&BlobCipher::generate_key());
        assert!(other.decrypt(&envelope).is_err());

        let mut bad_magic = envelope.clone();
        bad_magic[0] = b'X';
        assert!(cipher.decrypt(&bad_magic).is_err());
    }

    #[test]
    fn profile_blob_json_stays_opaque_on_the_wire() {
        let key = BlobCipher::generate_key();
        let key_id = BlobCipher::generate_key_id();
        let cipher = BlobCipher::new(&key);
        let seed = "0123456789abcdef0123456789abcdef";
        let payload = format!(
            r#"{{"v":1,"profileId":"p_test_sec1","exportedAt":"2026-07-09T00:00:00.000Z","fingerprintSeed":"{seed}","cookies":[{{"name":"session","value":"{COOKIE_VALUE}","domain":"{COOKIE_DOMAIN}"}}]}}"#
        );
        let envelope = cipher.encrypt(payload.as_bytes(), &key_id).unwrap();
        let wire = String::from_utf8_lossy(&envelope);
        assert!(!wire.contains(COOKIE_VALUE));
        assert!(!wire.contains(COOKIE_DOMAIN));
        assert!(!wire.contains(seed));
        assert!(!wire.contains("p_test_sec1"));

        let (plain, _) = cipher.decrypt(&envelope).unwrap();
        assert_eq!(plain, payload.as_bytes());
    }

    #[test]
    fn hkdf_pck_is_stable_and_profile_scoped() {
        let tdk = BlobCipher::generate_key();
        let a = derive_profile_content_key(&tdk, "p_abc").unwrap();
        let b = derive_profile_content_key(&tdk, "p_abc").unwrap();
        let c = derive_profile_content_key(&tdk, "p_other").unwrap();
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_eq!(
            derive_key_id(&tdk, "p_abc").unwrap(),
            derive_key_id(&tdk, "p_abc").unwrap()
        );
    }

    #[test]
    fn wrap_unwrap_round_trips_and_wrong_key_fails() {
        let wrapping = BlobCipher::generate_key();
        let plaintext = BlobCipher::generate_key();
        let wrapped = wrap_key(&plaintext, &wrapping).unwrap();
        assert_eq!(&wrapped[..4], b"LKw1");
        assert_eq!(unwrap_key(&wrapped, &wrapping).unwrap(), plaintext);
        assert!(unwrap_key(&wrapped, &BlobCipher::generate_key()).is_err());
    }
}
