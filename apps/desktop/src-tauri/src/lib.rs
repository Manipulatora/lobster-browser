//! Lobster desktop agent — application core (library crate).
//!
//! Responsibilities wired up here:
//!   * initialize structured logging (`tracing`),
//!   * start the local automation API on a background Tokio runtime (off the UI thread),
//!   * open the local SQLite profile store and expose profile IPC commands to the UI,
//!   * build the Tauri app and register the shell plugin.
//!
//! Engine launch (`launch_profile`/`stop_profile`) delegates to the engine-runner sidecar; that
//! wiring lands in T-002c once an engine binary is provisioned. See docs/MASTER_PLAN.md.

mod local_api;
mod profile_store;

use std::sync::Mutex;

use tauri::{Manager, State};

use profile_store::{CreateProfileInput, Profile, UpdateProfilePatch};

/// Port the local automation API binds to on 127.0.0.1. Loopback-only by design.
const LOCAL_API_PORT: u16 = 53211;

/// Shared desktop state: the open connection to the local SQLite profile store.
struct AppState {
    db: Mutex<rusqlite::Connection>,
}

/// Endpoints an automation client connects to after a profile launches (mirrors the TS `LaunchInfo`).
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchInfo {
    ws: String,
    debugger_address: String,
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
fn launch_profile(state: State<'_, AppState>, id: String) -> Result<LaunchInfo, String> {
    // Confirm the profile exists before reporting on launch capability.
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::get(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("profile {id} not found"))?;
    // Engine-runner sidecar wiring lands in T-002c; until an engine binary is provisioned
    // (engines/download-engines.mjs or the Lobster Kernel build) we error clearly rather than
    // hand back a dead CDP endpoint.
    Err(format!(
        "cannot launch profile {id}: no engine provisioned yet (run engines/download-engines.mjs or build the Lobster Kernel; sidecar wiring is T-002c)"
    ))
}

#[tauri::command]
fn stop_profile(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    profile_store::get(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("profile {id} not found"))?;
    Err(format!(
        "cannot stop profile {id}: engine lifecycle not wired yet (T-002c)"
    ))
}

/// Application entrypoint invoked by `main.rs` (and the mobile entry macro later).
pub fn run() {
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // Run the Axum local API on a dedicated OS thread with its own Tokio runtime so it never
    // contends with Tauri's event loop.
    std::thread::Builder::new()
        .name("lobster-local-api".into())
        .spawn(|| {
            let runtime = tokio::runtime::Runtime::new()
                .expect("failed to start Tokio runtime for the local automation API");
            runtime.block_on(async {
                if let Err(err) = local_api::serve(LOCAL_API_PORT).await {
                    tracing::error!(%err, "local automation API terminated");
                }
            });
        })
        .expect("failed to spawn local automation API thread");

    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .setup(|app| {
            // Open the local profile store under the OS app-data dir and share it as state.
            let dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let conn =
                profile_store::init(dir.join("profiles.sqlite")).map_err(|e| e.to_string())?;
            app.manage(AppState {
                db: Mutex::new(conn),
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            app_version,
            list_profiles,
            create_profile,
            get_profile,
            update_profile,
            delete_profile,
            launch_profile,
            stop_profile
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Lobster desktop application");
}
