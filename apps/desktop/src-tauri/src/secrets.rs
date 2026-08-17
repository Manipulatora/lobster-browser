//! At-rest encryption for secrets in the local SQLite stores (SEC-12).
//!
//! Sensitive values (proxy usernames/passwords, cookie-import payloads) are encrypted with
//! AES-256-GCM before they hit disk and decrypted at the store boundary on read. Ciphertext is
//! stored as `lbsec1:<base64(nonce || ciphertext)>` so encrypted cells are self-describing.
//!
//! Reads are STRICT (SEC-19): a cell without the prefix, or one that does not authenticate, is a
//! [`SecretUnavailable`] error, never a value. The former best-effort read accepted an unprefixed
//! cell as "legacy plaintext" and returned a tampered cell verbatim, which turned the SQLite file
//! into a keyless injection channel — write plain JSON cookies into `cookies_import` and the app
//! injects the attacker's session on the next launch.
//!
//! Key management (SEC-2): a random 32-byte Local Store Key (LSK) is loaded via
//! [`crate::keychain::load_or_create_lsk`] — OS keychain first, 0600 file fallback.

use std::path::Path;

use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
use aes_gcm::{Aes256Gcm, Key, Nonce};
use anyhow::{anyhow, bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;

/// Versioned marker prefix for encrypted cells (bump for future format/key rotation).
const ENC_PREFIX: &str = "lbsec1:";
/// AES-GCM standard 96-bit nonce.
const NONCE_LEN: usize = 12;

/// JSON keys inside a proxy config / profile proxy object that hold credentials.
pub const PROXY_SECRET_FIELDS: &[&str] = &["username", "password"];

/// AES-256-GCM cipher over the per-install secrets key. Shared (via `Arc`) by every store.
pub struct SecretCipher {
    cipher: Aes256Gcm,
}

impl SecretCipher {
    /// Build a cipher from a raw 32-byte key (used by tests and by `load_or_create`).
    pub fn new(key: &[u8; 32]) -> Self {
        Self {
            cipher: Aes256Gcm::new(Key::<Aes256Gcm>::from_slice(key)),
        }
    }

    /// Load the per-install Local Store Key via OS keychain (preferred) or the 0600 file at
    /// `path`. See [`crate::keychain::load_or_create_lsk`].
    pub fn load_or_create<P: AsRef<Path>>(path: P) -> Result<Self> {
        let (key, source) = crate::keychain::load_or_create_lsk(path.as_ref())?;
        tracing::info!(
            ?source,
            "loaded Local Store Key for SEC-12 at-rest encryption"
        );
        Ok(Self::new(&key))
    }

    /// True if `stored` carries the encrypted-cell marker.
    pub fn is_encrypted(stored: &str) -> bool {
        stored.starts_with(ENC_PREFIX)
    }

    /// Encrypt a plaintext secret into the `lbsec1:` storage form (fresh random nonce per call).
    pub fn encrypt_str(&self, plaintext: &str) -> Result<String> {
        let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
        let ciphertext = self
            .cipher
            .encrypt(&nonce, plaintext.as_bytes())
            .map_err(|e| anyhow!("AES-GCM encrypt failed: {e}"))?;
        let mut blob = Vec::with_capacity(NONCE_LEN + ciphertext.len());
        blob.extend_from_slice(&nonce);
        blob.extend_from_slice(&ciphertext);
        Ok(format!("{ENC_PREFIX}{}", BASE64.encode(blob)))
    }

    /// Decrypt a stored cell. The only read path: both failure modes are [`SecretUnavailable`].
    pub fn decrypt_strict(&self, stored: &str) -> Result<String> {
        let encoded = stored
            .strip_prefix(ENC_PREFIX)
            .ok_or(SecretUnavailable::NotEncrypted)?;
        self.try_decrypt(encoded).map_err(|cause| {
            SecretUnavailable::Undecryptable {
                detail: cause.to_string(),
            }
            .into()
        })
    }

    fn try_decrypt(&self, encoded: &str) -> Result<String> {
        let blob = BASE64.decode(encoded)?;
        if blob.len() < NONCE_LEN {
            bail!("ciphertext blob shorter than nonce");
        }
        let (nonce, ciphertext) = blob.split_at(NONCE_LEN);
        let plaintext = self
            .cipher
            .decrypt(Nonce::from_slice(nonce), ciphertext)
            .map_err(|e| anyhow!("AES-GCM decrypt failed: {e}"))?;
        Ok(String::from_utf8(plaintext)?)
    }

    /// Encrypt the given string-valued keys of a JSON object in place (already-encrypted or
    /// empty values are left alone, so re-writing a row is idempotent).
    pub fn encrypt_json_fields(
        &self,
        value: &mut serde_json::Value,
        fields: &[&str],
    ) -> Result<()> {
        if let Some(obj) = value.as_object_mut() {
            for field in fields {
                if let Some(serde_json::Value::String(s)) = obj.get_mut(*field) {
                    if !s.is_empty() && !Self::is_encrypted(s) {
                        *s = self.encrypt_str(s)?;
                    }
                }
            }
        }
        Ok(())
    }

    /// Decrypt the given string-valued keys of a JSON object in place. Fails on the first cell
    /// that cannot be decrypted: a partially-decrypted credential set would be handed to the
    /// browser as a real username/password and surface as "the proxy rejected my credentials".
    pub fn decrypt_json_fields(
        &self,
        value: &mut serde_json::Value,
        fields: &[&str],
    ) -> Result<()> {
        if let Some(obj) = value.as_object_mut() {
            for field in fields {
                if let Some(serde_json::Value::String(s)) = obj.get_mut(*field) {
                    *s = self.decrypt_strict(s)?;
                }
            }
        }
        Ok(())
    }
}

/// A stored secret cell that cannot be turned back into plaintext on this machine.
///
/// Kept as a distinct type because the two variants need different words in front of the user: one
/// means the local database was written by something other than this app, the other means the
/// Local Store Key this install holds is not the key the cells were written with (a copied
/// `profiles.sqlite`, a reinstall, a restored backup) — "local secrets cannot be decrypted on this
/// machine", not "your proxy password is wrong".
#[derive(Debug)]
pub enum SecretUnavailable {
    /// No `lbsec1:` marker: never encrypted, or overwritten by something that is not our cell.
    NotEncrypted,
    /// Marked as ours but does not authenticate: wrong key, tampering, or truncation.
    Undecryptable { detail: String },
}

impl std::fmt::Display for SecretUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::NotEncrypted => write!(f, "stored secret is not encrypted"),
            Self::Undecryptable { detail } => write!(
                f,
                "local secrets cannot be decrypted on this machine ({detail})"
            ),
        }
    }
}

impl std::error::Error for SecretUnavailable {}

#[cfg(test)]
mod tests {
    use super::*;

    fn cipher() -> SecretCipher {
        SecretCipher::new(&[7u8; 32])
    }

    #[test]
    fn encrypt_round_trips_and_never_stores_plaintext() {
        let c = cipher();
        let stored = c.encrypt_str("hunter2").unwrap();
        assert!(SecretCipher::is_encrypted(&stored));
        assert!(!stored.contains("hunter2"));
        assert_eq!(c.decrypt_strict(&stored).unwrap(), "hunter2");
        // Fresh nonce per call: same plaintext yields different ciphertext.
        assert_ne!(stored, c.encrypt_str("hunter2").unwrap());
    }

    /// SEC-19: a read must never hand back the stored cell. Returning it made the SQLite file an
    /// injection channel requiring no key (unprefixed cookies were trusted as "legacy plaintext").
    #[test]
    fn plaintext_and_tampered_cells_are_rejected_as_secret_unavailable() {
        let c = cipher();
        let unavailable = |stored: &str, cipher: &SecretCipher| {
            let err = cipher
                .decrypt_strict(stored)
                .expect_err("undecryptable cell must not read back as a value");
            assert!(
                !err.to_string().contains(stored),
                "the error must not echo the cell: {err}"
            );
            format!(
                "{:?}",
                err.downcast_ref::<SecretUnavailable>()
                    .expect("typed SecretUnavailable")
            )
        };
        assert!(unavailable("plain-old-password", &c).starts_with("NotEncrypted"));
        // Wrong key → auth failure → error, never the ciphertext string.
        let stored = c.encrypt_str("secret").unwrap();
        let other = SecretCipher::new(&[9u8; 32]);
        assert!(unavailable(&stored, &other).starts_with("Undecryptable"));
        assert!(unavailable("lbsec1:!!!not-base64", &c).starts_with("Undecryptable"));
    }

    #[test]
    fn json_field_helpers_encrypt_only_secret_fields() {
        let c = cipher();
        let mut config = serde_json::json!({
            "type": "http", "host": "proxy.example", "port": 8080,
            "username": "user1", "password": "hunter2"
        });
        c.encrypt_json_fields(&mut config, PROXY_SECRET_FIELDS)
            .unwrap();
        assert_eq!(config["host"], "proxy.example");
        assert!(SecretCipher::is_encrypted(
            config["username"].as_str().unwrap()
        ));
        assert!(SecretCipher::is_encrypted(
            config["password"].as_str().unwrap()
        ));
        // Idempotent: a second encrypt pass must not double-wrap.
        let once = config["password"].as_str().unwrap().to_string();
        c.encrypt_json_fields(&mut config, PROXY_SECRET_FIELDS)
            .unwrap();
        assert_eq!(config["password"].as_str().unwrap(), once);
        c.decrypt_json_fields(&mut config, PROXY_SECRET_FIELDS)
            .unwrap();
        assert_eq!(config["username"], "user1");
        assert_eq!(config["password"], "hunter2");
    }

    #[test]
    fn key_file_persists_across_loads_with_owner_only_permissions() {
        let dir = std::env::temp_dir().join(format!("lobster-secrets-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let key_path = dir.join("secrets.key");

        let first = SecretCipher::load_or_create(&key_path).unwrap();
        let stored = first.encrypt_str("persisted-secret").unwrap();
        let reloaded = SecretCipher::load_or_create(&key_path).unwrap();
        assert_eq!(
            reloaded.decrypt_strict(&stored).unwrap(),
            "persisted-secret"
        );

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&key_path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600, "key file must be owner-only");
        }
        std::fs::remove_dir_all(dir).unwrap();
    }
}
