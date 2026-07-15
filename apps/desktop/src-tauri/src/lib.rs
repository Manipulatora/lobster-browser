//! Lobster desktop agent — application core (library crate).
//!
//! Responsibilities wired up here:
//!   * initialize structured logging (`tracing`),
//!   * spawn the engine-runner sidecar + serve the local automation API on Tauri's shared async runtime,
//!   * open the local SQLite profile store and expose profile IPC commands to the UI,
//!   * build the Tauri app and register the shell plugin.
//!
//! Engine launch (`launch_profile`/`stop_profile`) drives the shared sidecar via
//! `local_api::start_profile_via_sidecar` — the SAME path the local automation API uses — so the UI
//! Launch button and external automation clients behave identically. See README.md.

mod blob_crypto;
mod engine_provision;
mod keychain;
mod local_api;
mod profile_store;
mod proxy_check;
mod proxy_store;
mod secrets;
mod sidecar;
mod template_store;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

use profile_store::{CreateProfileInput, Profile, UpdateProfilePatch};
use proxy_check::{run_proxy_check, ProxyCheckResult};
use proxy_store::{CreateStoredProxyInput, StoredProxy, UpdateStoredProxyInput};
use secrets::SecretCipher;
use sidecar::SidecarClient;
use template_store::{CreateProfileTemplateInput, ProfileTemplate};

/// Port the local automation API binds to on 127.0.0.1. Loopback-only by design.
const LOCAL_API_PORT: u16 = 53211;

/// Shared desktop state: the local SQLite profile store, the engine-runner sidecar (shared with the
/// local automation API so the UI Launch button and the HTTP API drive the SAME launch path), and the
/// per-profile user-data-dir root. `sidecar` is `None` only if the sidecar failed to spawn at startup.
struct AppState {
    db: Arc<Mutex<rusqlite::Connection>>,
    sidecar: Option<Arc<SidecarClient>>,
    profiles_dir: PathBuf,
    /// SEC-12: per-install AES-256-GCM cipher used by the stores for at-rest secret encryption.
    cipher: Arc<SecretCipher>,
}

/// Returns the desktop agent version, sourced from Cargo at compile time.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// The user-local engine runtime dir (`~/.local/share/lobster/lobium`) where the downloaded engine lives.
fn user_engine_runtime_dir() -> Option<PathBuf> {
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share/lobster/lobium"))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    present: bool,
    runtime_dir: String,
}

/// Whether the Lobium engine is installed. Drives the first-run download gate: the `.deb` ships without
/// the engine (DOWNLOADER distribution model), so a fresh install reports `present: false`.
#[tauri::command]
fn engine_status() -> EngineStatus {
    if let Some(bin) = std::env::var_os("LOBSTER_LOBIUM_BIN") {
        let path = PathBuf::from(&bin);
        if path.is_file() {
            return EngineStatus {
                present: true,
                runtime_dir: path
                    .parent()
                    .map(|p| p.to_string_lossy().into_owned())
                    .unwrap_or_default(),
            };
        }
    }
    let dir = user_engine_runtime_dir().unwrap_or_default();
    EngineStatus {
        present: engine_provision::engine_present(&dir),
        runtime_dir: dir.to_string_lossy().into_owned(),
    }
}

#[derive(Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineDownloadProgress {
    received: u64,
    total: Option<u64>,
}

/// Download + SHA-256 verify + install the Lobium engine (first-run provisioning). Emits
/// `engine-download-progress` events and resolves once the engine is installed and this process is
/// pointed at it (no restart needed).
#[tauri::command]
async fn provision_engine(app: tauri::AppHandle) -> Result<(), String> {
    use tauri::{Emitter, Manager};
    let runtime_dir = user_engine_runtime_dir()
        .ok_or_else(|| "cannot resolve engine runtime dir (no HOME)".to_string())?;
    if engine_provision::engine_present(&runtime_dir) {
        return Ok(());
    }
    let manifest = app
        .path()
        .resource_dir()
        .ok()
        .map(|r| r.join("engine-manifest.json"));
    let source = engine_provision::resolve_source(manifest.as_deref())
        .map_err(|e| format!("no engine source configured: {e:#}"))?;
    let app_for_progress = app.clone();
    engine_provision::provision(&source, &runtime_dir, move |received, total| {
        let _ = app_for_progress.emit(
            "engine-download-progress",
            EngineDownloadProgress { received, total },
        );
    })
    .await
    .map_err(|e| format!("engine provisioning failed: {e:#}"))?;
    // Point the RUNNING process at the freshly installed engine so a launch works without a restart.
    std::env::set_var(
        "LOBSTER_LOBIUM_BIN",
        runtime_dir.join("chrome").to_string_lossy().as_ref(),
    );
    std::env::set_var("LOBSTER_LOBIUM_DIR", runtime_dir.to_string_lossy().as_ref());
    Ok(())
}

#[derive(serde::Deserialize)]
struct FontPackFile {
    path: String,
    families: Vec<String>,
}

#[derive(serde::Deserialize)]
struct FontPackPersona {
    families: Vec<String>,
    #[serde(default, rename = "physicalFamilies")]
    physical_families: Vec<String>,
}

#[derive(serde::Deserialize)]
struct FontPackPersonas {
    windows: FontPackPersona,
    macos: FontPackPersona,
    linux: FontPackPersona,
    android: FontPackPersona,
}

#[derive(serde::Deserialize)]
struct FontPackManifest {
    version: u8,
    files: Vec<FontPackFile>,
    personas: FontPackPersonas,
}

/// Return the complete sourced persona catalog after proving its physical fallback pack is present.
#[tauri::command]
fn list_font_families(app: tauri::AppHandle, os: String) -> Result<Vec<String>, String> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("LOBSTER_FONTS_DIR") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("fonts"));
    }
    let pack = candidates
        .into_iter()
        .find(|path| path.join("font-pack.manifest.json").is_file())
        .ok_or("Lobium open-font pack is not installed")?;
    let bytes = std::fs::read(pack.join("font-pack.manifest.json"))
        .map_err(|error| format!("cannot read font pack manifest: {error}"))?;
    let manifest: FontPackManifest = serde_json::from_slice(&bytes)
        .map_err(|error| format!("invalid font pack manifest: {error}"))?;
    if manifest.version != 1 {
        return Err(format!(
            "unsupported font pack manifest version {}",
            manifest.version
        ));
    }
    let persona = match os.as_str() {
        "windows" => &manifest.personas.windows,
        "macos" | "macos_intel" | "macos_arm" => &manifest.personas.macos,
        "linux" => &manifest.personas.linux,
        "android" => &manifest.personas.android,
        _ => return Err(format!("font packs are unavailable for target {os}")),
    };
    let mut physical = std::collections::HashSet::new();
    for file in &manifest.files {
        let relative = PathBuf::from(&file.path);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Err(format!("unsafe font pack path {}", file.path));
        }
        if pack.join(relative).is_file() {
            physical.extend(file.families.iter().cloned());
        }
    }
    let physical_allowlist = if persona.physical_families.is_empty() {
        &persona.families
    } else {
        &persona.physical_families
    };
    let missing_physical = physical_allowlist
        .iter()
        .filter(|family| !physical.contains(*family))
        .cloned()
        .collect::<Vec<_>>();
    if !missing_physical.is_empty() {
        return Err(format!(
            "font pack is missing physical fallback families for {os}: {}",
            missing_physical.join(", ")
        ));
    }
    let mut families = persona.families.clone();
    families.sort();
    families.dedup();
    if families.is_empty() {
        return Err(format!("font pack has no physical families for {os}"));
    }
    Ok(families)
}

#[tauri::command]
async fn list_profiles(state: State<'_, AppState>) -> Result<Vec<Profile>, String> {
    if let Some(sidecar) = state.sidecar.as_ref() {
        local_api::reconcile_profile_statuses(&state.db, sidecar)
            .await
            .map_err(|e| e.to_string())?;
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::list(&conn, &state.cipher).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_trashed_profiles(state: State<'_, AppState>) -> Result<Vec<Profile>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::list_trashed(&conn, &state.cipher).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_profile(
    state: State<'_, AppState>,
    input: CreateProfileInput,
) -> Result<Profile, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::create(&conn, &state.cipher, input).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_profile(state: State<'_, AppState>, id: String) -> Result<Profile, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::get(&conn, &state.cipher, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("profile {id} not found"))
}

#[tauri::command]
fn update_profile(
    state: State<'_, AppState>,
    id: String,
    patch: UpdateProfilePatch,
) -> Result<Profile, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::update(&conn, &state.cipher, &id, patch)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("profile {id} not found"))
}

#[tauri::command]
async fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(sidecar) = state.sidecar.as_ref() {
        local_api::reconcile_profile_statuses(&state.db, sidecar)
            .await
            .map_err(|e| e.to_string())?;
    }
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if profile_store::delete(&conn, &id).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err(format!("profile {id} not found or is live"))
    }
}

#[tauri::command]
fn restore_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if profile_store::restore(&conn, &id).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err(format!("trashed profile {id} not found"))
    }
}

fn remove_profile_data_dir(profiles_dir: &std::path::Path, id: &str) -> Result<(), String> {
    if !id.starts_with("prf_")
        || !id.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '_' || character == '-'
        })
    {
        return Err("refusing unsafe profile directory identifier".to_string());
    }
    let root = std::fs::canonicalize(profiles_dir).map_err(|e| e.to_string())?;
    let candidate = root.join(id);
    if !candidate.exists() {
        return Ok(());
    }
    let metadata = std::fs::symlink_metadata(&candidate).map_err(|e| e.to_string())?;
    if metadata.file_type().is_symlink() || !metadata.is_dir() {
        return Err("refusing to purge a symlink or non-directory profile path".to_string());
    }
    let canonical = std::fs::canonicalize(&candidate).map_err(|e| e.to_string())?;
    if canonical.parent() != Some(root.as_path()) {
        return Err("refusing profile directory outside the profiles root".to_string());
    }
    std::fs::remove_dir_all(canonical).map_err(|e| e.to_string())
}

#[tauri::command]
async fn permanently_delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    if let Some(sidecar) = state.sidecar.as_ref() {
        local_api::reconcile_profile_statuses(&state.db, sidecar)
            .await
            .map_err(|e| e.to_string())?;
    }
    {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        let profile = profile_store::get_trashed(&conn, &state.cipher, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("trashed profile {id} not found"))?;
        if matches!(
            profile.status.as_str(),
            "launching" | "running" | "stopping"
        ) {
            return Err(format!("profile {id} is live"));
        }
    }
    remove_profile_data_dir(&state.profiles_dir, &id)?;
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if profile_store::purge(&conn, &id).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err(format!("trashed profile {id} not found"))
    }
}

#[tauri::command]
fn set_profile_password(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if profile_store::set_password(&conn, &id, password).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err(format!("profile {id} not found"))
    }
}

#[tauri::command]
fn list_proxies(
    state: State<'_, AppState>,
    source: Option<String>,
) -> Result<Vec<StoredProxy>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    proxy_store::list(&conn, &state.cipher, source.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_proxy(
    state: State<'_, AppState>,
    input: CreateStoredProxyInput,
) -> Result<StoredProxy, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    proxy_store::create(&conn, &state.cipher, input).map_err(|e| e.to_string())
}

#[tauri::command]
fn update_proxy(
    state: State<'_, AppState>,
    id: String,
    patch: UpdateStoredProxyInput,
) -> Result<StoredProxy, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    proxy_store::update(&conn, &state.cipher, &id, patch)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("proxy {id} not found"))
}

#[tauri::command]
fn delete_proxy(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if proxy_store::delete(&conn, &id).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err(format!("proxy {id} not found"))
    }
}

#[tauri::command]
async fn rotate_proxy(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let rotate_url = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        proxy_store::get(&conn, &state.cipher, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("proxy {id} not found"))?
            .rotate_url
            .ok_or_else(|| format!("proxy {id} has no rotation URL"))?
    };
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(20))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .get(&rotate_url)
        .send()
        .await
        .map_err(|e| format!("proxy rotation failed: {e}"))?;
    let status = response.status();
    if !status.is_success() {
        return Err(format!(
            "proxy rotation endpoint returned HTTP {}",
            status.as_u16()
        ));
    }
    Ok(serde_json::json!({
        "proxyId": id,
        "rotatedAt": chrono::Utc::now().to_rfc3339(),
        "status": status.as_u16()
    }))
}

#[tauri::command]
fn list_templates(state: State<'_, AppState>) -> Result<Vec<ProfileTemplate>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    template_store::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_template(
    state: State<'_, AppState>,
    input: CreateProfileTemplateInput,
) -> Result<ProfileTemplate, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    template_store::create(&conn, input).map_err(|e| e.to_string())
}

#[tauri::command]
async fn test_proxy(
    state: State<'_, AppState>,
    id: Option<String>,
    config: serde_json::Value,
) -> Result<ProxyCheckResult, String> {
    let checked_config = if let Some(proxy_id) = id.as_deref() {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        proxy_store::get(&conn, &state.cipher, proxy_id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| format!("proxy {proxy_id} not found"))?
            .config
    } else {
        config
    };
    let result = run_proxy_check(checked_config).await;
    if let Some(id) = id.as_deref() {
        let location = result.geo.as_ref().map(|geo| {
            [
                geo.country_code.as_str(),
                geo.region.as_deref().unwrap_or_default(),
                geo.city.as_deref().unwrap_or_default(),
            ]
            .into_iter()
            .filter(|part| !part.is_empty())
            .collect::<Vec<_>>()
            .join(" · ")
        });
        let timezone = result.geo.as_ref().map(|geo| geo.timezone.clone());
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        proxy_store::update_test_result(
            &conn,
            id,
            result.ok,
            result.latency_ms,
            location,
            timezone,
            result.error.clone(),
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(result)
}

/// Launch a profile's engine via the shared sidecar (same path the local automation API uses) and
/// return its CDP endpoints (`{ profileId, pid, ws, debuggerAddress }`) so the UI can show/connect.
#[tauri::command]
async fn launch_profile(
    state: State<'_, AppState>,
    id: String,
    password: Option<String>,
) -> Result<serde_json::Value, String> {
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    // The desktop Launch button opens the browser headful; a headless toggle is future UI (DSK-13).
    local_api::start_profile_via_sidecar(
        &state.db,
        &state.cipher,
        sidecar,
        &state.profiles_dir,
        &id,
        password.as_deref(),
        false,
    )
    .await
    .map_err(|e| e.to_string())
}

/// SEC-2: encrypt a UTF-8 profile blob payload with a raw 32-byte PCK (hex) into LBv1 base64.
/// Optional `team_data_key_hex` + `profile_id` derive the PCK via HKDF instead of using `pck_hex`.
#[tauri::command]
fn encrypt_profile_blob(
    plaintext_utf8: String,
    pck_hex: Option<String>,
    team_data_key_hex: Option<String>,
    profile_id: Option<String>,
    key_id_hex: Option<String>,
) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;
    use blob_crypto::{derive_key_id, BlobCipher, LB_V1_KEY_ID_LEN};

    let key = resolve_pck(pck_hex, team_data_key_hex.as_deref(), profile_id.as_deref())?;
    let key_id = if let (Some(tdk_hex), Some(pid)) = (team_data_key_hex.as_deref(), profile_id.as_deref())
    {
        let tdk = parse_key32_hex(tdk_hex)?;
        derive_key_id(&tdk, pid).map_err(|e| e.to_string())?
    } else if let Some(hex) = key_id_hex {
        parse_key_id_hex(&hex)?
    } else {
        [0u8; LB_V1_KEY_ID_LEN]
    };
    let cipher = BlobCipher::new(&key);
    let envelope = cipher
        .encrypt(plaintext_utf8.as_bytes(), &key_id)
        .map_err(|e| e.to_string())?;
    Ok(BASE64.encode(envelope))
}

/// SEC-2: decrypt an LBv1 base64 envelope with a raw PCK (hex) or HKDF(TDK, profileId).
#[tauri::command]
fn decrypt_profile_blob(
    envelope_b64: String,
    pck_hex: Option<String>,
    team_data_key_hex: Option<String>,
    profile_id: Option<String>,
) -> Result<String, String> {
    use base64::engine::general_purpose::STANDARD as BASE64;
    use base64::Engine;

    let envelope = BASE64
        .decode(envelope_b64.trim())
        .map_err(|e| format!("invalid envelope base64: {e}"))?;
    let key = resolve_pck(pck_hex, team_data_key_hex.as_deref(), profile_id.as_deref())?;
    let cipher = blob_crypto::BlobCipher::new(&key);
    let (plaintext, _) = cipher.decrypt(&envelope).map_err(|e| e.to_string())?;
    String::from_utf8(plaintext).map_err(|e| format!("decrypted blob is not UTF-8: {e}"))
}

fn parse_key32_hex(hex: &str) -> Result<[u8; 32], String> {
    let bytes = decode_hex(hex.trim())?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| "key must be 32 bytes (64 hex chars)".to_string())
}

fn parse_key_id_hex(hex: &str) -> Result<[u8; 16], String> {
    let bytes = decode_hex(hex.trim())?;
    bytes
        .as_slice()
        .try_into()
        .map_err(|_| "key_id must be 16 bytes (32 hex chars)".to_string())
}

fn decode_hex(hex: &str) -> Result<Vec<u8>, String> {
    if hex.len() % 2 != 0 {
        return Err("hex string must have even length".to_string());
    }
    (0..hex.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&hex[i..i + 2], 16)
                .map_err(|_| format!("invalid hex at offset {i}"))
        })
        .collect()
}

/// Resolve the engine-runner entry script for sidecar spawn (DSK-5/11).
fn resolve_sidecar_js(app: &tauri::AppHandle) -> String {
    if let Ok(path) = std::env::var("LOBSTER_SIDECAR") {
        if !path.is_empty() {
            return path;
        }
    }
    // Packaged resource layouts (self-contained bundle or legacy engine-runner nest).
    if let Ok(resource_dir) = app.path().resource_dir() {
        for rel in [
            "sidecar/index.js",
            "sidecar/engine-runner/index.js",
            "sidecar/engine-runner/dist/index.js",
        ] {
            let packaged = resource_dir.join(rel);
            if packaged.is_file() {
                return packaged.to_string_lossy().into_owned();
            }
        }
    }
    // Dev default: built sidecar in the monorepo.
    std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../packages/engine-runner/dist/index.js")
        .to_string_lossy()
        .into_owned()
}

/// Resolve the Node binary used to run the sidecar (bundled Node preferred over PATH).
fn resolve_node_bin(app: &tauri::AppHandle) -> String {
    if let Ok(path) = std::env::var("LOBSTER_NODE_BIN") {
        if !path.is_empty() && std::path::Path::new(&path).is_file() {
            return path;
        }
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for rel in ["node/bin/node", "node/node"] {
            let packaged = resource_dir.join(rel);
            if packaged.is_file() {
                return packaged.to_string_lossy().into_owned();
            }
        }
    }
    "node".to_string()
}

fn first_font_pack_dir(candidates: impl IntoIterator<Item = PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|dir| dir.join("font-pack.manifest.json").is_file())
}

#[cfg(target_os = "linux")]
fn packaged_runtime_needs_no_sandbox(chrome: &std::path::Path) -> bool {
    chrome.parent().is_some_and(|runtime| {
        runtime.join("LOBSTER_ENGINE.json").is_file()
            && !runtime.join("chrome_sandbox").is_file()
    })
}

#[cfg(target_os = "linux")]
fn packaged_runtime_needs_software_gpu(
    chrome: &std::path::Path,
    host_has_render_node: bool,
) -> bool {
    !host_has_render_node
        && chrome.parent().is_some_and(|runtime| {
            runtime.join("LOBSTER_ENGINE.json").is_file()
                && runtime.join("vk_swiftshader_icd.json").is_file()
                && runtime.join("libvk_swiftshader.so").is_file()
        })
}

#[cfg(target_os = "linux")]
fn host_has_drm_render_node() -> bool {
    std::fs::read_dir("/dev/dri").is_ok_and(|entries| {
        entries.filter_map(Result::ok).any(|entry| {
            entry
                .file_name()
                .to_string_lossy()
                .starts_with("renderD")
        })
    })
}

/// Point the sidecar at the packaged/user-local engine and font resources. These are resolved
/// independently: Linux `.deb` resources contain the font pack while the large Lobium runtime may
/// live in the per-user product installation.
fn ensure_lobium_env(app: &tauri::AppHandle) {
    let resource_dir = app.path().resource_dir().ok();
    let user_runtime = std::env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".local/share/lobster/lobium"));

    if std::env::var_os("LOBSTER_LOBIUM_BIN").is_none() {
        let mut candidates = Vec::new();
        if let Some(resources) = resource_dir.as_ref() {
            candidates.push(resources.join("lobium/chrome"));
            candidates.push(resources.join("engines/lobium/chrome"));
        }
        if let Some(runtime) = user_runtime.as_ref() {
            candidates.push(runtime.join("chrome"));
        }
        if let Some(chrome) = candidates.into_iter().find(|path| path.is_file()) {
            std::env::set_var("LOBSTER_LOBIUM_BIN", chrome.to_string_lossy().as_ref());
            if let Some(parent) = chrome.parent() {
                std::env::set_var("LOBSTER_LOBIUM_DIR", parent.to_string_lossy().as_ref());
            }
        }
    }

    if std::env::var_os("LOBSTER_FONTS_DIR").is_none() {
        let mut candidates = Vec::new();
        if let Some(resources) = resource_dir.as_ref() {
            candidates.push(resources.join("fonts"));
            candidates.push(resources.join("lobium/fonts"));
        }
        if let Some(bin) = std::env::var_os("LOBSTER_LOBIUM_BIN") {
            if let Some(parent) = PathBuf::from(bin).parent() {
                candidates.push(parent.join("fonts"));
            }
        }
        if let Some(runtime) = user_runtime {
            candidates.push(runtime.join("fonts"));
        }
        if let Some(fonts) = first_font_pack_dir(candidates) {
            std::env::set_var("LOBSTER_FONTS_DIR", fonts.to_string_lossy().as_ref());
        }
    }

    // The user-local Linux runtime produced by package-lobium-runtime.sh has an explicit marker but
    // cannot carry a root-owned setuid chrome_sandbox through a normal user copy. Match the wrapper's
    // launch policy automatically for that exact package shape; never relax sandboxing for arbitrary
    // system/user Chromium binaries.
    #[cfg(target_os = "linux")]
    if std::env::var_os("LOBSTER_NO_SANDBOX").is_none() {
        if let Some(chrome) = std::env::var_os("LOBSTER_LOBIUM_BIN").map(PathBuf::from) {
            if packaged_runtime_needs_no_sandbox(&chrome) {
                std::env::set_var("LOBSTER_NO_SANDBOX", "1");
            }
        }
    }

    // Chromium disables WebGL when automatic mode lands on llvmpipe. On a host without a DRM render
    // node, use the runtime's bundled SwiftShader Vulkan driver instead; real-GPU hosts remain auto/GPU.
    #[cfg(target_os = "linux")]
    if std::env::var_os("LOBSTER_GPU").is_none() {
        if let Some(chrome) = std::env::var_os("LOBSTER_LOBIUM_BIN").map(PathBuf::from) {
            if packaged_runtime_needs_software_gpu(&chrome, host_has_drm_render_node()) {
                std::env::set_var("LOBSTER_GPU", "software");
                std::env::set_var("LOBSTER_ALLOW_SOFTWARE_GPU_CALIBRATION", "1");
            }
        }
    }
}

fn resolve_pck(
    pck_hex: Option<String>,
    team_data_key_hex: Option<&str>,
    profile_id: Option<&str>,
) -> Result<[u8; 32], String> {
    if let (Some(tdk_hex), Some(pid)) = (team_data_key_hex, profile_id) {
        let tdk = parse_key32_hex(tdk_hex)?;
        return blob_crypto::derive_profile_content_key(&tdk, pid).map_err(|e| e.to_string());
    }
    let hex = pck_hex.ok_or_else(|| {
        "either pck_hex or (team_data_key_hex + profile_id) is required".to_string()
    })?;
    parse_key32_hex(&hex)
}

#[tauri::command]
async fn stop_profile(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    local_api::stop_profile_via_sidecar(&state.db, sidecar, &id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn export_profile_cookies(state: State<'_, AppState>, id: String) -> Result<String, String> {
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    let result = sidecar
        .call("exportCookies", serde_json::json!({ "profileId": id }))
        .await
        .map_err(|e| e.to_string())?;
    result
        .get("json")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .ok_or_else(|| "sidecar returned an invalid cookie export".to_string())
}

/// Application entrypoint invoked by `main.rs` (and the mobile entry macro later).
pub fn run() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    let mut builder = tauri::Builder::default();
    // DSK-3: single-instance lock. Must be the FIRST registered plugin so a second launch exits
    // before it can contend on the local-API port or the SQLite store; the running instance gets
    // the callback and refocuses its main window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.show();
                let _ = window.unminimize();
                let _ = window.set_focus();
            }
        }));
    }

    builder
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Open the local profile store under the OS app-data dir.
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let conn =
                profile_store::init(dir.join("profiles.sqlite")).map_err(|e| e.to_string())?;
            proxy_store::init(&conn).map_err(|e| e.to_string())?;
            template_store::init(&conn).map_err(|e| e.to_string())?;
            let db = Arc::new(Mutex::new(conn));

            // SEC-12 + SEC-2: load (or generate) the Local Store Key — OS keychain preferred,
            // 0600 secrets.key file as fallback when Secret Service / DPAPI is unavailable.
            let cipher = Arc::new(
                SecretCipher::load_or_create(dir.join("secrets.key")).map_err(|e| e.to_string())?,
            );

            let profiles_dir = dir.join("profiles");
            std::fs::create_dir_all(&profiles_dir).map_err(|e| e.to_string())?;
            // Provision a loopback API key so the local automation API is AUTHENTICATED by default (the
            // API now fail-closes without one — see local_api::authorized). Prefer LOBSTER_API_KEY; else
            // read/generate a persisted per-install key (0600) so it survives restarts and can be shown
            // in the UI (Settings). Never leaves the API open.
            let api_key: Option<String> = Some(match std::env::var("LOBSTER_API_KEY") {
                Ok(k) if !k.is_empty() => k,
                _ => {
                    let key_path = dir.join("local-api-key");
                    match std::fs::read_to_string(&key_path) {
                        Ok(k) if !k.trim().is_empty() => k.trim().to_string(),
                        _ => {
                            let k = format!(
                                "lb_local_{}{}",
                                uuid::Uuid::new_v4().simple(),
                                uuid::Uuid::new_v4().simple()
                            );
                            let _ = std::fs::write(&key_path, &k);
                            #[cfg(unix)]
                            {
                                use std::os::unix::fs::PermissionsExt;
                                let _ = std::fs::set_permissions(
                                    &key_path,
                                    std::fs::Permissions::from_mode(0o600),
                                );
                            }
                            k
                        }
                    }
                }
            });

            // Spawn the engine-runner sidecar ONCE on Tauri's shared async runtime, so the UI Launch
            // command and the local automation API drive the SAME process over the SAME runtime's
            // stdio (no cross-runtime pipe). A spawn failure degrades gracefully: the app still opens,
            // and launches report the sidecar is unavailable rather than crashing startup.
            // Resolution order (DSK-5/11): env → packaged resources → dev source tree.
            ensure_lobium_env(app.handle());
            let sidecar_js = resolve_sidecar_js(app.handle());
            let node_bin = resolve_node_bin(app.handle());
            tracing::info!(%node_bin, %sidecar_js, "spawning engine-runner sidecar");
            // Packaged installs should set LOBSTER_HOST_CALIBRATION_FILE under app data so HC-3
            // becomes the default launch path once a host profile is captured.
            if std::env::var_os("LOBSTER_HOST_CALIBRATION_FILE").is_none() {
                let hc_path = dir.join("host-calibration.json");
                std::env::set_var(
                    "LOBSTER_HOST_CALIBRATION_FILE",
                    hc_path.to_string_lossy().as_ref(),
                );
            }
            let sidecar = match tauri::async_runtime::block_on(SidecarClient::spawn(
                &node_bin,
                &sidecar_js,
            )) {
                Ok(sc) => Some(sc),
                Err(err) => {
                    tracing::error!(%err, "failed to spawn engine-runner sidecar; launches unavailable");
                    None
                }
            };
            if let Some(sidecar) = sidecar.as_ref() {
                if let Err(error) = tauri::async_runtime::block_on(
                    local_api::reconcile_profile_statuses(&db, sidecar),
                ) {
                    tracing::error!(%error, "failed to reconcile profile status at startup");
                }
            } else if let Ok(conn) = db.lock() {
                // With no sidecar, no browser can be live in this app instance.
                let _ = profile_store::reconcile_statuses(&conn, &[], &[]);
            }

            app.manage(AppState {
                db: db.clone(),
                sidecar: sidecar.clone(),
                profiles_dir: profiles_dir.clone(),
                cipher: cipher.clone(),
            });

            // Start the local automation API on the same runtime, sharing the store + sidecar.
            if let Some(sidecar) = sidecar {
                let state = Arc::new(local_api::LocalApiState {
                    db,
                    cipher,
                    sidecar,
                    profiles_dir,
                    api_key,
                });
                tauri::async_runtime::spawn(async move {
                    if let Err(err) = local_api::serve(LOCAL_API_PORT, state).await {
                        tracing::error!(%err, "local automation API terminated");
                    }
                });
            }

            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            engine_status,
            provision_engine,
            list_font_families,
            list_profiles,
            list_trashed_profiles,
            create_profile,
            get_profile,
            update_profile,
            delete_profile,
            restore_profile,
            permanently_delete_profile,
            set_profile_password,
            list_proxies,
            create_proxy,
            update_proxy,
            delete_proxy,
            rotate_proxy,
            test_proxy,
            list_templates,
            create_template,
            launch_profile,
            stop_profile,
            export_profile_cookies,
            encrypt_profile_blob,
            decrypt_profile_blob
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Lobster desktop application");
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{first_font_pack_dir, remove_profile_data_dir};

    #[cfg(target_os = "linux")]
    use super::{packaged_runtime_needs_no_sandbox, packaged_runtime_needs_software_gpu};

    #[test]
    fn packaged_font_pack_resolution_ignores_empty_candidates() {
        let root = std::env::temp_dir().join(format!("lobster-fonts-{}", uuid::Uuid::new_v4()));
        let empty = root.join("empty");
        let packed = root.join("packed");
        std::fs::create_dir_all(&empty).unwrap();
        std::fs::create_dir_all(&packed).unwrap();
        std::fs::write(packed.join("font-pack.manifest.json"), b"{}").unwrap();

        assert_eq!(first_font_pack_dir([empty, packed.clone()]), Some(packed));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn only_marked_runtime_without_helper_disables_setuid_sandbox() {
        let root = std::env::temp_dir().join(format!("lobster-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let chrome = root.join("chrome");
        std::fs::write(&chrome, b"").unwrap();

        assert!(!packaged_runtime_needs_no_sandbox(&chrome));
        std::fs::write(root.join("LOBSTER_ENGINE.json"), b"{}").unwrap();
        assert!(packaged_runtime_needs_no_sandbox(&chrome));
        std::fs::write(root.join("chrome_sandbox"), b"").unwrap();
        assert!(!packaged_runtime_needs_no_sandbox(&chrome));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn software_gpu_is_selected_only_for_marked_headless_runtime() {
        let root = std::env::temp_dir().join(format!("lobster-gpu-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let chrome = root.join("chrome");
        std::fs::write(&chrome, b"").unwrap();
        std::fs::write(root.join("LOBSTER_ENGINE.json"), b"{}").unwrap();
        std::fs::write(root.join("vk_swiftshader_icd.json"), b"{}").unwrap();
        std::fs::write(root.join("libvk_swiftshader.so"), b"").unwrap();

        assert!(packaged_runtime_needs_software_gpu(&chrome, false));
        assert!(!packaged_runtime_needs_software_gpu(&chrome, true));
        std::fs::remove_file(root.join("libvk_swiftshader.so")).unwrap();
        assert!(!packaged_runtime_needs_software_gpu(&chrome, false));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn profile_purge_path_is_scoped_and_rejects_traversal() {
        let root = std::env::temp_dir().join(format!("lobster-purge-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let own = root.join("prf_safe");
        let other = root.join("prf_other");
        std::fs::create_dir_all(&own).unwrap();
        std::fs::create_dir_all(&other).unwrap();
        std::fs::write(own.join("Cookies"), b"secret").unwrap();

        assert!(remove_profile_data_dir(&root, "../prf_other").is_err());
        assert!(remove_profile_data_dir(&root, "prf_safe").is_ok());
        assert!(!own.exists());
        assert!(other.exists(), "purge must not delete another profile");

        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&other, root.join("prf_link")).unwrap();
            assert!(remove_profile_data_dir(&root, "prf_link").is_err());
            assert!(other.exists());
        }
        std::fs::remove_dir_all(root).unwrap();
    }
}
