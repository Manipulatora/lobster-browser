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

mod local_api;
mod profile_store;
mod proxy_check;
mod proxy_store;
mod sidecar;
mod template_store;

use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use tauri::{Manager, State};

use profile_store::{CreateProfileInput, Profile, UpdateProfilePatch};
use proxy_check::{run_proxy_check, ProxyCheckResult};
use proxy_store::{CreateStoredProxyInput, StoredProxy};
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
}

/// Returns the desktop agent version, sourced from Cargo at compile time.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

#[tauri::command]
fn list_profiles(state: State<'_, AppState>) -> Result<Vec<Profile>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::list(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn list_trashed_profiles(state: State<'_, AppState>) -> Result<Vec<Profile>, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::list_trashed(&conn).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_profile(
    state: State<'_, AppState>,
    input: CreateProfileInput,
) -> Result<Profile, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::create(&conn, input).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_profile(state: State<'_, AppState>, id: String) -> Result<Profile, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::get(&conn, &id)
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
    profile_store::update(&conn, &id, patch)
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
    proxy_store::list(&conn, source.as_deref()).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_proxy(
    state: State<'_, AppState>,
    input: CreateStoredProxyInput,
) -> Result<StoredProxy, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    proxy_store::create(&conn, input).map_err(|e| e.to_string())
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
        sidecar,
        &state.profiles_dir,
        &id,
        password.as_deref(),
        false,
    )
    .await
    .map_err(|e| e.to_string())
}

/// Stop a running profile via the shared sidecar.
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

    tauri::Builder::default()
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
            // Dev default: the built sidecar bundle in the source tree, resolved from THIS crate so it
            // works regardless of CWD (the old "engine-runner/index.js" relative path resolved to
            // nothing in `tauri dev`, leaving the Launch button dead). Packaged builds set
            // LOBSTER_SIDECAR or bundle the sidecar as a resource — see DSK-11.
            let sidecar_js = std::env::var("LOBSTER_SIDECAR").unwrap_or_else(|_| {
                std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                    .join("../../../packages/engine-runner/dist/index.js")
                    .to_string_lossy()
                    .into_owned()
            });
            let sidecar = match tauri::async_runtime::block_on(SidecarClient::spawn(
                "node",
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
            });

            // Start the local automation API on the same runtime, sharing the store + sidecar.
            if let Some(sidecar) = sidecar {
                let state = Arc::new(local_api::LocalApiState {
                    db,
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
            stop_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Lobster desktop application");
}
