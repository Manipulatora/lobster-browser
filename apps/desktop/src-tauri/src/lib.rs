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
//! Launch button and external automation clients behave identically. See docs/MASTER_PLAN.md.

mod blob_crypto;
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
use proxy_store::{CreateStoredProxyInput, StoredProxy};
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

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Result<Vec<Profile>, String> {
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
fn delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if profile_store::delete(&conn, &id).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err(format!("profile {id} not found"))
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

#[tauri::command]
fn permanently_delete_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
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
    let result = run_proxy_check(config).await;
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

/// If Lobium is not configured, point env at a packaged/engine install so the sidecar can find it.
fn ensure_lobium_env(app: &tauri::AppHandle) {
    if std::env::var_os("LOBSTER_LOBIUM_BIN").is_some() {
        return;
    }
    if let Ok(resource_dir) = app.path().resource_dir() {
        for rel in ["lobium/chrome", "engines/lobium/chrome"] {
            let chrome = resource_dir.join(rel);
            if chrome.is_file() {
                std::env::set_var("LOBSTER_LOBIUM_BIN", chrome.to_string_lossy().as_ref());
                if let Some(parent) = chrome.parent() {
                    std::env::set_var("LOBSTER_LOBIUM_DIR", parent.to_string_lossy().as_ref());
                }
                return;
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
    local_api::stop_profile_via_sidecar(sidecar, &id)
        .await
        .map_err(|e| e.to_string())
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
            test_proxy,
            list_templates,
            create_template,
            launch_profile,
            stop_profile,
            encrypt_profile_blob,
            decrypt_profile_blob
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Lobster desktop application");
}
