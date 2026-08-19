//! SEC-2 Local Store Key (LSK) persistence via OS keychain with file fallback.
//!
//! Primary path: `keyring` crate (Linux Secret Service, macOS Keychain, Windows Credential
//! Manager). When no backend is available (headless CI / missing libsecret), fall back to the
//! existing 0600 `secrets.key` file so SEC-12 keeps working.
//!
//! On first successful keychain write we still keep a file copy for migration/recovery; the
//! keychain entry is authoritative when present.
//!
//! THE FILE COPY IS THE WEAKEST LINK, so it is not stored in the clear where the OS can do better.
//! The LSK decrypts every at-rest secret (proxy credentials, imported cookies) and it sits in the
//! same directory as `profiles.sqlite` — a plaintext copy would mean a backup, a synced folder or a
//! lifted app-data directory hands over the data it protects, whether or not the keychain also holds
//! the key. On Windows the copy is DPAPI-wrapped, which binds it to the current user account on this
//! machine: a copied directory is inert. On Unix the 0600 mode is the whole boundary the platform
//! offers here — a same-user reader still gets the key, which is why the keychain, not the file, is
//! the protection this module claims.

use std::path::Path;

use aes_gcm::aead::rand_core::RngCore;
use aes_gcm::aead::OsRng;
use anyhow::{anyhow, Context, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use keyring::Entry;

const SERVICE: &str = "com.lobster.browser";
const ACCOUNT: &str = "local-store-key";

/// Marks a key file whose bytes are an OS-wrapped blob rather than the raw 32 bytes. Spelled the way
/// Chromium spells its own DPAPI-wrapped key so the shape is recognisable in a hex dump.
const WRAPPED_PREFIX: &[u8] = b"DPAPI";

/// Where the LSK was loaded from (for diagnostics / UI).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum LskSource {
    Keychain,
    File,
    Generated,
}

/// Load or create the 32-byte Local Store Key.
///
/// Order: keychain → file → generate (write keychain if possible, always write file).
pub fn load_or_create_lsk(file_path: &Path) -> Result<([u8; 32], LskSource)> {
    if let Some(key) = try_load_keychain()? {
        // Keep the file in sync so a later keychain outage can still unlock.
        let _ = write_file_key(file_path, &key);
        return Ok((key, LskSource::Keychain));
    }

    if let Some(key) = try_load_file(file_path)? {
        // Best-effort promote into the keychain.
        let _ = try_store_keychain(&key);
        // Rewrite it too, which is what migrates a key file written before the copy was wrapped.
        let _ = write_file_key(file_path, &key);
        return Ok((key, LskSource::File));
    }

    let mut key = [0u8; 32];
    OsRng.fill_bytes(&mut key);
    write_file_key(file_path, &key)?;
    let source = if try_store_keychain(&key).unwrap_or(false) {
        LskSource::Keychain
    } else {
        LskSource::Generated
    };
    Ok((key, source))
}

fn try_load_keychain() -> Result<Option<[u8; 32]>> {
    let entry = match Entry::new(SERVICE, ACCOUNT) {
        Ok(e) => e,
        Err(err) => {
            tracing::debug!(%err, "keychain Entry::new unavailable; using file fallback");
            return Ok(None);
        }
    };
    match entry.get_password() {
        Ok(secret) => {
            let bytes = BASE64
                .decode(secret.trim())
                .context("keychain LSK is not valid base64")?;
            let key: [u8; 32] = bytes
                .as_slice()
                .try_into()
                .map_err(|_| anyhow!("keychain LSK must be 32 bytes"))?;
            Ok(Some(key))
        }
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(err) => {
            tracing::debug!(%err, "keychain get_password failed; using file fallback");
            Ok(None)
        }
    }
}

fn try_store_keychain(key: &[u8; 32]) -> Result<bool> {
    let entry = match Entry::new(SERVICE, ACCOUNT) {
        Ok(e) => e,
        Err(err) => {
            tracing::debug!(%err, "keychain Entry::new unavailable; not storing LSK");
            return Ok(false);
        }
    };
    match entry.set_password(&BASE64.encode(key)) {
        Ok(()) => Ok(true),
        Err(err) => {
            tracing::debug!(%err, "keychain set_password failed; file remains authoritative");
            Ok(false)
        }
    }
}

fn try_load_file(path: &Path) -> Result<Option<[u8; 32]>> {
    // Only an ABSENT file means "first run, generate a key". A file that EXISTS but is unreadable or
    // corrupt must FAIL LOUD — silently rotating the key here would make every existing encrypted secret
    // (proxy credentials, cookies) permanently undecryptable. (When the OS keychain holds the key, the
    // caller resolves it first and rewrites this file, so this error path is only reached when the
    // keychain is unavailable AND the file is damaged — exactly the unrecoverable case.)
    let contents = match std::fs::read_to_string(path) {
        Ok(c) => c,
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(err) => {
            return Err(anyhow!(err).context(format!(
                "cannot read secrets key file {} — refusing to rotate the key",
                path.display()
            )));
        }
    };
    let stored = BASE64.decode(contents.trim()).map_err(|_| {
        anyhow!(
            "secrets key file {} is corrupt (invalid base64). Refusing to rotate the key, which would \
             make existing encrypted secrets undecryptable. Restore it from backup, or delete it to \
             start fresh (existing encrypted secrets will be lost).",
            path.display()
        )
    })?;
    let bytes = unseal_file_key(stored, path)?;
    <[u8; 32]>::try_from(bytes.as_slice()).map(Some).map_err(|_| {
        anyhow!(
            "secrets key file {} has the wrong length ({} bytes, expected 32). Refusing to rotate the \
             key. Restore it from backup, or delete it to start fresh.",
            path.display(),
            bytes.len()
        )
    })
}

/// The bytes that actually land in the key file: the raw key where the OS offers nothing better, and
/// `"DPAPI" ‖ CryptProtectData(key)` on Windows, which binds the copy to the current user account on
/// this machine. A wrapping failure is logged rather than fatal — the fallback exists for
/// availability, and a key file that cannot be written at all is worse than one that is merely as
/// exposed as the directory holding it.
fn seal_file_key(key: &[u8; 32]) -> Vec<u8> {
    match wrap_os(key) {
        Some(blob) => {
            let mut out = WRAPPED_PREFIX.to_vec();
            out.extend_from_slice(&blob);
            out
        }
        None => key.to_vec(),
    }
}

/// Undo [`seal_file_key`]. A file written before the copy was wrapped is the raw 32 bytes and is
/// accepted unchanged, so an existing install keeps opening and is migrated on the next write.
fn unseal_file_key(stored: Vec<u8>, path: &Path) -> Result<Vec<u8>> {
    if stored.len() == 32 || !stored.starts_with(WRAPPED_PREFIX) {
        return Ok(stored);
    }
    unwrap_os(&stored[WRAPPED_PREFIX.len()..], path)
}

#[cfg(windows)]
fn wrap_os(key: &[u8; 32]) -> Option<Vec<u8>> {
    match crate::snapshot::oscrypt::windows::dpapi_protect(key) {
        Ok(blob) => Some(blob),
        Err(err) => {
            tracing::warn!(%err, "DPAPI could not wrap the local store key file copy");
            None
        }
    }
}

#[cfg(not(windows))]
fn wrap_os(_key: &[u8; 32]) -> Option<Vec<u8>> {
    None
}

#[cfg(windows)]
fn unwrap_os(blob: &[u8], path: &Path) -> Result<Vec<u8>> {
    crate::snapshot::oscrypt::windows::dpapi_unprotect(blob).with_context(|| {
        format!(
            "secrets key file {} is sealed to a different Windows user or machine. Refusing to \
             rotate the key, which would make existing encrypted secrets undecryptable. Sign in as \
             the user that created it, or delete it to start fresh (existing encrypted secrets will \
             be lost).",
            path.display()
        )
    })
}

#[cfg(not(windows))]
fn unwrap_os(_blob: &[u8], path: &Path) -> Result<Vec<u8>> {
    anyhow::bail!(
        "secrets key file {} was sealed on Windows and cannot be opened on this OS. Import the \
         profile from an exported profile file instead of copying the app data directory.",
        path.display()
    )
}

fn write_file_key(path: &Path, key: &[u8; 32]) -> Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let encoded = BASE64.encode(seal_file_key(key));
    // Atomic + private write: create a sibling temp file with 0o600 FROM THE START (never a window with
    // default-umask permissions), write + fsync it, then rename over the target. A crash mid-write can
    // therefore never truncate/corrupt the real key file, and the key is never briefly world-readable.
    let tmp = path.with_extension("key.tmp");
    {
        let mut opts = std::fs::OpenOptions::new();
        opts.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&tmp)?;
        use std::io::Write;
        f.write_all(encoded.as_bytes())?;
        f.sync_all()?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&tmp, std::fs::Permissions::from_mode(0o600))?;
    }
    std::fs::rename(&tmp, path)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn file_round_trip_when_keychain_optional() {
        let dir = std::env::temp_dir().join(format!("lobster-lsk-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.key");

        let (key1, _src1) = load_or_create_lsk(&path).unwrap();
        let (key2, src2) = load_or_create_lsk(&path).unwrap();
        assert_eq!(key1, key2);
        assert!(matches!(src2, LskSource::Keychain | LskSource::File));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o600);
        }
        let _ = std::fs::remove_dir_all(dir);
    }

    /// Whatever the platform wraps the copy with, it has to come back byte-identical — a key that
    /// round-trips wrong is indistinguishable from a corrupt file and strands every stored secret.
    #[test]
    fn the_file_copy_round_trips_through_whatever_the_os_offers() {
        let key = [7u8; 32];
        let sealed = seal_file_key(&key);
        let opened = unseal_file_key(sealed, Path::new("secrets.key")).unwrap();
        assert_eq!(opened, key);
    }

    /// A key file written before the copy was wrapped holds the raw 32 bytes. It must keep opening:
    /// refusing it would make every secret an existing install has already encrypted unreadable.
    #[test]
    fn a_legacy_unwrapped_key_file_still_opens() {
        let dir = std::env::temp_dir().join(format!("lobster-lsk-legacy-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("secrets.key");
        let key = [9u8; 32];
        std::fs::write(&path, BASE64.encode(key)).unwrap();

        assert_eq!(try_load_file(&path).unwrap(), Some(key));
        let _ = std::fs::remove_dir_all(dir);
    }
}
