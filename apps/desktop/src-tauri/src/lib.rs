//! Lobster desktop agent — application core (library crate).
//!
//! Responsibilities wired up here:
//!   * initialize structured logging (`tracing`),
//!   * start the local automation API on a background Tokio runtime (off the UI thread),
//!   * build the Tauri app, register the shell plugin, and expose IPC commands to the UI.
//!
//! Fleshed out on later days: real profile lifecycle (Day 4), engine-runner sidecar IPC
//! (Day 5), proxy testing, team sync, and updater. See docs/MASTER_PLAN.md.

mod local_api;
mod profile_store;

/// Port the local automation API binds to on 127.0.0.1. Loopback-only by design.
const LOCAL_API_PORT: u16 = 53211;

/// Returns the desktop agent version, sourced from Cargo at compile time.
/// Consumed by the UI (`invoke('app_version')`) to prove the bridge is live.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

/// Stub profile listing. Real implementation reads from `profile_store` (Day 4);
/// for now it returns an empty set so the UI renders its empty state.
#[tauri::command]
fn list_profiles() -> Vec<serde_json::Value> {
    Vec::new()
}

/// Application entrypoint invoked by `main.rs` (and the mobile entry macro later).
pub fn run() {
    // Simple stdout subscriber for Day 0. Swapped for env-filtered, file-rotating
    // logging once the settings surface exists.
    tracing_subscriber::fmt()
        .with_max_level(tracing::Level::INFO)
        .init();

    // Run the Axum local API on a dedicated OS thread with its own Tokio runtime so it
    // never contends with Tauri's event loop. The thread owns the runtime for the
    // process lifetime; a graceful-shutdown handle is added alongside auth on Day 4.
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
        .invoke_handler(tauri::generate_handler![app_version, list_profiles])
        .run(tauri::generate_context!())
        .expect("error while running the Lobster desktop application");
}
