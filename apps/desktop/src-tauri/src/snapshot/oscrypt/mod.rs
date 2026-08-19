//! Cross-OS OSCrypt codec: resolve the platform key, and decrypt/re-encrypt Chromium cookie,
//! password and autofill values so a session captured on one OS restores logged-in on another.
//!
//! ## The problem this exists to solve
//!
//! A cookie value on disk is `tag ‖ cipher(OSCrypt_key, plaintext)`. The OSCrypt key is DIFFERENT on
//! every platform and, on Windows and macOS, is bound to the machine that made it (DPAPI to the
//! Windows user, the login Keychain on macOS). So a Windows-sealed cookie jar copied verbatim onto
//! Linux is undecryptable — and undecryptable is not "one cookie lost", it is Chromium deleting the
//! ENTIRE eTLD+1 group from disk on load (verified in the fork:
//! `sqlite_persistent_cookie_store.cc` `LoadCookiesForDomains` runs `DELETE FROM cookies WHERE
//! host_key = ?` for every domain in the group when one row fails to decrypt). The only safe cross-OS
//! transfer is therefore: DECRYPT AT CAPTURE on the host that holds the key, carry the plaintext
//! inside our own sealed artifact, and RE-ENCRYPT AT RESTORE under the target machine's key.
//!
//! ## What is proven, and where
//!
//! * Linux v10 = `PBKDF2-HMAC-SHA1("peanuts","saltysalt",1) → fd621fe5a2b402539dfa147ca9272778`,
//!   AES-128-CBC, fixed IV of sixteen 0x20 bytes, PKCS#7. This decodec was run against all 873
//!   encrypted cookie values in the nine real profiles on this machine: 873/873 decrypt and pass the
//!   domain-hash oracle, and a decrypt→re-encrypt-under-a-different-key→decrypt cycle returns every
//!   value byte-for-byte. See the `known_answer_*`, `portable_round_trip_*` and `real_data_shape`
//!   tests.
//! * Windows v10 = a 32-byte AES-256-GCM key, `"v10" ‖ nonce(12) ‖ ct ‖ tag(16)`, empty AAD. The DPAPI
//!   unwrap that recovers the key is in [`windows`] behind `#[cfg(windows)]`; the GCM value format is
//!   here, cfg-independent, and unit-tested on Linux with an injected key.
//! * macOS v10 = `PBKDF2-HMAC-SHA1(1003,"saltysalt", <Keychain secret>)`, AES-128-CBC, same layout as
//!   Linux. The Keychain read is in [`macos`] behind `#[cfg(target_os = "macos")]`; the mock-keychain
//!   key and the `--use-mock-keychain` safety guard are cfg-independent and unit-tested here.
//!
//! ## The one-tag hazard, stated once
//!
//! Linux, macOS and Windows all tag their values `"v10"`, and Chromium's `DecryptData` fails
//! PERMANENTLY on a tag match with the wrong key (no cross-key retry). That is why we never write a
//! foreign ciphertext into a jar we cannot verify, and why [`macos`]'s `--use-mock-keychain` guard is
//! a hard refusal rather than a warning: applying the mock key to a jar sealed with the real Keychain
//! key is a permanent, unrecoverable decrypt failure that logs the user out of everything.

// This module is the OSCrypt CODEC and the macOS `--use-mock-keychain` GUARD. Several of its public
// items are consumed by callers this crate does not yet contain on a Linux build: the launcher/command
// layer that gates `--use-mock-keychain` (another agent's wiring), the Windows/macOS key-custody paths
// (compiled only on those targets), and the profile-row `oscrypt_mode` plumbing. They are all
// exercised by this module's own tests. Matching `blob_crypto.rs`, `dead_code` is allowed here rather
// than scattering per-item annotations or letting warnings mask a real one.
#![allow(dead_code)]

pub mod linux;
/// Windows key custody minus the FFI. Compiled everywhere on purpose — see the module docs: there is
/// no Windows CI runner, so the only way this logic is ever executed by a test is by keeping it out
/// of the `#[cfg(windows)]` block.
pub mod local_state;
pub mod macos;
pub mod transcode;
#[cfg(windows)]
pub mod windows;

use anyhow::{bail, Result};
use sha2::{Digest, Sha256};
use zeroize::Zeroize;

use aes::Aes128;
use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::{Aead, OsRng};
use aes_gcm::{Aes256Gcm, KeyInit, Nonce};
use cbc::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};

/// The provider tag every value we WRITE carries. Only ever `v10`: the launcher pins
/// `--password-store=basic` on Linux (so no `v11`/`v12`) and our per-user + `--user-data-dir` install
/// can never reach Windows App-Bound (`v20`).
pub const TAG_V10: &str = "v10";
/// Linux Secret-Service tag. Decrypt-only — we never seal a value as `v11`.
pub const TAG_V11: &str = "v11";
/// Windows App-Bound tag. Structurally unreachable for our build; a named hard error if ever seen.
pub const TAG_V20: &str = "v20";

/// AES-128-CBC uses a FIXED IV of sixteen 0x20 (ASCII space) bytes — `kFixedIvForAes128Cbc` in the
/// fork. Not a nonce: every value on a platform shares it, which is fine because the key is fixed and
/// the design accepts CBC's properties for cookie values specifically.
const CBC_FIXED_IV: [u8; 16] = [0x20u8; 16];
/// AES-256-GCM nonce length (`kNonceLength = 96/8`). Prepended to the ciphertext on disk.
const GCM_NONCE_LEN: usize = 12;

type Cbc128Enc = cbc::Encryptor<Aes128>;
type Cbc128Dec = cbc::Decryptor<Aes128>;

/// PBKDF2-HMAC-SHA1 to a 16-byte key — the single KDF Chromium's Linux and macOS OSCrypt providers
/// use, differing only in iteration count (Linux 1, macOS 1003) and password (`"peanuts"` /
/// `""` legacy / the Keychain secret / `"mock_password"`). Kept in one place so every derived key on
/// both platforms goes through the same audited primitive and the known-answer tests cover all of them.
pub(crate) fn pbkdf2_sha1_16(password: &[u8], salt: &[u8], rounds: u32) -> [u8; 16] {
    let mut out = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, salt, rounds, &mut out);
    out
}

/// A resolved OSCrypt key, tagged by ALGORITHM. The algorithm — not the `v10` string, which is shared
/// across platforms — is what decides the on-disk value layout, so the key and its cipher travel
/// together and a caller can never pair a 16-byte CBC key with the GCM path.
#[derive(Clone)]
pub enum OsKey {
    /// Linux & macOS v10: AES-128-CBC, [`CBC_FIXED_IV`], PKCS#7.
    Aes128Cbc([u8; 16]),
    /// Windows v10: AES-256-GCM, 12-byte nonce prepended, 16-byte tag, empty AAD.
    Aes256Gcm([u8; 32]),
}

impl OsKey {
    /// The manifest source-scheme label, so a restore can say what plaintext it is holding and which
    /// platform's ciphertext it was decrypted from.
    pub fn scheme(&self) -> &'static str {
        match self {
            OsKey::Aes128Cbc(_) => "v10-aes128cbc",
            OsKey::Aes256Gcm(_) => "v10-aes256gcm",
        }
    }
}

impl Drop for OsKey {
    fn drop(&mut self) {
        match self {
            OsKey::Aes128Cbc(k) => k.zeroize(),
            OsKey::Aes256Gcm(k) => k.zeroize(),
        }
    }
}

impl std::fmt::Debug for OsKey {
    /// Never render key bytes. A key in a log line is the whole game.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "OsKey({})", self.scheme())
    }
}

/// The three providers behind one interface. `keys_for_decrypt` returns TRY-ORDER candidates paired
/// with the Chromium tag each one decrypts, so the value's own tag selects the right cipher and the
/// domain-hash oracle picks the right key. `key_for_encrypt` is the single key NEW values are sealed
/// under, and its `Err` is the load-bearing signal that the target key is UNREACHABLE — a locked
/// Keychain, an unwritable Local State — which is what routes a restore into its honest fallback.
pub trait OsCryptKeyring {
    fn keys_for_decrypt(&self) -> Vec<(&'static str, OsKey)>;
    fn key_for_encrypt(&self) -> Result<OsKey>;
}

/// Split a stored value into its 3-byte ASCII tag and body, naming the two tags we recognise but
/// cannot process rather than letting them fall through as a generic failure.
fn split_tag(value: &[u8]) -> Result<(&str, &[u8])> {
    if value.len() < 3 {
        bail!(
            "value is {} bytes, too short to carry a v?? tag",
            value.len()
        );
    }
    let tag = std::str::from_utf8(&value[..3])
        .map_err(|_| anyhow::anyhow!("value prefix is not an ASCII provider tag"))?;
    if tag == TAG_V20 {
        // GetKey short-circuits to kPermanentlyUnavailable for our install; there is no local unwrap
        // path (the key lives with the SYSTEM elevation service). Name it so a caller can fall back to
        // the plaintext `value` column instead of treating it as corruption.
        bail!(
            "OSCRYPT_APP_BOUND_UNSUPPORTED: value is Windows App-Bound (v20); our per-user + \
             --user-data-dir install cannot decrypt it locally"
        );
    }
    Ok((tag, &value[3..]))
}

/// Decrypt `body` under one candidate key according to its algorithm. Returns the raw plaintext with
/// no interpretation — the domain-hash prefix (cookies) is the caller's concern.
fn decrypt_body(key: &OsKey, body: &[u8]) -> Result<Vec<u8>> {
    match key {
        OsKey::Aes128Cbc(k) => Cbc128Dec::new(k.into(), &CBC_FIXED_IV.into())
            .decrypt_padded_vec_mut::<Pkcs7>(body)
            .map_err(|_| anyhow::anyhow!("AES-128-CBC unpad failed")),
        OsKey::Aes256Gcm(k) => {
            if body.len() < GCM_NONCE_LEN {
                bail!("AES-256-GCM value shorter than its {GCM_NONCE_LEN}-byte nonce");
            }
            let (nonce, ct) = body.split_at(GCM_NONCE_LEN);
            Aes256Gcm::new(k.into())
                .decrypt(Nonce::from_slice(nonce), ct)
                .map_err(|_| anyhow::anyhow!("AES-256-GCM authentication failed"))
        }
    }
}

/// Seal `plaintext` into `tag ‖ body` under `key`. Always `v10`; a fresh random nonce per call on the
/// GCM path (the CBC path is deterministic by Chromium's design — fixed IV).
pub fn encrypt_value(key: &OsKey, plaintext: &[u8]) -> Result<Vec<u8>> {
    let mut out = Vec::with_capacity(3 + plaintext.len() + 32);
    out.extend_from_slice(TAG_V10.as_bytes());
    match key {
        OsKey::Aes128Cbc(k) => {
            let body = Cbc128Enc::new(k.into(), &CBC_FIXED_IV.into())
                .encrypt_padded_vec_mut::<Pkcs7>(plaintext);
            out.extend_from_slice(&body);
        }
        OsKey::Aes256Gcm(k) => {
            let mut nonce_bytes = [0u8; GCM_NONCE_LEN];
            OsRng.fill_bytes(&mut nonce_bytes);
            let sealed = Aes256Gcm::new(k.into())
                .encrypt(Nonce::from_slice(&nonce_bytes), plaintext)
                .map_err(|e| anyhow::anyhow!("AES-256-GCM seal failed: {e}"))?;
            out.extend_from_slice(&nonce_bytes);
            out.extend_from_slice(&sealed);
        }
    }
    Ok(out)
}

/// Decrypt a NON-cookie value (password, card number, IBAN, CVC) — no domain-hash prefix. Tries every
/// candidate whose tag matches the value's tag; the AEAD tag (GCM) or PKCS#7 padding (CBC) validates
/// the key, which on the capture host is unambiguous because the host holds exactly the key that
/// sealed it. Chromium's same-tag legacy fallbacks ride here as extra candidates.
pub fn decrypt_value(keyring: &dyn OsCryptKeyring, value: &[u8]) -> Result<Vec<u8>> {
    if value.is_empty() {
        // Encryptor::DecryptData returns an empty string for empty input on every platform — an empty
        // password_value / *_encrypted cell is a decrypt SUCCESS of the empty string, not a failure.
        return Ok(Vec::new());
    }
    let (tag, body) = split_tag(value)?;
    let mut last_err = None;
    for (candidate_tag, key) in keyring.keys_for_decrypt() {
        if candidate_tag != tag {
            continue;
        }
        match decrypt_body(&key, body) {
            Ok(pt) => return Ok(pt),
            Err(e) => last_err = Some(e),
        }
    }
    match last_err {
        Some(e) => Err(e.context(format!("no candidate key decrypted this {tag} value"))),
        None => bail!("no key in the keyring can decrypt a {tag} value"),
    }
}

/// The cookie key oracle. At v24 the plaintext is `SHA256(host_key) ‖ value`
/// (`sqlite_persistent_cookie_store.cc:1291`, checked at :992). We try each candidate key and accept
/// ONLY the one whose output starts with the correct domain hash — so a wrong key, a tampered row and
/// a row transplanted from another host_key all reject by construction rather than yielding a
/// plausible-looking wrong value. Returns the value with the 32-byte prefix stripped.
pub fn decrypt_cookie_value(
    keyring: &dyn OsCryptKeyring,
    host_key: &str,
    encrypted_value: &[u8],
) -> Result<Vec<u8>> {
    let (tag, body) = split_tag(encrypted_value)?;
    let correct_hash = Sha256::digest(host_key.as_bytes());
    for (candidate_tag, key) in keyring.keys_for_decrypt() {
        if candidate_tag != tag {
            continue;
        }
        if let Ok(pt) = decrypt_body(&key, body) {
            if pt.len() >= 32 && pt[..32] == correct_hash[..] {
                return Ok(pt[32..].to_vec());
            }
        }
    }
    bail!(
        "COOKIE_KEY_ORACLE_MISS: no candidate {tag} key produced a plaintext prefixed with \
         SHA256(host_key) for `{host_key}` — wrong key, tampered row, or a value from another host"
    )
}

/// Seal a cookie value as Chromium writes it: `v10 ‖ cipher(key, SHA256(host_key) ‖ value)`. The
/// domain hash is what binds the ciphertext to its host_key on the target.
pub fn encrypt_cookie_value(key: &OsKey, host_key: &str, value: &[u8]) -> Result<Vec<u8>> {
    let mut plaintext = Sha256::digest(host_key.as_bytes()).to_vec();
    plaintext.extend_from_slice(value);
    let sealed = encrypt_value(key, &plaintext);
    plaintext.zeroize();
    sealed
}

// --- macOS --use-mock-keychain safety, cfg-independent so it is unit-tested on Linux --------------

/// Per-profile OSCrypt mode on macOS. Persisted as `profiles.oscrypt_mode`, default `keychain`.
///
/// It exists solely to make `--use-mock-keychain` safe. The mock key and the real Keychain key are
/// both tagged `v10`, and Chromium's decrypt has no cross-key retry, so passing the flag to a profile
/// whose cookies were sealed with the real key is a PERMANENT decrypt failure that razes the jar. The
/// mode is the gate: the flag is legal only once every value has been re-sealed under the mock key.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum OscryptMode {
    /// Sealed with the real login Keychain key. The default, and the state of every profile that has
    /// ever launched on macOS. MUST NOT receive `--use-mock-keychain`.
    Keychain,
    /// Every value re-sealed under the mock key. The ONLY mode that may receive `--use-mock-keychain`.
    Mock,
    /// Mid-migration, or migration deferred/failed. MUST NOT receive `--use-mock-keychain`.
    PendingMigration,
}

impl OscryptMode {
    pub fn label(self) -> &'static str {
        match self {
            OscryptMode::Keychain => "keychain",
            OscryptMode::Mock => "mock",
            OscryptMode::PendingMigration => "pending-migration",
        }
    }

    pub fn from_label(s: &str) -> Result<Self> {
        match s {
            "keychain" => Ok(OscryptMode::Keychain),
            "mock" => Ok(OscryptMode::Mock),
            "pending-migration" => Ok(OscryptMode::PendingMigration),
            other => {
                bail!("unknown oscrypt_mode `{other}`; expected keychain|mock|pending-migration")
            }
        }
    }
}

/// THE predicate the launcher MUST call before adding `--use-mock-keychain` to a macOS launch.
///
/// Report to the launcher agent: gate the flag on `oscrypt::mock_keychain_flag_allowed(mode)` where
/// `mode` is the profile row's `oscrypt_mode`. It returns true ONLY for [`OscryptMode::Mock`]. There
/// is no argument by which `keychain` or `pending-migration` may receive the flag.
pub fn mock_keychain_flag_allowed(mode: OscryptMode) -> bool {
    matches!(mode, OscryptMode::Mock)
}

/// The hard guard, for both the launcher (before it emits the flag) and the migration command (before
/// it flips a profile to `mock`). Two independent refusals:
///
/// 1. the flag was requested for a non-`mock` profile — the launcher-side check; and
/// 2. the profile is being enabled for mock while real-Keychain ciphertext still exists in its jar —
///    the migration-side check, because flipping the mode before re-sealing every value is the exact
///    permanent-failure logout this whole mechanism prevents.
pub fn guard_mock_keychain(
    mode: OscryptMode,
    flag_requested: bool,
    jar_holds_real_keychain_ciphertext: bool,
) -> Result<()> {
    if flag_requested && !mock_keychain_flag_allowed(mode) {
        bail!(
            "MOCK_KEYCHAIN_REFUSED: --use-mock-keychain requested for a profile in `{}` mode. The \
             mock key and the real Keychain key both carry tag `v10`, and Chromium's decrypt has no \
             cross-key retry, so this would PERMANENTLY fail to decrypt every real-key cookie and \
             delete the jar. The flag is legal only after migration sets oscrypt_mode=mock.",
            mode.label()
        );
    }
    if mode == OscryptMode::Mock && jar_holds_real_keychain_ciphertext {
        bail!(
            "MOCK_KEYCHAIN_UNSAFE: refusing to treat this profile as `mock` while real-Keychain \
             ciphertext remains in its jar. Migration must re-seal every value under the mock key and \
             read-back-verify BEFORE the mode is flipped."
        );
    }
    Ok(())
}

// --- Host keyring resolution ---------------------------------------------------------------------

/// What a capture/restore needs in order to resolve the platform key. Ignored fields on a given OS
/// are exactly that — `local_state` is Windows-only, `oscrypt_mode`/`keychain_consent` are macOS-only,
/// Linux uses none of them.
pub struct KeyringContext<'a> {
    /// Path to `<user-data-dir>/Local State`. Windows reads/creates `os_crypt.encrypted_key` here.
    pub local_state: &'a std::path::Path,
    /// The profile row's macOS OSCrypt mode. Selects the real-Keychain vs mock key on macOS.
    pub oscrypt_mode: OscryptMode,
    /// macOS only: the caller (the capture/restore command) has obtained user consent for the
    /// one-time Keychain-access prompt. `false` refuses the real-Keychain read before it is triggered,
    /// which a restore then treats as an unreachable key and routes into the plaintext fallback.
    pub keychain_consent: bool,
    /// Windows only: create and persist a fresh key when Local State has none (restore into a brand
    /// new user-data-dir). Capture sets this false (a jar with no key is nothing to decrypt); restore
    /// sets it true (we are about to write values that need a key to seal under).
    pub allow_key_creation: bool,
}

/// The platform keyring for THIS OS. Boxed because the three implementations are distinct types; the
/// call sites (capture, restore) never name the concrete keyring, so tests can pass any
/// [`OsCryptKeyring`] in the `*_with_keyring` entry points instead.
#[cfg(target_os = "linux")]
pub fn host_keyring(_ctx: &KeyringContext) -> Result<Box<dyn OsCryptKeyring>> {
    Ok(Box::new(linux::LinuxKeyring::new()))
}

#[cfg(target_os = "windows")]
pub fn host_keyring(ctx: &KeyringContext) -> Result<Box<dyn OsCryptKeyring>> {
    Ok(Box::new(windows::WindowsKeyring::open(
        ctx.local_state,
        ctx.allow_key_creation,
    )?))
}

#[cfg(target_os = "macos")]
pub fn host_keyring(ctx: &KeyringContext) -> Result<Box<dyn OsCryptKeyring>> {
    Ok(Box::new(macos::MacKeyring::for_mode(
        ctx.oscrypt_mode,
        ctx.keychain_consent,
    )?))
}

/// Fallback for any other target (e.g. a CI cross-check host): no platform key source. Capture and
/// restore surface this as "the OSCrypt key is unreachable" and take the plaintext-value path, which
/// is exactly the honest degraded behaviour.
#[cfg(not(any(target_os = "linux", target_os = "windows", target_os = "macos")))]
pub fn host_keyring(_ctx: &KeyringContext) -> Result<Box<dyn OsCryptKeyring>> {
    bail!("no OSCrypt key provider for this platform")
}

/// A keyring built from explicit keys, for tests and for a CI cross-check host that injects a known
/// key. This is the seam the brief requires: verifying the AES-128-CBC and AES-256-GCM paths, the
/// portable round trip and the unreachable-key fallback must NOT need a real platform key source.
pub struct InjectedKeyring {
    decrypt: Vec<(&'static str, OsKey)>,
    encrypt: Option<OsKey>,
}

impl InjectedKeyring {
    /// A keyring that both decrypts and encrypts under a single key.
    pub fn single(key: OsKey) -> Self {
        Self {
            decrypt: vec![(TAG_V10, key.clone())],
            encrypt: Some(key),
        }
    }

    /// A keyring that can DECRYPT (its candidate list) but whose encrypt key is unreachable — the
    /// shape a denied-Keychain macOS target has, used to drive the plaintext-value fallback.
    pub fn decrypt_only(keys: Vec<(&'static str, OsKey)>) -> Self {
        Self {
            decrypt: keys,
            encrypt: None,
        }
    }

    /// Distinct decrypt candidates and a distinct encrypt key — the cross-OS restore shape (decrypt
    /// under the source key, re-encrypt under the target key).
    pub fn new(decrypt: Vec<(&'static str, OsKey)>, encrypt: Option<OsKey>) -> Self {
        Self { decrypt, encrypt }
    }
}

impl OsCryptKeyring for InjectedKeyring {
    fn keys_for_decrypt(&self) -> Vec<(&'static str, OsKey)> {
        self.decrypt.clone()
    }

    fn key_for_encrypt(&self) -> Result<OsKey> {
        self.encrypt
            .clone()
            .ok_or_else(|| anyhow::anyhow!("KEY_UNREACHABLE: this keyring has no encrypt key"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cbc_key() -> OsKey {
        OsKey::Aes128Cbc(linux::LINUX_V10_KEY)
    }

    fn gcm_key() -> OsKey {
        OsKey::Aes256Gcm([0x5au8; 32])
    }

    /// The Linux key is the documented constant, DERIVED not transcribed — so a future edit to the
    /// derivation that changes the byte string fails here instead of silently logging users out.
    #[test]
    fn known_answer_linux_key_derivation() {
        assert_eq!(
            hex(&linux::LINUX_V10_KEY),
            "fd621fe5a2b402539dfa147ca9272778"
        );
        assert_eq!(
            hex(&linux::LINUX_LEGACY_EMPTY_KEY),
            "d0d0ec9c7d77d43ac54187fa4818d17f"
        );
    }

    /// AES-128-CBC value layout: `v10 ‖ CBC(key, IV=16×0x20, PKCS7)`. Fixed IV + fixed Linux key ⇒
    /// deterministic ciphertext, so the exact bytes are pinned — a format regression fails here, not
    /// in the field. Computed once against the RustCrypto primitives and frozen.
    #[test]
    fn known_answer_aes128cbc_value() {
        let sealed = encrypt_value(&cbc_key(), b"hello-cookie").unwrap();
        assert_eq!(
            hex(&sealed),
            "76313005f5608cad46e8079a9cf268dbb57729",
            "AES-128-CBC v10 value layout drifted"
        );
    }

    /// The behavioural assertion for CBC: decrypt reverses encrypt, and the fixed IV makes it
    /// deterministic (identical plaintext ⇒ identical ciphertext, which is what lets the ledger dedup).
    #[test]
    fn aes128cbc_round_trips_and_is_deterministic() {
        let key = cbc_key();
        let a = encrypt_value(&key, b"session=abc123").unwrap();
        let b = encrypt_value(&key, b"session=abc123").unwrap();
        assert_eq!(a, b, "fixed IV + fixed key must be deterministic");
        let keyring = InjectedKeyring::single(cbc_key());
        assert_eq!(decrypt_value(&keyring, &a).unwrap(), b"session=abc123");
    }

    /// AES-256-GCM value layout: `v10 ‖ nonce(12) ‖ ct ‖ tag(16)`, non-deterministic nonce, round-trip.
    #[test]
    fn known_answer_aes256gcm_value() {
        let key = gcm_key();
        let sealed = encrypt_value(&key, b"hello-cookie").unwrap();
        assert_eq!(&sealed[..3], b"v10");
        // 3 tag + 12 nonce + len(pt)=12 ct + 16 tag = 43
        assert_eq!(sealed.len(), 3 + 12 + 12 + 16);
        let a = encrypt_value(&key, b"x").unwrap();
        let b = encrypt_value(&key, b"x").unwrap();
        assert_ne!(a, b, "GCM nonce must be random per call");
        let keyring = InjectedKeyring::single(gcm_key());
        assert_eq!(decrypt_value(&keyring, &sealed).unwrap(), b"hello-cookie");
    }

    /// The domain-hash oracle: only the right key AND the right host_key are accepted.
    #[test]
    fn cookie_oracle_binds_key_and_host() {
        let keyring = InjectedKeyring::single(cbc_key());
        let sealed = encrypt_cookie_value(&cbc_key(), "1procard.com", b"tok").unwrap();
        assert_eq!(
            decrypt_cookie_value(&keyring, "1procard.com", &sealed).unwrap(),
            b"tok"
        );
        // Same bytes, wrong host_key: the oracle rejects rather than returning a wrong value.
        assert!(decrypt_cookie_value(&keyring, "evil.com", &sealed).is_err());
        // Wrong key: rejected.
        let other = InjectedKeyring::single(OsKey::Aes128Cbc([1u8; 16]));
        assert!(decrypt_cookie_value(&other, "1procard.com", &sealed).is_err());
    }

    /// THE portability proof at the unit level: seal under key A (CBC / Linux), decrypt, re-seal under
    /// key B (GCM / Windows), decrypt under B — the value survives byte-for-byte.
    #[test]
    fn portable_round_trip_cbc_to_gcm() {
        let a = InjectedKeyring::single(cbc_key());
        let sealed_a = encrypt_cookie_value(&cbc_key(), "site.example", b"the-session").unwrap();
        let value = decrypt_cookie_value(&a, "site.example", &sealed_a).unwrap();

        let sealed_b = encrypt_cookie_value(&gcm_key(), "site.example", &value).unwrap();
        let b = InjectedKeyring::single(gcm_key());
        assert_eq!(
            decrypt_cookie_value(&b, "site.example", &sealed_b).unwrap(),
            b"the-session"
        );
    }

    /// v20 is a NAMED hard error, never a generic failure — so a caller can route it to the plaintext
    /// path instead of treating it as corruption that razes the group.
    #[test]
    fn v20_app_bound_is_a_named_error() {
        let keyring = InjectedKeyring::single(cbc_key());
        let err = decrypt_value(&keyring, b"v20\x00\x01\x02").unwrap_err();
        assert!(
            format!("{err:#}").contains("OSCRYPT_APP_BOUND_UNSUPPORTED"),
            "{err:#}"
        );
    }

    /// An empty encrypted cell decrypts to the empty string on every platform — not a failure.
    #[test]
    fn empty_value_is_empty_plaintext() {
        let keyring = InjectedKeyring::single(cbc_key());
        assert_eq!(decrypt_value(&keyring, b"").unwrap(), Vec::<u8>::new());
    }

    /// The unreachable-key signal: a decrypt-only keyring cannot produce an encrypt key.
    #[test]
    fn unreachable_encrypt_key_is_an_error() {
        let keyring = InjectedKeyring::decrypt_only(vec![(TAG_V10, cbc_key())]);
        assert!(keyring.key_for_encrypt().is_err());
        assert!(decrypt_value(&keyring, &encrypt_value(&cbc_key(), b"x").unwrap()).is_ok());
    }

    #[test]
    fn mock_keychain_flag_is_only_allowed_in_mock_mode() {
        assert!(mock_keychain_flag_allowed(OscryptMode::Mock));
        assert!(!mock_keychain_flag_allowed(OscryptMode::Keychain));
        assert!(!mock_keychain_flag_allowed(OscryptMode::PendingMigration));
    }

    #[test]
    fn mock_keychain_guard_refuses_the_logout_traps() {
        // The flag for a keychain profile: refused (the classic logout).
        assert!(guard_mock_keychain(OscryptMode::Keychain, true, false).is_err());
        // The flag for a pending-migration profile: refused.
        assert!(guard_mock_keychain(OscryptMode::PendingMigration, true, false).is_err());
        // Flipping to mock while real ciphertext remains: refused.
        assert!(guard_mock_keychain(OscryptMode::Mock, false, true).is_err());
        // The one legal shape: mock mode, flag requested, no real ciphertext left.
        assert!(guard_mock_keychain(OscryptMode::Mock, true, false).is_ok());
        // A keychain profile that is NOT being given the flag is fine.
        assert!(guard_mock_keychain(OscryptMode::Keychain, false, false).is_ok());
    }

    fn hex(b: &[u8]) -> String {
        b.iter().map(|x| format!("{x:02x}")).collect()
    }
}
