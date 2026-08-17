//! Linux OSCrypt key source.
//!
//! Our Linux launcher pins `--password-store=basic` (`lobium-launcher.ts`), so `PosixKeyProvider` is
//! the only provider the engine ever links and every value is `v10` under a FIXED, well-known key:
//! `PBKDF2-HMAC-SHA1(password="peanuts", salt="saltysalt", iterations=1) = fd62…2778`, AES-128-CBC,
//! IV of sixteen 0x20 bytes. Because the key is a hardcoded constant, a Linux cookie jar is portable
//! to any other Linux machine WITHOUT transcoding — the transcode matters for the Linux↔Windows and
//! Linux↔macOS legs, where the key genuinely differs.
//!
//! Two decrypt fallbacks share the `v10` tag and so are tried by the oracle as extra candidates:
//! Chromium's own empty-password legacy key (`d0d0…d17f`), and — decrypt-ONLY, never written — the
//! Secret-Service `v11` key for a jar that predates the `basic` pin or was made by stock Chrome.

use crate::snapshot::oscrypt::{pbkdf2_sha1_16, OsCryptKeyring, OsKey, TAG_V10, TAG_V11};
use anyhow::Result;

/// The verified Linux v10 key. Hardcoded because it is a global constant of the platform (ground
/// truth: "the literal 16 bytes"), and cross-checked against the live PBKDF2 derivation in the tests
/// below so a change to either the constant or the derivation cannot pass silently.
pub const LINUX_V10_KEY: [u8; 16] = [
    0xfd, 0x62, 0x1f, 0xe5, 0xa2, 0xb4, 0x02, 0x53, 0x9d, 0xfa, 0x14, 0x7c, 0xa9, 0x27, 0x27, 0x78,
];

/// Chromium's AES-128-CBC empty-password legacy key. `Encryptor` retries this same-tag key when the
/// primary CBC decrypt fails; we offer it as a second `v10` candidate so the oracle can reach it.
pub const LINUX_LEGACY_EMPTY_KEY: [u8; 16] = [
    0xd0, 0xd0, 0xec, 0x9c, 0x7d, 0x77, 0xd4, 0x3a, 0xc5, 0x41, 0x87, 0xfa, 0x48, 0x18, 0xd1, 0x7f,
];

/// The Keychain-crate service/account a Secret-Service `v11` secret would live under, if one exists.
/// Chromium uses the product name; the fork's default (non-Google-branding) is `"Chromium"`.
const V11_KEYRING_SERVICE: &str = "Chromium Keys";
const V11_KEYRING_ACCOUNT: &str = "Chromium";

pub struct LinuxKeyring {
    /// A `v11` key is present only if a real keyring secret is found. `None` on our shipping
    /// `--password-store=basic` config, which is the common case.
    v11: Option<[u8; 16]>,
}

impl LinuxKeyring {
    pub fn new() -> Self {
        Self {
            v11: Self::probe_v11_key(),
        }
    }

    /// Best-effort read of a Secret-Service secret to derive the legacy `v11` key. Never fails the
    /// keyring: absence is the norm, and a `v11` row can only appear in a jar we did not create.
    fn probe_v11_key() -> Option<[u8; 16]> {
        let entry = keyring::Entry::new(V11_KEYRING_SERVICE, V11_KEYRING_ACCOUNT).ok()?;
        let secret = entry.get_password().ok()?;
        // v11 = PBKDF2-HMAC-SHA1(secret, "saltysalt", 1, 16) — 1 iteration, same as v10, different
        // password (the keyring secret rather than "peanuts").
        Some(pbkdf2_sha1_16(secret.as_bytes(), b"saltysalt", 1))
    }
}

impl Default for LinuxKeyring {
    fn default() -> Self {
        Self::new()
    }
}

impl OsCryptKeyring for LinuxKeyring {
    fn keys_for_decrypt(&self) -> Vec<(&'static str, OsKey)> {
        let mut keys = vec![
            (TAG_V10, OsKey::Aes128Cbc(LINUX_V10_KEY)),
            (TAG_V10, OsKey::Aes128Cbc(LINUX_LEGACY_EMPTY_KEY)),
        ];
        if let Some(v11) = self.v11 {
            keys.push((TAG_V11, OsKey::Aes128Cbc(v11)));
        }
        keys
    }

    fn key_for_encrypt(&self) -> Result<OsKey> {
        // Linux always writes v10 under the fixed key — it is never unreachable, which is why a
        // Linux target never needs the plaintext-value fallback.
        Ok(OsKey::Aes128Cbc(LINUX_V10_KEY))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The constant IS the PBKDF2 derivation — proven, not asserted. If a dependency bump changed the
    /// PBKDF2 output, this fails rather than shipping a key that logs every Linux user out.
    #[test]
    fn v10_key_matches_its_derivation() {
        assert_eq!(pbkdf2_sha1_16(b"peanuts", b"saltysalt", 1), LINUX_V10_KEY);
    }

    #[test]
    fn legacy_empty_key_matches_its_derivation() {
        assert_eq!(pbkdf2_sha1_16(b"", b"saltysalt", 1), LINUX_LEGACY_EMPTY_KEY);
    }

    /// A jar with no keyring secret still decrypts and encrypts under v10.
    #[test]
    fn basic_config_offers_two_v10_candidates() {
        let ring = LinuxKeyring { v11: None };
        let keys = ring.keys_for_decrypt();
        assert_eq!(keys.len(), 2);
        assert!(keys.iter().all(|(t, _)| *t == TAG_V10));
        assert!(matches!(
            ring.key_for_encrypt().unwrap(),
            OsKey::Aes128Cbc(_)
        ));
    }
}
