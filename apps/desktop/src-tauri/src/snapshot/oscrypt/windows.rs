//! Windows OSCrypt v10 key custody.
//!
//! The 32-byte AES-256-GCM key lives in `Local State` JSON at `os_crypt.encrypted_key` as
//! `base64("DPAPI" ‖ CryptProtectData(rawKey))`. `CryptProtectData`/`CryptUnprotectData` with no
//! entropy bind the blob to the CURRENT USER (no app binding for v10), so our own process — running
//! as that user — both unwraps an existing key and creates one for a fresh user-data-dir. App-Bound
//! (`v20`) is structurally unreachable for our per-user + `--user-data-dir` install and is never read
//! or written; a `v20` value is [`super::split_tag`]'s named `OSCRYPT_APP_BOUND_UNSUPPORTED` error.
//!
//! This file is `#[cfg(windows)]`: the DPAPI FFI cannot link on Linux. The v10 GCM VALUE format
//! (`"v10" ‖ nonce(12) ‖ ct ‖ tag(16)`, empty AAD) it hands the codec is exercised cfg-independently
//! by the `known_answer_aes256gcm_value` and `portable_round_trip_cbc_to_gcm` tests in [`super`],
//! with a 32-byte key injected in place of the DPAPI unwrap — so the arithmetic is proven on Linux and
//! only the key-custody plumbing is Windows-only.

use std::ffi::c_void;
use std::path::Path;

use anyhow::{bail, Context, Result};
use base64::Engine;
use zeroize::Zeroize;

use crate::snapshot::oscrypt::{OsCryptKeyring, OsKey, TAG_V10};

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

/// Local State pref path and the 5-byte header Chromium prepends before base64-encoding.
const OS_CRYPT_KEY_PREF: &str = "encrypted_key";
const DPAPI_PREFIX: &[u8] = b"DPAPI";
const AES256_KEY_LEN: usize = 32;

pub struct WindowsKeyring {
    key: [u8; AES256_KEY_LEN],
}

impl Drop for WindowsKeyring {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

impl WindowsKeyring {
    /// Resolve the key for `local_state`. When the pref is absent and `allow_create` is set (restore
    /// into a brand-new user-data-dir), a fresh key is generated, DPAPI-wrapped and written back
    /// atomically. A present-but-MALFORMED key is never overwritten — that matches Chromium's own
    /// `Init`, which returns false on `kInvalidKeyFormat` without regenerating, so we do not clobber a
    /// key an engine might still recover.
    pub fn open(local_state: &Path, allow_create: bool) -> Result<Self> {
        let mut root = read_local_state(local_state)?;
        let existing = root
            .get("os_crypt")
            .and_then(|o| o.get(OS_CRYPT_KEY_PREF))
            .and_then(|v| v.as_str());

        match existing {
            Some(b64) => {
                let key = unwrap_key_from_pref(b64)?;
                Ok(Self { key })
            }
            None => {
                if !allow_create {
                    bail!(
                        "os_crypt.encrypted_key is absent from {} and key creation was not requested \
                         — there is nothing to decrypt",
                        local_state.display()
                    );
                }
                let mut raw = [0u8; AES256_KEY_LEN];
                use aes_gcm::aead::rand_core::RngCore;
                aes_gcm::aead::OsRng.fill_bytes(&mut raw);
                let pref = wrap_key_to_pref(&raw)?;
                set_os_crypt_key(&mut root, &pref);
                write_local_state_atomic(local_state, &root)?;
                Ok(Self { key: raw })
            }
        }
    }
}

impl OsCryptKeyring for WindowsKeyring {
    fn keys_for_decrypt(&self) -> Vec<(&'static str, OsKey)> {
        vec![(TAG_V10, OsKey::Aes256Gcm(self.key))]
    }

    fn key_for_encrypt(&self) -> Result<OsKey> {
        Ok(OsKey::Aes256Gcm(self.key))
    }
}

fn read_local_state(path: &Path) -> Result<serde_json::Value> {
    let bytes = std::fs::read(path)
        .with_context(|| format!("reading Local State at {}", path.display()))?;
    serde_json::from_slice(&bytes).with_context(|| format!("{} is not valid JSON", path.display()))
}

/// base64-decode, require and strip the `"DPAPI"` prefix, `CryptUnprotectData`, and require exactly
/// 32 bytes out (`kInvalidKeyLength` otherwise — a wrong-length key is a hard error, never truncated
/// or padded into use).
fn unwrap_key_from_pref(b64: &str) -> Result<[u8; AES256_KEY_LEN]> {
    let mut blob = base64::engine::general_purpose::STANDARD
        .decode(b64.as_bytes())
        .context("os_crypt.encrypted_key is not valid base64")?;
    if !blob.starts_with(DPAPI_PREFIX) {
        blob.zeroize();
        bail!("os_crypt.encrypted_key is missing its DPAPI prefix (kInvalidKeyFormat)");
    }
    let wrapped = &blob[DPAPI_PREFIX.len()..];
    let mut raw = dpapi_unprotect(wrapped).context("CryptUnprotectData on the OSCrypt key")?;
    let result = if raw.len() == AES256_KEY_LEN {
        let mut key = [0u8; AES256_KEY_LEN];
        key.copy_from_slice(&raw);
        Ok(key)
    } else {
        bail!(
            "OSCrypt key unwrapped to {} bytes, expected {AES256_KEY_LEN} (kInvalidKeyLength)",
            raw.len()
        )
    };
    raw.zeroize();
    blob.zeroize();
    result
}

/// `base64("DPAPI" ‖ CryptProtectData(rawKey))` — exactly the shape `EncryptAndStoreKey` writes, so a
/// subsequently launched engine reads our key with no distinction from one it made itself.
fn wrap_key_to_pref(raw: &[u8; AES256_KEY_LEN]) -> Result<String> {
    let mut wrapped = dpapi_protect(raw).context("CryptProtectData on a fresh OSCrypt key")?;
    let mut blob = DPAPI_PREFIX.to_vec();
    blob.extend_from_slice(&wrapped);
    let b64 = base64::engine::general_purpose::STANDARD.encode(&blob);
    wrapped.zeroize();
    blob.zeroize();
    Ok(b64)
}

fn set_os_crypt_key(root: &mut serde_json::Value, pref_b64: &str) {
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
/// key (mirrors Chromium's own `ImportantFileWriter`).
fn write_local_state_atomic(path: &Path, root: &serde_json::Value) -> Result<()> {
    let bytes = serde_json::to_vec(root).context("serializing Local State")?;
    let tmp = path.with_extension("lobster-tmp");
    std::fs::write(&tmp, &bytes).with_context(|| format!("writing {}", tmp.display()))?;
    std::fs::rename(&tmp, path)
        .with_context(|| format!("renaming {} -> {}", tmp.display(), path.display()))?;
    Ok(())
}

// --- DPAPI FFI -----------------------------------------------------------------------------------

fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>> {
    dpapi_call(data, /* protect = */ true)
}

fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>> {
    dpapi_call(data, /* protect = */ false)
}

/// One FFI path for both directions. `pOptionalEntropy = null` keeps the blob bound to the user only
/// (no app entropy), which is what lets our process interoperate with the engine's key. The output
/// blob is LocalAlloc'd by the API and freed with `LocalFree` after it is copied out.
fn dpapi_call(data: &[u8], protect: bool) -> Result<Vec<u8>> {
    // SAFETY: `in_blob` points at `data` for the duration of the call only; `out_blob` is
    // zero-initialised and written by the API, and its `pbData` is freed with `LocalFree` before we
    // return. No pointer outlives this function.
    unsafe {
        let in_blob = CRYPT_INTEGER_BLOB {
            cbData: data.len() as u32,
            pbData: data.as_ptr() as *mut u8,
        };
        let mut out_blob = CRYPT_INTEGER_BLOB {
            cbData: 0,
            pbData: std::ptr::null_mut(),
        };
        // The middle three parameters (optional entropy, reserved, prompt struct) are all `*const` and
        // passed null; the description parameter differs by direction — a `*const u16` (PCWSTR) on
        // protect, a `*mut PWSTR` out-parameter on unprotect — so it is the one spelled per branch.
        let entropy: *const CRYPT_INTEGER_BLOB = std::ptr::null();
        let reserved: *const c_void = std::ptr::null();
        let prompt = std::ptr::null();
        let ok = if protect {
            CryptProtectData(
                &in_blob,
                std::ptr::null(),
                entropy,
                reserved,
                prompt,
                0,
                &mut out_blob,
            )
        } else {
            CryptUnprotectData(
                &in_blob,
                std::ptr::null_mut(),
                entropy,
                reserved,
                prompt,
                0,
                &mut out_blob,
            )
        };
        if ok == 0 || out_blob.pbData.is_null() {
            bail!(
                "DPAPI {} failed",
                if protect {
                    "CryptProtectData"
                } else {
                    "CryptUnprotectData"
                }
            );
        }
        let out = std::slice::from_raw_parts(out_blob.pbData, out_blob.cbData as usize).to_vec();
        // LocalFree the API-allocated output buffer; its return is only diagnostic and there is
        // nothing actionable on failure, so the copied bytes are returned regardless.
        LocalFree(out_blob.pbData as *mut c_void);
        Ok(out)
    }
}
