//! macOS OSCrypt v10 key custody, and the `--use-mock-keychain` state machine.
//!
//! Two keys, both AES-128-CBC and both tagged `v10`, differing only in the PBKDF2 password:
//!
//! * REAL — `PBKDF2-HMAC-SHA1(1003, "saltysalt", <Keychain generic password>)`. The generic password
//!   lives under service `"Chromium Safe Storage"` / account `"Chromium"` (the fork's non-Google
//!   default, NOT localized). Reading it is a Keychain access that prompts the user; the read is
//!   therefore behind an explicit caller-supplied consent flag — never silent.
//! * MOCK — `PBKDF2-HMAC-SHA1(1003, "saltysalt", "mock_password")`, the `FakeKeychainV2` constant. No
//!   Keychain access, no prompt. This is what `--use-mock-keychain` selects.
//!
//! The hazard that dictates the whole design (guard lives in [`super`], tested on Linux): because both
//! keys carry tag `v10` and Chromium's `DecryptData` has NO cross-key retry on a tag match, applying
//! the mock key to a jar sealed with the REAL key is a PERMANENT decrypt failure that razes the jar.
//! So the mock key — and the flag — may be used only after a profile has been migrated: every value
//! re-sealed under the mock key, read-back-verified, and only then `oscrypt_mode` flipped to `mock`.
//!
//! The mock-key derivation and the guard are cfg-independent (unit-tested here and in [`super`] on
//! Linux). Only the real Keychain read is `#[cfg(target_os = "macos")]`.

use crate::snapshot::oscrypt::{pbkdf2_sha1_16, OsCryptKeyring, OsKey, OscryptMode, TAG_V10};
use anyhow::Result;

/// PBKDF2 iteration count for macOS OSCrypt — 1003, not Linux's 1.
const MAC_ITERATIONS: u32 = 1003;
/// The `FakeKeychainV2` password `--use-mock-keychain` substitutes for the real Keychain secret.
const MOCK_PASSWORD: &[u8] = b"mock_password";

#[cfg(target_os = "macos")]
const KEYCHAIN_SERVICE: &str = "Chromium Safe Storage";
#[cfg(target_os = "macos")]
const KEYCHAIN_ACCOUNT: &str = "Chromium";

/// The macOS v10 mock key: `PBKDF2-HMAC-SHA1("mock_password", "saltysalt", 1003)`. Cfg-independent so
/// the value is known-answer tested on Linux — a migration that re-seals under this key must produce
/// exactly what an engine launched with `--use-mock-keychain` will later expect.
pub fn mock_v10_key() -> [u8; 16] {
    pbkdf2_sha1_16(MOCK_PASSWORD, b"saltysalt", MAC_ITERATIONS)
}

/// A macOS keyring: one AES-128-CBC key plus the mode it represents, so a caller can assert the mode
/// matches what it intended (a `mock` keyring must never be handed to a `keychain` profile).
pub struct MacKeyring {
    key: [u8; 16],
    mode: OscryptMode,
}

impl MacKeyring {
    /// The mock keyring. Cfg-independent (no Keychain access), so it is constructible and testable on
    /// any OS. Legal to USE only for a profile whose `oscrypt_mode` is already `mock`.
    pub fn mock() -> Self {
        Self {
            key: mock_v10_key(),
            mode: OscryptMode::Mock,
        }
    }

    pub fn mode(&self) -> OscryptMode {
        self.mode
    }

    /// Read the real login-Keychain secret and derive the v10 key. `consented` MUST be true: the read
    /// surfaces the OS Keychain-access prompt, and the design forbids triggering it silently. The
    /// caller (the capture/restore command) obtains consent through its own UI first and passes it
    /// through here; `false` refuses before any Keychain call is made.
    #[cfg(target_os = "macos")]
    pub fn keychain(consented: bool) -> Result<Self> {
        use anyhow::{bail, Context};
        if !consented {
            bail!(
                "KEYCHAIN_CONSENT_REQUIRED: reading `Chromium Safe Storage` prompts for Keychain \
                 access; refuse rather than trigger it without explicit user consent"
            );
        }
        let secret =
            security_framework::passwords::get_generic_password(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT)
                .context("reading the Chromium Safe Storage Keychain item")?;
        Ok(Self {
            key: pbkdf2_sha1_16(&secret, b"saltysalt", MAC_ITERATIONS),
            mode: OscryptMode::Keychain,
        })
    }

    /// Select the key for a profile's mode. `mock` → the mock key (no prompt); `keychain` /
    /// `pending-migration` → the real Keychain key (prompts, hence `consented`). A
    /// `pending-migration` profile still reads under the REAL key — it has not been re-sealed yet — so
    /// it is decrypt-correct; what it must never get is the `--use-mock-keychain` FLAG, which is
    /// enforced separately by [`super::guard_mock_keychain`].
    #[cfg(target_os = "macos")]
    pub fn for_mode(mode: OscryptMode, consented: bool) -> Result<Self> {
        match mode {
            OscryptMode::Mock => Ok(Self::mock()),
            OscryptMode::Keychain | OscryptMode::PendingMigration => Self::keychain(consented),
        }
    }
}

impl OsCryptKeyring for MacKeyring {
    fn keys_for_decrypt(&self) -> Vec<(&'static str, OsKey)> {
        vec![(TAG_V10, OsKey::Aes128Cbc(self.key))]
    }

    fn key_for_encrypt(&self) -> Result<OsKey> {
        Ok(OsKey::Aes128Cbc(self.key))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mock key is deterministic and 1003-iteration derived — pinned so a migration re-sealing
    /// under it agrees byte-for-byte with what `--use-mock-keychain` will expect on the next launch.
    #[test]
    fn mock_key_is_known_answer() {
        assert_eq!(
            mock_v10_key()
                .iter()
                .map(|b| format!("{b:02x}"))
                .collect::<String>(),
            "af0f762aaf6d7d11581b7aa8ce7218de"
        );
    }

    /// A mock keyring reports mock mode and encrypts/decrypts under the mock key — usable on Linux.
    #[test]
    fn mock_keyring_round_trips() {
        let ring = MacKeyring::mock();
        assert_eq!(ring.mode(), OscryptMode::Mock);
        let sealed =
            crate::snapshot::oscrypt::encrypt_value(&ring.key_for_encrypt().unwrap(), b"tok")
                .unwrap();
        assert_eq!(
            crate::snapshot::oscrypt::decrypt_value(&ring, &sealed).unwrap(),
            b"tok"
        );
    }
}
