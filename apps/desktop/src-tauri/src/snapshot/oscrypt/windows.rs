//! Windows OSCrypt v10 key custody: the DPAPI half.
//!
//! `CryptProtectData`/`CryptUnprotectData` with no entropy bind a blob to the CURRENT USER (there is
//! no app binding for v10), so our own process — running as that user — both unwraps an existing key
//! and creates one for a fresh user-data-dir. App-Bound (`v20`) is structurally unreachable for our
//! per-user + `--user-data-dir` install and is never read or written; a `v20` value is
//! [`super::split_tag`]'s named `OSCRYPT_APP_BOUND_UNSUPPORTED` error.
//!
//! This file is `#[cfg(windows)]` because the DPAPI FFI cannot link on Linux, and it holds nothing
//! else for that reason: the `Local State` document, the base64, the `"DPAPI"` prefix and the
//! create-vs-refuse decision are in [`super::local_state`], where this crate's Linux test run
//! exercises them. The v10 GCM VALUE format is likewise cfg-independent and covered by
//! `known_answer_aes256gcm_value` and `portable_round_trip_cbc_to_gcm` in [`super`] with a 32-byte key
//! injected in place of the DPAPI unwrap.

use std::ffi::c_void;
use std::path::Path;

use anyhow::{bail, Result};
use zeroize::Zeroize;

use crate::snapshot::oscrypt::local_state::{self, AES256_KEY_LEN};
use crate::snapshot::oscrypt::{OsCryptKeyring, OsKey, TAG_V10};

use windows_sys::Win32::Foundation::LocalFree;
use windows_sys::Win32::Security::Cryptography::{
    CryptProtectData, CryptUnprotectData, CRYPT_INTEGER_BLOB,
};

pub struct WindowsKeyring {
    key: [u8; AES256_KEY_LEN],
}

impl Drop for WindowsKeyring {
    fn drop(&mut self) {
        self.key.zeroize();
    }
}

impl WindowsKeyring {
    /// Resolve the key for `local_state`, generating one when the pref is absent and `allow_create`
    /// is set (restore into a brand-new user-data-dir). Every rule about what may and may not be
    /// overwritten lives in [`local_state::resolve_key`].
    pub fn open(local_state: &Path, allow_create: bool) -> Result<Self> {
        let key = local_state::resolve_key(
            local_state,
            allow_create,
            |raw| dpapi_protect(raw),
            |wrapped| dpapi_unprotect(wrapped),
            || {
                use aes_gcm::aead::rand_core::RngCore;
                let mut raw = [0u8; AES256_KEY_LEN];
                aes_gcm::aead::OsRng.fill_bytes(&mut raw);
                raw
            },
        )?;
        Ok(Self { key })
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

// --- DPAPI FFI -----------------------------------------------------------------------------------

/// Also used by `keychain` to bind the on-disk Local Store Key copy to the current user. The FFI
/// lives here because this is the only module that may link it, not because OSCrypt owns it.
pub(crate) fn dpapi_protect(data: &[u8]) -> Result<Vec<u8>> {
    dpapi_call(data, /* protect = */ true)
}

pub(crate) fn dpapi_unprotect(data: &[u8]) -> Result<Vec<u8>> {
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
