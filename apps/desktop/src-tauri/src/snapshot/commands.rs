//! Tauri commands for the local snapshot ledger.
//!
//! These take NO key material and return NO plaintext artifact bytes — the key never crosses the IPC
//! boundary in either direction, and the WebView only ever sees manifests and reports. That is the
//! opposite of `encrypt_profile_blob`/`decrypt_profile_blob`, which took a content key as a hex string
//! from the renderer and were therefore unusable as designed: wiring them up would have put a
//! team-wide key in renderer JavaScript on every sync.
//!
//! Capture deliberately does not verify the per-profile launch password and does not look at the
//! profile's status. A password the user has forgotten, or a profile that cannot launch, must not be
//! what stands between them and their own session data — those two gates are exactly why an
//! unlaunchable profile is unrecoverable today.

use std::path::PathBuf;

use serde::Serialize;
use tauri::State;

use super::manifest::{digest_hex, CaptureMode, Identity, SnapshotManifest};
use super::vault::SnapshotVault;
use super::{CaptureOptions, RestoreReport, VerifyReport};
use crate::AppState;

/// The app-data directory, derived from the profiles root the app already resolved.
///
/// `AppState` carries `profiles_dir` (`<app_data>/profiles`) and not the app-data directory itself, so
/// this steps up one level rather than resolving the OS path a second time — two independent
/// resolutions could disagree, and the ledger must sit beside the `secrets.key` whose LSK encrypts it.
fn app_data_dir(state: &AppState) -> Result<PathBuf, String> {
    state
        .profiles_dir
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "profiles directory has no parent; cannot locate the snapshot ledger".into())
}

fn open_vault(state: &AppState) -> Result<SnapshotVault, String> {
    SnapshotVault::open(&app_data_dir(state)?).map_err(|e| format!("{e:#}"))
}

fn parse_mode(mode: &str) -> Result<CaptureMode, String> {
    match mode {
        "quiesced" => Ok(CaptureMode::Quiesced),
        "live" => Ok(CaptureMode::Live),
        "dirty" => Ok(CaptureMode::Dirty),
        other => Err(format!(
            "unknown capture mode `{other}`; expected quiesced, live or dirty"
        )),
    }
}

/// One row of the snapshots panel.
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotSummary {
    pub version: u64,
    pub captured_at: String,
    pub capture_mode: CaptureMode,
    /// `quiesced` | `tight` | `loose` | `dirty`. The UI defaults to the newest QUIESCED snapshot over a
    /// newer loose one, because a cookie and the localStorage token that authenticates it, captured
    /// seconds apart, are a half session a site can read as a hijack signal.
    pub coherence: String,
    pub coherence_window_ms: u64,
    pub artifact_count: usize,
    pub total_bytes: u64,
    pub absent: Vec<String>,
    pub skipped: Vec<(String, String)>,
}

#[tauri::command]
pub fn snapshot_list(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<Vec<SnapshotSummary>, String> {
    let vault = open_vault(&state)?;
    let mut out = Vec::new();
    for version in vault.versions(&profile_id).map_err(|e| format!("{e:#}"))? {
        // A version whose manifest will not decrypt on this install must not hide the ones that will:
        // the list is how a user discovers a snapshot exists at all.
        match vault.manifest(&profile_id, version) {
            Ok(manifest) => out.push(SnapshotSummary {
                version: manifest.version,
                captured_at: manifest.captured_at.clone(),
                capture_mode: manifest.capture_mode,
                coherence: manifest.coherence.label.clone(),
                coherence_window_ms: manifest.coherence.window_ms,
                artifact_count: manifest.artifacts.len(),
                total_bytes: manifest.artifacts.iter().map(|a| a.sealed_bytes).sum(),
                absent: manifest.absent.clone(),
                skipped: manifest.skipped.clone(),
            }),
            Err(err) => tracing::warn!(
                %profile_id, version, error = %format!("{err:#}"),
                "skipping unreadable snapshot in list"
            ),
        }
    }
    out.reverse();
    Ok(out)
}

/// Build the snapshot's [`Identity`] from the PROFILE ROW.
///
/// The row is the authority, not the user-data-dir: `writeLobiumConfig` rewrites `lobium-fp.json`
/// from the row's seed, overrides and proxy on every launch, so anything the snapshot copied out of
/// the directory would be overwritten before the browser read it.
///
/// The overrides are digested rather than stored: the manifest then proves the persona is the same
/// one without carrying persona detail, and the comparison is still exact. `proxy_endpoint` is
/// host:port only — never the credentials, which the row holds encrypted and which have no business
/// in a manifest.
fn identity_of(state: &State<'_, AppState>, profile_id: &str) -> Result<Identity, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    let profile = crate::profile_store::get(&conn, &state.cipher, profile_id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("profile {profile_id} not found"))?;

    let overrides_digest = profile.fingerprint_overrides.as_ref().map(|value| {
        // Serialized through serde_json, whose Value is a BTreeMap-backed map in this build's
        // feature set, so key order is stable and the digest is comparable across machines.
        digest_hex(serde_json::to_string(value).unwrap_or_default().as_bytes())
    });

    let proxy_endpoint = profile.proxy.as_ref().and_then(|proxy| {
        let host = proxy.get("host").and_then(|v| v.as_str())?;
        let port = proxy.get("port").and_then(|v| v.as_u64())?;
        Some(format!("{host}:{port}"))
    });

    Ok(Identity {
        engine: profile.engine,
        os: profile.os,
        os_version: profile.os_version,
        fingerprint_seed: profile.fingerprint_seed,
        fingerprint_overrides_digest: overrides_digest,
        // Presence, not the endpoint, is what drives the WebRTC policy — see Identity's docs.
        proxy_present: profile.proxy.is_some() || profile.proxy_id.is_some(),
        proxy_endpoint,
        engine_build: None,
    })
}

#[tauri::command]
pub fn snapshot_capture(
    state: State<'_, AppState>,
    profile_id: String,
    mode: Option<String>,
    options: Option<CaptureOptions>,
) -> Result<SnapshotManifest, String> {
    let vault = open_vault(&state)?;
    let udd = state.profiles_dir.join(&profile_id);
    let identity = identity_of(&state, &profile_id)?;
    super::capture(
        &vault,
        &udd,
        &profile_id,
        parse_mode(mode.as_deref().unwrap_or("quiesced"))?,
        &identity,
        &options.unwrap_or_default(),
    )
    .map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn snapshot_restore(
    state: State<'_, AppState>,
    profile_id: String,
    version: Option<u64>,
    force: bool,
) -> Result<RestoreReport, String> {
    let vault = open_vault(&state)?;
    let version = match version {
        Some(version) => version,
        None => vault
            .latest_version(&profile_id)
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| format!("profile {profile_id} has no snapshots to restore"))?,
    };
    let udd = state.profiles_dir.join(&profile_id);
    // Refuse to write into a directory a browser still owns. Restoring under a live Chromium would
    // have it holding file handles to databases we have just renamed away, and the first thing it
    // writes puts the profile into a state neither the snapshot nor the previous contents describe.
    match super::sqlite_copy::assert_no_live_owner(&udd).map_err(|e| format!("{e:#}"))? {
        super::sqlite_copy::LiveOwner::None => {}
        super::sqlite_copy::LiveOwner::Alive { detail } => {
            return Err(format!(
                "PROFILE_IS_RUNNING: cannot restore into {profile_id} while it is open — {detail}. \
                 Stop the profile and try again."
            ))
        }
        super::sqlite_copy::LiveOwner::Unknown { detail } => {
            return Err(format!(
                "PROFILE_OWNER_UNKNOWN: cannot prove {profile_id} is stopped — {detail}. Stop the \
                 profile from the UI, or remove the stale lock files, before restoring."
            ))
        }
    }
    let target = identity_of(&state, &profile_id)?;
    super::restore(&vault, &udd, &profile_id, version, &target, force).map_err(|e| format!("{e:#}"))
}

#[tauri::command]
pub fn snapshot_verify(
    state: State<'_, AppState>,
    profile_id: String,
    version: Option<u64>,
) -> Result<VerifyReport, String> {
    let vault = open_vault(&state)?;
    let version = match version {
        Some(version) => version,
        None => vault
            .latest_version(&profile_id)
            .map_err(|e| format!("{e:#}"))?
            .ok_or_else(|| format!("profile {profile_id} has no snapshots to verify"))?,
    };
    super::verify(&vault, &profile_id, version).map_err(|e| format!("{e:#}"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn capture_modes_parse_and_unknown_modes_are_named() {
        assert_eq!(parse_mode("quiesced").unwrap(), CaptureMode::Quiesced);
        assert_eq!(parse_mode("live").unwrap(), CaptureMode::Live);
        assert_eq!(parse_mode("dirty").unwrap(), CaptureMode::Dirty);
        let err = parse_mode("Quiesced").unwrap_err();
        assert!(err.contains("unknown capture mode"), "{err}");
    }
}

/// The account key for one profile, or a clear reason it is unavailable.
///
/// Separate from the ledger's own key on purpose: the ledger seals with a per-install key so a purely
/// local backup works with no account at all, while sync needs a key another machine can reach. A
/// locked vault is therefore a normal state with a specific remedy, not an error to bubble.
fn profile_keys(
    state: &State<'_, AppState>,
    profile_id: &str,
) -> Result<([u8; 32], [u8; 16]), String> {
    let guard = state.unlocked_vault.lock().map_err(|e| e.to_string())?;
    let vault = guard
        .as_ref()
        .ok_or("the account vault is locked — unlock it with your password to sync")?;
    let key = vault
        .profile_content_key(profile_id)
        .map_err(|e| format!("{e:#}"))?;
    let key_id =
        crate::blob_crypto::derive_key_id(&key, profile_id).map_err(|e| format!("{e:#}"))?;
    Ok((key, key_id))
}

/// Seal the newest local snapshot for the account and upload it.
///
/// `baseVersion` is what the caller believes the server currently holds. A mismatch is a 409 that
/// surfaces as SYNC_CONFLICT rather than an overwrite: the remote snapshot is another machine's
/// session, and last-write-wins would destroy it silently.
#[tauri::command]
pub async fn snapshot_push(
    state: State<'_, AppState>,
    profile_id: String,
    base_version: Option<u64>,
) -> Result<crate::profile_sync::PushOutcome, String> {
    let vault = open_vault(&state)?;
    let (key, key_id) = profile_keys(&state, &profile_id)?;
    crate::profile_sync::push(
        &vault,
        &profile_id,
        &key,
        &key_id,
        base_version.unwrap_or(0),
    )
    .await
    .map_err(|e| format!("{e:#}"))
}

/// Download the account's snapshot into the local ledger as a NEW version.
///
/// Never overwrites a local version, so a pull cannot destroy a capture that has not been uploaded.
#[tauri::command]
pub async fn snapshot_pull(
    state: State<'_, AppState>,
    profile_id: String,
) -> Result<crate::profile_sync::PullOutcome, String> {
    let vault = open_vault(&state)?;
    let (key, _key_id) = profile_keys(&state, &profile_id)?;
    crate::profile_sync::pull(&vault, &profile_id, &key)
        .await
        .map_err(|e| format!("{e:#}"))
}
