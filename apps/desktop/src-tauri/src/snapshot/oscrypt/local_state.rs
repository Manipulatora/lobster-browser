//! Windows OSCrypt key custody, with the DPAPI call factored out.
//!
//! The 32-byte AES-256-GCM key lives in `Local State` JSON at `os_crypt.encrypted_key` as
//! `base64("DPAPI" ‖ CryptProtectData(rawKey))`. Everything about that sentence except the
//! `CryptProtectData` is platform-independent — the JSON document, the base64, the five-byte prefix,
//! the key-length rule, the create-vs-refuse decision — and it is where the mistakes are. So it lives
//! here, `#[cfg(windows)]`-free, and [`super::windows`] supplies the two FFI functions.
//!
//! That split is not tidiness. There is no Windows CI runner (see `docs/PROFILE_DATA_SYNC.md`), so
//! anything behind `#[cfg(windows)]` is code nothing has ever executed. The one defect that mattered
//! most was in exactly that region and is exactly the shape a Linux test catches: a **missing**
//! `Local State` was a hard error rather than "there is no key yet, make one". Restoring a profile
//! always writes into a user-data-dir that has never been launched, and a user-data-dir that has
//! never been launched has no `Local State` — so on Windows every import and every first sync
//! resolved no key, wrote its cookies to the plaintext `value` column, and dropped the saved
//! passwords and autofill entirely, reporting success.

use std::path::Path;

use anyhow::{bail, Context, Result};
use base64::Engine;
use zeroize::Zeroize;

/// Pref path and the 5-byte header Chromium prepends before base64-encoding.
pub const OS_CRYPT_KEY_PREF: &str = "encrypted_key";
pub const DPAPI_PREFIX: &[u8] = b"DPAPI";
pub const AES256_KEY_LEN: usize = 32;

/// Read `Local State`, treating an absent file as an empty document.
///
/// ENOENT is the NORMAL state of a user-data-dir a browser has not opened yet, which is every
/// directory a restore writes into. Malformed JSON is a different matter and stays an error: the file
/// is there and says something we do not understand, and overwriting it would destroy whatever it
/// holds.
pub fn read_document(path: &Path) -> Result<serde_json::Value> {
    let bytes = match std::fs::read(path) {
        Ok(bytes) => bytes,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
            return Ok(serde_json::Value::Object(serde_json::Map::new()))
        }
        Err(err) => {
            return Err(err).with_context(|| format!("reading Local State at {}", path.display()))
        }
    };
    if bytes.is_empty() {
        return Ok(serde_json::Value::Object(serde_json::Map::new()));
    }
    serde_json::from_slice(&bytes).with_context(|| format!("{} is not valid JSON", path.display()))
}

pub fn key_pref(root: &serde_json::Value) -> Option<&str> {
    root.get("os_crypt")
        .and_then(|o| o.get(OS_CRYPT_KEY_PREF))
        .and_then(|v| v.as_str())
}

/// base64-decode, require and strip the `"DPAPI"` prefix, unwrap, and require exactly 32 bytes out
/// (`kInvalidKeyLength` otherwise — a wrong-length key is a hard error, never truncated or padded
/// into use).
pub fn decode_key_pref(
    b64: &str,
    unprotect: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<[u8; AES256_KEY_LEN]> {
    let mut blob = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .context("os_crypt.encrypted_key is not valid base64")?;
    if !blob.starts_with(DPAPI_PREFIX) {
        blob.zeroize();
        bail!("os_crypt.encrypted_key is missing its DPAPI prefix (kInvalidKeyFormat)");
    }
    let mut raw = unprotect(&blob[DPAPI_PREFIX.len()..]).context("unwrapping the OSCrypt key")?;
    let result = if raw.len() == AES256_KEY_LEN {
        let mut key = [0u8; AES256_KEY_LEN];
        key.copy_from_slice(&raw);
        Ok(key)
    } else {
        Err(anyhow::anyhow!(
            "OSCrypt key unwrapped to {} bytes, expected {AES256_KEY_LEN} (kInvalidKeyLength)",
            raw.len()
        ))
    };
    raw.zeroize();
    blob.zeroize();
    result
}

/// `base64("DPAPI" ‖ CryptProtectData(rawKey))` — exactly the shape `EncryptAndStoreKey` writes, so a
/// subsequently launched engine reads our key with no distinction from one it made itself.
pub fn encode_key_pref(
    raw: &[u8; AES256_KEY_LEN],
    protect: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
) -> Result<String> {
    let mut wrapped = protect(raw).context("wrapping a fresh OSCrypt key")?;
    let mut blob = DPAPI_PREFIX.to_vec();
    blob.extend_from_slice(&wrapped);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
    wrapped.zeroize();
    blob.zeroize();
    Ok(b64)
}

pub fn set_key_pref(root: &mut serde_json::Value, pref_b64: &str) {
    if !root.is_object() {
        *root = serde_json::Value::Object(serde_json::Map::new());
    }
    let obj = root.as_object_mut().expect("root coerced to object");
    let os_crypt = obj
        .entry("os_crypt")
        .or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()));
    if !os_crypt.is_object() {
        *os_crypt = serde_json::Value::Object(serde_json::Map::new());
    }
    os_crypt.as_object_mut().unwrap().insert(
        OS_CRYPT_KEY_PREF.to_string(),
        serde_json::Value::String(pref_b64.to_string()),
    );
}

/// Temp-then-rename so a crash mid-write cannot leave a half-written Local State that would strand the
/// key (mirrors Chromium's own `ImportantFileWriter`). The parent directory is created if it is
/// missing, which it is for the profile a restore is bringing into existence.
pub fn write_document_atomic(path: &Path, root: &serde_json::Value) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)
            .with_context(|| format!("creating {}", parent.display()))?;
    }
    let bytes = serde_json::to_vec(root).context("serializing Local State")?;
    let tmp = path.with_extension("lobster-tmp");
    std::fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

/// Resolve the key for `local_state`, generating and persisting one when there is none and
/// `allow_create` is set.
///
/// A present-but-MALFORMED key is never overwritten — that matches Chromium's own `Init`, which
/// returns false on `kInvalidKeyFormat` without regenerating, so we do not clobber a key an engine
/// might still recover. An ABSENT one is the opposite case and is created, because there is nothing
/// to lose and refusing is what strands a restored profile.
pub fn resolve_key(
    local_state: &Path,
    allow_create: bool,
    protect: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    unprotect: impl FnOnce(&[u8]) -> Result<Vec<u8>>,
    fresh_key: impl FnOnce() -> [u8; AES256_KEY_LEN],
) -> Result<[u8; AES256_KEY_LEN]> {
    let mut root = read_document(local_state)?;
    if let Some(b64) = key_pref(&root) {
        return decode_key_pref(b64, unprotect);
    }
    if !allow_create {
        bail!(
            "os_crypt.encrypted_key is absent from {} and key creation was not requested — there is \
             nothing to decrypt",
            local_state.display()
        );
    }
    let raw = fresh_key();
    let pref = encode_key_pref(&raw, protect)?;
    set_key_pref(&mut root, &pref);
    write_document_atomic(local_state, &root)?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Stand-ins for the DPAPI pair. Reversible and deterministic, so the tests assert the CUSTODY
    /// logic — the file, the prefix, the length rule — rather than re-testing Windows' own crypto.
    fn fake_protect(data: &[u8]) -> Result<Vec<u8>> {
        let mut out = b"WRAPPED:".to_vec();
        out.extend(data.iter().map(|b| b ^ 0x5a));
        Ok(out)
    }

    fn fake_unprotect(data: &[u8]) -> Result<Vec<u8>> {
        let body = data
            .strip_prefix(b"WRAPPED:".as_slice())
            .ok_or_else(|| anyhow::anyhow!("not wrapped by this user"))?;
        Ok(body.iter().map(|b| b ^ 0x5a).collect())
    }

    fn temp_dir(tag: &str) -> std::path::PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lobster-localstate-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// THE case. A restore writes into a user-data-dir that has never been launched, so there is no
    /// `Local State` at all. Refusing here is what made every Windows import restore its cookies as
    /// plaintext and drop the saved passwords, while reporting success.
    #[test]
    fn a_user_data_dir_that_has_never_launched_gets_a_key_rather_than_an_error() {
        let dir = temp_dir("fresh");
        let local_state = dir.join("Never Launched").join("Local State");
        assert!(!local_state.exists());

        let key = resolve_key(
            &local_state,
            /* allow_create = */ true,
            fake_protect,
            fake_unprotect,
            || [0xabu8; AES256_KEY_LEN],
        )
        .unwrap();
        assert_eq!(key, [0xabu8; AES256_KEY_LEN]);

        // It is persisted in the shape Chromium reads, so the engine launched afterwards uses OUR key
        // rather than making a second one and razing everything sealed under the first.
        assert!(local_state.is_file());
        let reread = resolve_key(&local_state, false, fake_protect, fake_unprotect, || {
            panic!("must not generate a second key")
        })
        .unwrap();
        assert_eq!(reread, key);

        let root: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&local_state).unwrap()).unwrap();
        let stored = key_pref(&root).unwrap();
        let raw = base64::engine::general_purpose::STANDARD
            .decode(stored)
            .unwrap();
        assert!(raw.starts_with(DPAPI_PREFIX), "the DPAPI prefix is missing");

        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A capture has nothing to decrypt when there is no key, and must say so rather than inventing
    /// one — generating a key at capture time would write a `Local State` into a directory we are
    /// only reading.
    #[test]
    fn a_capture_refuses_to_invent_a_key() {
        let dir = temp_dir("nocreate");
        let err = resolve_key(
            &dir.join("Local State"),
            /* allow_create = */ false,
            fake_protect,
            fake_unprotect,
            || panic!("must not generate"),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("nothing to decrypt"), "{err}");
        assert!(!dir.join("Local State").exists());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// An existing `Local State` full of unrelated preferences must keep them: it holds the engine's
    /// whole non-profile configuration, and replacing it with `{"os_crypt":…}` would reset the browser.
    #[test]
    fn adding_a_key_preserves_the_rest_of_the_document() {
        let dir = temp_dir("preserve");
        let local_state = dir.join("Local State");
        std::fs::write(
            &local_state,
            br#"{"profile":{"info_cache":{"Default":{"name":"Person 1"}}},"user_experience_metrics":{"stability":{"exited_cleanly":true}}}"#,
        )
        .unwrap();

        resolve_key(&local_state, true, fake_protect, fake_unprotect, || {
            [0x11u8; AES256_KEY_LEN]
        })
        .unwrap();

        let root: serde_json::Value =
            serde_json::from_slice(&std::fs::read(&local_state).unwrap()).unwrap();
        assert_eq!(root["profile"]["info_cache"]["Default"]["name"], "Person 1");
        assert_eq!(
            root["user_experience_metrics"]["stability"]["exited_cleanly"],
            true
        );
        assert!(key_pref(&root).is_some());
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A key that is present but unreadable is NEVER replaced. Chromium's own `Init` returns false
    /// rather than regenerating, and regenerating is how a jar full of still-decryptable cookies
    /// becomes permanently unreadable.
    #[test]
    fn a_malformed_key_is_refused_and_left_exactly_as_it_was() {
        let dir = temp_dir("malformed");
        for pref in [
            "not base64 at all !!!",
            // Valid base64, no DPAPI prefix.
            &base64::engine::general_purpose::STANDARD.encode(b"NOPREFIXjustbytes"),
            // Correct prefix, wrong key length out.
            &base64::engine::general_purpose::STANDARD
                .encode([DPAPI_PREFIX, &fake_protect(b"short").unwrap()].concat()),
        ] {
            let local_state = dir.join(format!("Local State {}", uuid::Uuid::new_v4()));
            let document = serde_json::json!({ "os_crypt": { OS_CRYPT_KEY_PREF: pref } });
            std::fs::write(&local_state, serde_json::to_vec(&document).unwrap()).unwrap();
            let before = std::fs::read(&local_state).unwrap();

            assert!(
                resolve_key(&local_state, true, fake_protect, fake_unprotect, || {
                    panic!("must not replace a key that is already there")
                })
                .is_err(),
                "accepted a malformed key pref: {pref}"
            );
            assert_eq!(
                std::fs::read(&local_state).unwrap(),
                before,
                "the file was rewritten despite the refusal"
            );
        }
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A key wrapped for a DIFFERENT Windows user cannot be unwrapped, and that has to fail rather
    /// than silently produce a key that decrypts nothing.
    #[test]
    fn a_key_wrapped_for_another_user_fails_closed() {
        let dir = temp_dir("otheruser");
        let local_state = dir.join("Local State");
        let foreign = base64::engine::general_purpose::STANDARD
            .encode([DPAPI_PREFIX, b"SOMEONE-ELSES-BLOB"].concat());
        std::fs::write(
            &local_state,
            serde_json::to_vec(&serde_json::json!({ "os_crypt": { OS_CRYPT_KEY_PREF: foreign } }))
                .unwrap(),
        )
        .unwrap();

        assert!(
            resolve_key(&local_state, true, fake_protect, fake_unprotect, || {
                panic!("must not replace it")
            })
            .is_err()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// A document that is not an object at all still ends up with a usable key — a truncated write or
    /// a stray `null` must not make the profile unrecoverable.
    #[test]
    fn a_document_that_is_not_an_object_is_replaced_rather_than_fatal() {
        let dir = temp_dir("notobject");
        let local_state = dir.join("Local State");
        std::fs::write(&local_state, b"null").unwrap();

        let key = resolve_key(&local_state, true, fake_protect, fake_unprotect, || {
            [0x22u8; AES256_KEY_LEN]
        })
        .unwrap();
        assert_eq!(key, [0x22u8; AES256_KEY_LEN]);
        assert!(
            key_pref(&serde_json::from_slice(&std::fs::read(&local_state).unwrap()).unwrap())
                .is_some()
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The wrapped key round-trips through the exact encoding Chromium uses, so a key we write is a
    /// key the engine reads.
    #[test]
    fn the_key_pref_round_trips_through_the_chromium_encoding() {
        let raw = [0x3cu8; AES256_KEY_LEN];
        let pref = encode_key_pref(&raw, fake_protect).unwrap();
        assert_eq!(decode_key_pref(&pref, fake_unprotect).unwrap(), raw);
    }
}
