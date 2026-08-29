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

mod account;
mod agent_proxy;
mod agent_secrets;
mod blob_crypto;
mod cloud_auth;
mod engine_provision;
mod keychain;
mod local_api;
mod profile_portable;
mod profile_store;
mod profile_sync;
mod proxy_check;
mod proxy_store;
mod secrets;
mod sidecar;
mod snapshot;
mod template_store;
mod vault_key;
mod window_show;

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};

use tauri::{Emitter, Manager, State};

use profile_store::{CreateProfileInput, Profile, UpdateProfilePatch};
use proxy_check::{run_proxy_check, ProxyCheckResult};
use proxy_store::{CreateStoredProxyInput, StoredProxy, UpdateStoredProxyInput};
use secrets::SecretCipher;
use sidecar::SidecarClient;
use template_store::{CreateProfileTemplateInput, ProfileTemplate, UpdateProfileTemplateInput};

/// Port the local automation API binds to on 127.0.0.1. Loopback-only by design.
const LOCAL_API_PORT: u16 = 53211;

/// Private desktop -> sidecar attestation contract for the canonical per-user engine runtime.
const MANAGED_ENGINE_VERSION_ENV: &str = "LOBSTER_INTERNAL_MANAGED_ENGINE_VERSION";
const MANAGED_ENGINE_SHA256_ENV: &str = "LOBSTER_INTERNAL_MANAGED_ENGINE_SHA256";
#[cfg(target_os = "windows")]
const MANAGED_ENGINE_BIN_ORIGIN_ENV: &str = "LOBSTER_INTERNAL_LOBIUM_BIN_ORIGIN";

/// Whether the published `LOBSTER_LOBIUM_BIN` points at the managed per-user runtime.
///
/// The environment variable is also the supported developer/self-hosting override, and bundled
/// resource runtimes are valid without a downloader stamp. Either may legitimately use the same path
/// spelling as the managed runtime, so Rust tracks origin out-of-band on every platform. Windows also
/// mirrors it to the sidecar for its canonical per-user resolver; other platforms retain the existing
/// Rust-validated explicit-path handoff.
static LOBIUM_BIN_IS_MANAGED: AtomicBool = AtomicBool::new(false);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum LobiumBinOrigin {
    NonManaged,
    Managed,
}

impl LobiumBinOrigin {
    fn is_managed(self) -> bool {
        self == Self::Managed
    }
}

#[cfg(target_os = "windows")]
fn managed_engine_bin_origin_value(origin: LobiumBinOrigin) -> Option<&'static str> {
    origin.is_managed().then_some("managed")
}

#[cfg(test)]
fn discovered_lobium_bin_origin(chrome: &Path, user_runtime: Option<&Path>) -> LobiumBinOrigin {
    if user_runtime.is_some_and(|runtime| chrome == runtime.join(CHROME_BIN)) {
        LobiumBinOrigin::Managed
    } else {
        LobiumBinOrigin::NonManaged
    }
}

/// Publish the binary and its origin as one operation. The origin is stored first so a concurrent
/// status request can never observe a newly managed path and transiently classify it as an override.
fn publish_lobium_env(chrome: &Path, origin: LobiumBinOrigin) {
    LOBIUM_BIN_IS_MANAGED.store(origin.is_managed(), Ordering::Release);
    #[cfg(target_os = "windows")]
    {
        if let Some(value) = managed_engine_bin_origin_value(origin) {
            std::env::set_var(MANAGED_ENGINE_BIN_ORIGIN_ENV, value);
        } else {
            std::env::remove_var(MANAGED_ENGINE_BIN_ORIGIN_ENV);
        }
    }
    std::env::set_var("LOBSTER_LOBIUM_BIN", chrome.to_string_lossy().as_ref());
    if let Some(parent) = chrome.parent() {
        std::env::set_var("LOBSTER_LOBIUM_DIR", parent.to_string_lossy().as_ref());
    }
}

fn managed_engine_expectation(
    source: Option<&engine_provision::EngineSource>,
) -> Option<(String, String)> {
    source.map(|source| (source.version.clone(), source.sha256.to_ascii_lowercase()))
}

/// Publish the manifest decision before sidecar spawn even when chrome.exe is still absent. Clearing
/// first is important for a Windows build whose manifest has no win-x64 entry: an inherited/stale
/// expectation must not authorize the canonical runtime.
fn publish_managed_engine_expectation(source: Option<&engine_provision::EngineSource>) {
    std::env::remove_var(MANAGED_ENGINE_VERSION_ENV);
    std::env::remove_var(MANAGED_ENGINE_SHA256_ENV);
    if let Some((version, sha256)) = managed_engine_expectation(source) {
        std::env::set_var(MANAGED_ENGINE_VERSION_ENV, version);
        std::env::set_var(MANAGED_ENGINE_SHA256_ENV, sha256);
    }
}

fn current_managed_lobium_bin(
    runtime: &Path,
    source: Option<&engine_provision::EngineSource>,
) -> Option<PathBuf> {
    source
        .filter(|source| engine_provision::engine_matches_source(runtime, source))
        .map(|_| runtime.join(CHROME_BIN))
}

/// Shared desktop state: the local SQLite profile store, the engine-runner sidecar (shared with the
/// local automation API so the UI Launch button and the HTTP API drive the SAME launch path), and the
/// per-profile user-data-dir root. `sidecar` is `None` only if the sidecar failed to spawn at startup.
struct AppState {
    db: Arc<Mutex<rusqlite::Connection>>,
    sidecar: Option<Arc<SidecarClient>>,
    profiles_dir: PathBuf,
    /// SEC-12: per-install AES-256-GCM cipher used by the stores for at-rest secret encryption.
    cipher: Arc<SecretCipher>,
    /// The account key, cached for this session.
    ///
    /// In memory only: persisting it would put a copy on this machine's disk for no benefit, since
    /// it is re-fetchable from the server by anyone who can sign in.
    account_key: Arc<Mutex<Option<vault_key::AccountKey>>>,
    /// Exact-id ownership and cancellation for the browser loopback sign-in flow.
    sign_in: cloud_auth::SignInCoordinator,
}

/// Returns the desktop agent version, sourced from Cargo at compile time.
#[tauri::command]
fn app_version() -> String {
    env!("CARGO_PKG_VERSION").to_string()
}

// --- Cloud sign-in -----------------------------------------------------------

/// Who is signed in, if anyone.
///
/// Distinguishes three outcomes the UI must treat differently, which a bare `Option` cannot:
/// signed in, signed out, and "we could not tell" (offline). The last one must NOT show the
/// sign-in screen — a user on a flaky connection would be locked out of local profiles that need
/// no network at all.
#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AuthState {
    user: Option<cloud_auth::CloudUser>,
    /// True when a token exists but could not be verified because the API was unreachable.
    offline: bool,
}

/// The signed-in state WITHOUT touching the network.
///
/// First paint used to wait on `auth_status`, which calls `/auth/me` with a 15-second timeout — so a
/// slow or unreachable network made a cold start look like a hung app, while the profile list it was
/// waiting to show was already available locally in about 2 ms. This answers instantly from the
/// cached identity; the UI paints from it and verifies in the background.
///
/// `verified: false` is the honest part: this says who was signed in last time it was checked, not
/// who is signed in now. A revoked token is caught by the background verification a moment later.
/// Balance, plan and profile cap for the signed-in account.
///
/// Returns `null` rather than an error when it cannot be fetched: this is decoration on a screen the
/// user wants immediately, and a launcher whose profile list fails because a billing endpoint was
/// slow is a worse product than one that shows the list without a balance.
/// Open the account's billing page in the system browser.
///
/// Top-ups and plan changes live on the website. The launcher deliberately owns neither: keeping
/// payment in one implementation there is the same call as keeping passwords there, and a desktop
/// window that took card or crypto details would be a second surface to secure for no gain.
#[tauri::command]
fn open_billing() -> Result<(), String> {
    open_in_browser(&format!("{}/account/billing", cloud_auth::web_origin()))
        .map_err(|e| format!("could not open the billing page: {e}"))
}

/// Upgrade goes to the PRICE LIST, not the wallet.
///
/// These are different questions: /account/billing answers "what am I on and what do I owe", while
/// /pricing answers "what could I move to and what does it cost". Upgrade was wired to the former
/// only because billing was the single page the launcher already knew how to open.
#[tauri::command]
fn open_pricing() -> Result<(), String> {
    open_in_browser(&format!("{}/pricing", cloud_auth::web_origin()))
        .map_err(|e| format!("could not open the pricing page: {e}"))
}

#[tauri::command]
async fn account_summary(
    state: State<'_, AppState>,
) -> Result<Option<account::AccountSummary>, String> {
    match account::fetch().await {
        Ok(summary) => {
            // Persist the allowance so `create_profile` can enforce it offline and after a restart.
            account::cache_entitlement(&state.profiles_dir, &summary.tier, summary.profile_limit);
            Ok(Some(summary))
        }
        Err(err) => {
            // Unreachable-server is not an error to the shell: it renders the signed-out state.
            // The cached allowance stays in force, so the cap survives the outage.
            tracing::debug!(error = %format!("{err:#}"), "account summary unavailable");
            Ok(None)
        }
    }
}

#[tauri::command]
fn auth_status_cached() -> AuthState {
    AuthState {
        user: cloud_auth::cached_user(),
        // Unknown rather than asserted: nothing has been asked of the network yet.
        offline: false,
    }
}

#[tauri::command]
async fn auth_status() -> Result<AuthState, String> {
    match cloud_auth::current_user().await {
        Ok(user) => Ok(AuthState {
            user,
            offline: false,
        }),
        Err(_) if cloud_auth::load_token().is_some() => {
            // A token is held but unverifiable. Treat the previous session as still good rather
            // than signing the user out because their wifi dropped.
            Ok(AuthState {
                user: None,
                offline: true,
            })
        }
        Err(err) => Err(err.to_string()),
    }
}

/// Open the browser at the sign-up or sign-in page and wait for the loopback callback.
///
/// One long-running command rather than a start/poll pair: the whole flow is a single await, and
/// splitting it would mean holding the PendingSignIn (with its listener and PKCE verifier) in
/// shared state, where an abandoned attempt leaks a bound port.
#[tauri::command]
async fn auth_sign_in(
    state: State<'_, AppState>,
    mode: String,
    attempt_id: String,
) -> Result<cloud_auth::CloudUser, String> {
    let attempt = state
        .sign_in
        .register(&attempt_id)
        .map_err(|e| e.to_string())?;
    let (handle, pending) = cloud_auth::begin(&mode).await.map_err(|e| e.to_string())?;

    open_in_browser(&handle.url).map_err(|e| {
        format!(
            "could not open your browser. Visit this address to sign in:\n{}\n\n({e})",
            handle.url
        )
    })?;

    let user = attempt.wait(pending).await.map_err(|e| e.to_string())?;
    // Signing in is the moment the agent becomes usable (or the moment we learn this package cannot
    // use it). Handing the sidecar the answer now means a panel opened straight afterwards paints
    // the truth instead of the pre-sign-in "not configured" state.
    if let Some(sidecar) = state.sidecar.as_ref() {
        agent_proxy::push(sidecar, true).await;
    }
    Ok(user)
}

/// Stop exactly the browser handoff the UI names. A stale cancel cannot affect a later attempt.
#[tauri::command]
fn auth_cancel_sign_in(state: State<'_, AppState>, attempt_id: String) -> Result<bool, String> {
    state.sign_in.cancel(&attempt_id).map_err(|e| e.to_string())
}

/// Whether this session can seal and open snapshots for other machines.
///
/// There is no unlock step and no second secret: the account key is fetched after sign-in and cached
/// for the session. This exists so the UI can show whether sync is usable and say why when it is not.
#[tauri::command]
async fn vault_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let cached = state
        .account_key
        .lock()
        .map_err(|e| e.to_string())?
        .is_some();
    if cached {
        return Ok(serde_json::json!({ "ready": true }));
    }
    match vault_key::fetch().await {
        Ok(key) => {
            *state.account_key.lock().map_err(|e| e.to_string())? = Some(key);
            Ok(serde_json::json!({ "ready": true }))
        }
        Err(err) => Ok(serde_json::json!({ "ready": false, "error": format!("{err:#}") })),
    }
}

#[tauri::command]
async fn auth_sign_out(state: State<'_, AppState>) -> Result<(), String> {
    cloud_auth::clear_token();
    // The agent token outlives the session that minted it by up to half an hour. Revoking it here is
    // what stops a signed-out machine from continuing to spend the previous user's Credit.
    if let Some(sidecar) = state.sidecar.as_ref() {
        agent_proxy::clear(sidecar).await;
    } else {
        agent_proxy::forget();
    }
    Ok(())
}

/// Hand a URL to the OS default browser.
///
/// WINDOWS USES ShellExecuteW, AND THE PREVIOUS `cmd /c start` FORM WAS A SHIPPED BUG.
///
/// `Command::new("cmd").args(["/c", "start", "", url])` looks equivalent and is not. Rust quotes an
/// argument only when it contains a space, tab or quote — a URL contains none — so the sign-in URL
/// reached `cmd` unquoted, and `&` is a COMMAND SEPARATOR to cmd. Running that exact argv shows the
/// browser being handed
///
///     https://lobrowser.com/login?desktop=1
///
/// while `state=…`, `port=…` and `challenge=…` were each executed as commands and failed with
/// "'state' is not recognized as an internal or external command".
///
/// That broke the entire desktop sign-in. The website received `desktop=1` with no state, port or
/// challenge, so it could not recognise a launcher handoff at all: it completed as an ordinary web
/// login and never redirected to the loopback listener. The app then sat on its sign-in screen
/// until the ten-minute timeout, having given the user no reason to believe anything had failed.
/// The stray sub-commands also printed into the console window `cmd` created on the way past.
///
/// ShellExecuteW takes the URL as one wide string and hands it to the shell's URL handler. No
/// command line is parsed, so nothing in the URL can be interpreted, and no console is created.
#[cfg(target_os = "windows")]
fn open_in_browser(url: &str) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::ShellExecuteW;
    use windows_sys::Win32::UI::WindowsAndMessaging::SW_SHOWNORMAL;

    fn wide(s: &str) -> Vec<u16> {
        std::ffi::OsStr::new(s)
            .encode_wide()
            .chain(std::iter::once(0))
            .collect()
    }

    let verb = wide("open");
    let target = wide(url);

    // SAFETY: both pointers are null-terminated UTF-16 buffers owned by this scope for the duration
    // of the call; the remaining arguments are the documented "no parameters, no working directory"
    // nulls.
    let result = unsafe {
        ShellExecuteW(
            std::ptr::null_mut(),
            verb.as_ptr(),
            target.as_ptr(),
            std::ptr::null(),
            std::ptr::null(),
            SW_SHOWNORMAL,
        )
    };

    // ShellExecuteW returns a pseudo-HINSTANCE; any value <= 32 is an error code, not a handle.
    if (result as isize) <= 32 {
        return Err(std::io::Error::other(format!(
            "ShellExecuteW failed with code {}",
            result as isize
        )));
    }
    Ok(())
}

/// `open` / `xdg-open` receive the URL as a single argv entry with no shell in between, so the
/// escaping hazard described above cannot arise here.
#[cfg(not(target_os = "windows"))]
fn open_in_browser(url: &str) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    let program = "open";
    #[cfg(not(target_os = "macos"))]
    let program = "xdg-open";

    std::process::Command::new(program)
        .arg(url)
        .spawn()
        .map(|_| ())
}

/// Strip Windows' extended-length (`\\?\`) verbatim prefix from a path.
///
/// `AppHandle::path().resource_dir()` returns a VERBATIM path on Windows — `\\?\C:\Program Files\…`.
/// Most Windows APIs accept that, but Node does not accept it as a main-module argument: it calls
/// `realpathSync` on the path and aborts with
/// `EISDIR: illegal operation on a directory, lstat 'C:'`.
///
/// The failure was invisible from the Rust side and genuinely nasty. `SidecarClient::spawn` succeeded
/// (the process *did* start), so `sidecar` was `Some` and the local automation API came up as normal —
/// but the interpreter had already died, leaving a running app wired to a dead sidecar in which every
/// profile launch and every agent call fails. Found only by running the installed bundle; a `cargo`
/// run resolves its resources through the dev fallback path and never reproduces it.
///
/// UNC shares (`\\?\UNC\server\share`) are mapped back to `\\server\share`; anything that is not a
/// drive-letter or UNC verbatim path is returned untouched.
fn strip_verbatim_prefix(path: PathBuf) -> PathBuf {
    #[cfg(windows)]
    {
        let text = path.to_string_lossy();
        if let Some(rest) = text.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = text.strip_prefix(r"\\?\") {
            // Only a real drive path (`C:\…`) is safe to un-prefix.
            if rest.as_bytes().get(1) == Some(&b':') {
                return PathBuf::from(rest);
            }
        }
        path
    }
    #[cfg(not(windows))]
    {
        path
    }
}

/// The app's bundled-resource directory, with the Windows verbatim prefix removed.
/// Every resource lookup must go through this rather than calling `resource_dir()` directly.
fn app_resource_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    app.path().resource_dir().ok().map(strip_verbatim_prefix)
}

/// Chromium's executable file name on this platform.
///
/// Every engine-discovery path used to hard-code `chrome`, so on Windows the packaged/downloaded
/// runtime was never found even when it was present.
#[cfg(windows)]
pub(crate) const CHROME_BIN: &str = "chrome.exe";
#[cfg(not(windows))]
pub(crate) const CHROME_BIN: &str = "chrome";

/// The user's home directory, cross-platform.
///
/// `HOME` is not set on Windows. The original `var_os("HOME")` therefore yielded `None` for every
/// caller: `engine_status()` reported an empty runtime dir and `provision_engine` failed with
/// "cannot resolve engine runtime dir (no HOME)" on a machine with a perfectly good home directory —
/// a silent, confusing dead end rather than an error anyone could act on.
fn user_home_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .or_else(|| {
                let drive = std::env::var_os("HOMEDRIVE")?;
                let path = std::env::var_os("HOMEPATH")?;
                Some(PathBuf::from(drive).join(path))
            })
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME").map(PathBuf::from)
    }
}

/// The user-local engine runtime dir where the downloaded engine lives.
/// Unix: `~/.local/share/lobster/lobium`.  Windows: `%LOCALAPPDATA%\lobster\lobium`.
fn user_engine_runtime_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| user_home_dir().map(|home| home.join("AppData").join("Local")))
            .map(|base| base.join("lobster").join("lobium"))
    }
    #[cfg(not(windows))]
    {
        user_home_dir().map(|home| home.join(".local/share/lobster/lobium"))
    }
}

/// The manifest this build should obey: the REFRESHED copy when one exists, else the bundled one.
///
/// One function, so every reader agrees. That matters more than it looks: `engine_status` compares
/// the installed engine's stamp against the resolved source, and `provision_engine` installs from
/// it. If those two read different manifests, a client would install the engine one named and then
/// be told by the other that no engine is present - provisioning forever, which is the exact
/// failure mode this whole area has already produced twice.
///
/// The refreshed copy lives in the app data dir, not beside the binary: the install directory is
/// read-only on a normal Windows install, and writing into it would also mean an update could not
/// be undone by clearing user data.
/// True when the engine SHIPPED IN THE INSTALLER is already the one the manifest names.
///
/// Without this the background updater would re-download the engine on every launch of a freshly
/// installed client: the managed runtime directory is empty, so `engine_matches_source` is false,
/// even though the bundled copy is byte-for-byte what the manifest points at. The packager writes
/// the same stamp beside the bundled engine that provisioning writes beside a downloaded one, so the
/// two are compared the same way.
fn bundled_engine_satisfies(app: &tauri::AppHandle, source: &engine_provision::EngineSource) -> bool {
    app_resource_dir(app)
        .map(|resources| resources.join("lobium"))
        .is_some_and(|bundled| engine_provision::engine_matches_source(&bundled, source))
}

fn engine_manifest_path(app: &tauri::AppHandle) -> Option<PathBuf> {
    let cached = app
        .path()
        .app_data_dir()
        .ok()
        .map(|dir| dir.join("engine-manifest.json"))
        .filter(|path| path.is_file());
    cached.or_else(|| app_resource_dir(app).map(|resources| resources.join("engine-manifest.json")))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct EngineStatus {
    present: bool,
    runtime_dir: String,
}

fn explicit_lobium_bin_from(
    configured: Option<PathBuf>,
    is_managed: bool,
) -> Result<Option<PathBuf>, String> {
    let Some(path) = configured else {
        return Ok(None);
    };
    // A per-user path published by discovery/provisioning is managed and therefore must be judged by
    // the manifest stamp, not treated as a developer override. The origin bit matters more than the
    // path: a Windows builder is explicitly instructed to point LOBSTER_LOBIUM_BIN at that same path
    // before a win-x64 release entry exists, and that remains a valid developer override.
    if is_managed {
        return Ok(None);
    }
    if path.is_file() {
        return Ok(Some(path));
    }
    Err(format!(
        "LOBSTER_LOBIUM_BIN points to `{}`, but that path is not a browser executable file; update or unset the variable before provisioning",
        path.display()
    ))
}

fn explicit_lobium_bin() -> Result<Option<PathBuf>, String> {
    let configured = std::env::var_os("LOBSTER_LOBIUM_BIN").map(PathBuf::from);
    explicit_lobium_bin_from(configured, LOBIUM_BIN_IS_MANAGED.load(Ordering::Acquire))
}

/// Whether the Lobium engine is installed, and where it is expected.
///
/// The installer does NOT carry the engine — it is ~37 MB and the engine is ~300 MB compressed — so
/// `present: false` is the ordinary first-run state, not damage, and EngineGate responds by
/// downloading rather than by telling the user to reinstall.
///
/// The reported directory is therefore the per-user runtime the download installs into. A build
/// that still embeds a runtime beside the app is honoured first by `ensure_lobium_env`, and reports
/// as present through the `explicit` branch below without ever reaching this path.
#[tauri::command]
fn engine_status(app: tauri::AppHandle) -> EngineStatus {
    // Where a downloaded engine goes, which is the only place `provision_engine` writes.
    let expected_dir = || {
        user_engine_runtime_dir()
            .map(|dir| dir.to_string_lossy().into_owned())
            .unwrap_or_default()
    };
    let explicit = match explicit_lobium_bin() {
        Ok(explicit) => explicit,
        Err(_) => {
            return EngineStatus {
                present: false,
                runtime_dir: expected_dir(),
            };
        }
    };
    if let Some(path) = explicit {
        return EngineStatus {
            present: true,
            runtime_dir: path
                .parent()
                .map(|p| p.to_string_lossy().into_owned())
                .unwrap_or_default(),
        };
    }
    // No explicit binary means ensure_lobium_env found neither an embedded runtime nor a managed one
    // matching the manifest, so the manifest check below is the last thing that could say "present".
    let dir = user_engine_runtime_dir().unwrap_or_default();
    let manifest = engine_manifest_path(&app);
    let present = engine_provision::resolve_source(manifest.as_deref())
        .is_ok_and(|source| engine_provision::engine_matches_source(&dir, &source));
    EngineStatus {
        present,
        // Present here means a managed runtime satisfied the manifest, so that IS the directory in
        // use; absent, point at where the package should have put one.
        runtime_dir: if present {
            dir.to_string_lossy().into_owned()
        } else {
            expected_dir()
        },
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
    use tauri::Emitter;
    if explicit_lobium_bin()?.is_some() {
        return Ok(());
    }
    let runtime_dir = user_engine_runtime_dir().ok_or_else(|| {
        "cannot resolve the engine runtime directory (no LOCALAPPDATA/USERPROFILE on Windows, \
         no HOME otherwise)"
            .to_string()
    })?;
    let manifest = engine_manifest_path(&app);
    let source = engine_provision::resolve_source(manifest.as_deref())
        .map_err(|e| format!("no engine source configured: {e:#}"))?;
    if engine_provision::engine_matches_source(&runtime_dir, &source) {
        return Ok(());
    }
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
    publish_lobium_env(&runtime_dir.join(CHROME_BIN), LobiumBinOrigin::Managed);
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

/// Sentinel for "no pack is installed", as distinct from "a pack is installed and is broken".
///
/// The caller has to tell those apart. An ABSENT pack is the normal state on Windows, where font
/// isolation is native (the engine filters DirectWrite/FontDataService against the persona list) and
/// the pack only supplies families the host lacks. A BROKEN pack - unreadable, wrong version, unsafe
/// path, missing the physical families it claims - is a real defect and must keep blocking, because
/// it means the pack cannot back what the persona advertises.
///
/// Returned as a stable code rather than prose so the UI branches on identity, not on message text.
pub const FONT_PACK_ABSENT: &str = "FONT_PACK_ABSENT";

/// Return the complete sourced persona catalog after proving its physical fallback pack is present.
#[tauri::command]
fn list_font_families(app: tauri::AppHandle, os: String) -> Result<Vec<String>, String> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("LOBSTER_FONTS_DIR") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Some(resources) = app_resource_dir(&app) {
        candidates.push(resources.join("fonts"));
        // The packaged pack lives INSIDE the engine runtime, not beside it. It used to be staged to
        // resources/fonts as well, which shipped 150.6 MB of identical faces twice; that duplicate
        // is gone, so this is now the path that actually resolves in an installed build. Listed
        // after resources/fonts so an explicitly staged pack still wins if one is ever added back.
        candidates.push(resources.join("lobium").join("fonts"));
    }
    // The engine runtime carries its own pack beside chrome.exe, which is where
    // package-lobium-runtime.ps1 -FontPack writes it. Checking here too means a pack provisioned
    // with the engine is found by the UI as well, not only by the launcher.
    if let Some(bin) = std::env::var_os("LOBSTER_LOBIUM_BIN") {
        if let Some(parent) = PathBuf::from(bin).parent() {
            candidates.push(parent.join("fonts"));
        }
    }
    let pack = candidates
        .into_iter()
        .find(|path| path.join("font-pack.manifest.json").is_file())
        .ok_or(FONT_PACK_ABSENT)?;
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
    // PLAN CAP, ENFORCED HERE AND NOT IN THE UI.
    //
    // The desktop is local-first: creation never round-trips through the backend, so the cap the
    // server enforces on the cloud store (`profiles.service.ts`) never applied to it and the free
    // allowance was unlimited in practice. The guard lives at this funnel because every route to a
    // new profile — the create form, duplicate, template instantiation, import — comes through it,
    // and because a check in the React layer is bypassed by anyone driving the local automation API.
    let limit = account::cached_profile_limit(&state.profiles_dir);
    let active = profile_store::count_active(&conn).map_err(|e| e.to_string())?;
    if active >= limit {
        return Err(format!(
            "PROFILE_LIMIT_REACHED: this plan allows {limit} profile{}. Upgrade to create more.",
            if limit == 1 { "" } else { "s" }
        ));
    }
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
    // Read the account link BEFORE the row goes: afterwards there is nothing left to say which
    // remote row this was, and a remote row nothing points at is one the next reconcile restores.
    let remote_id = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        profile_store::sync_link(&conn, &id)
            .map_err(|e| e.to_string())?
            .and_then(|link| link.remote_id)
    };
    remove_profile_data_dir(&state.profiles_dir, &id)?;
    let purged = {
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        profile_store::purge(&conn, &id).map_err(|e| e.to_string())?
    };
    if !purged {
        return Err(format!("trashed profile {id} not found"));
    }
    if let Some(remote_id) = remote_id {
        profile_sync::forget_remote_row(&remote_id).await;
    }
    Ok(())
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
fn update_template(
    state: State<'_, AppState>,
    id: String,
    input: UpdateProfileTemplateInput,
) -> Result<ProfileTemplate, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    template_store::update(&conn, &id, input)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("template {id} not found"))
}

#[tauri::command]
fn duplicate_template(state: State<'_, AppState>, id: String) -> Result<ProfileTemplate, String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    template_store::duplicate(&conn, &id)
        .map_err(|e| e.to_string())?
        .ok_or_else(|| format!("template {id} not found"))
}

#[tauri::command]
fn delete_template(state: State<'_, AppState>, id: String) -> Result<(), String> {
    let conn = state.db.lock().map_err(|e| e.to_string())?;
    if template_store::delete(&conn, &id).map_err(|e| e.to_string())? {
        Ok(())
    } else {
        Err(format!("template {id} not found"))
    }
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
        let conn = state.db.lock().map_err(|e| e.to_string())?;
        proxy_store::update_test_result(&conn, id, &result).map_err(|e| e.to_string())?;
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
    let key_id =
        if let (Some(tdk_hex), Some(pid)) = (team_data_key_hex.as_deref(), profile_id.as_deref()) {
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
            u8::from_str_radix(&hex[i..i + 2], 16).map_err(|_| format!("invalid hex at offset {i}"))
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
    if let Some(resource_dir) = app_resource_dir(app) {
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
    // The vendored interpreter is `node.exe` on Windows and a bare `node` elsewhere. Probing only the
    // POSIX names made the packaged runtime invisible on Windows, so resolution fell through to a bare
    // "node" on PATH — which a packaged install has no reason to have, and the sidecar never started.
    #[cfg(windows)]
    const NODE_RELATIVE: &[&str] = &["node/node.exe", "node/bin/node.exe"];
    #[cfg(not(windows))]
    const NODE_RELATIVE: &[&str] = &["node/bin/node", "node/node"];

    if let Some(resource_dir) = app_resource_dir(app) {
        for rel in NODE_RELATIVE {
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
/// Whether the kernel can give Chromium its USER-NAMESPACE sandbox.
///
/// Chromium has two Linux sandboxes. The old one needs a root-owned setuid `chrome_sandbox` helper;
/// the modern one needs only unprivileged user namespaces, and Chromium picks it automatically when
/// the helper is absent. So "no setuid helper" does NOT mean "no sandbox" on any current kernel.
fn kernel_supports_userns_sandbox() -> bool {
    // Present and 0 on kernels (mainly older Debian/Ubuntu) that gate the feature off. Absent
    // entirely on kernels where it is unconditionally available, which is the common case.
    let gate_open = match std::fs::read_to_string("/proc/sys/kernel/unprivileged_userns_clone") {
        Ok(value) => value.trim() != "0",
        Err(_) => true,
    };
    // A hard cap of 0 disables namespaces regardless of the gate above.
    let has_budget = std::fs::read_to_string("/proc/sys/user/max_user_namespaces")
        .ok()
        .and_then(|value| value.trim().parse::<u64>().ok())
        .is_none_or(|max| max > 0);
    gate_open && has_budget
}

/// Whether this packaged runtime has to be launched with `--no-sandbox`.
///
/// It almost never does. The packaged runtime cannot carry a root-owned setuid `chrome_sandbox`
/// through a normal user copy, and the old logic concluded from that alone that sandboxing had to be
/// switched off. That cost three things at once: the browser ran unsandboxed, Chromium showed the
/// user a yellow "unsupported command-line flag: --no-sandbox" infobar on every launch, and that
/// infobar is itself an automation tell on a product whose whole purpose is not looking automated.
///
/// The setuid helper is only one of two sandboxes. Where the kernel permits unprivileged user
/// namespaces — measured, not assumed — Chromium sandboxes itself without any helper, so the flag is
/// dropped and all three problems go away together.
#[cfg(target_os = "linux")]
fn packaged_runtime_needs_no_sandbox(chrome: &std::path::Path) -> bool {
    packaged_runtime_needs_no_sandbox_with(chrome, kernel_supports_userns_sandbox())
}

/// The decision, with the kernel capability passed in so BOTH branches are testable. Reading /proc
/// directly would make the outcome depend on whichever machine runs the suite, which is how a
/// security-relevant branch ends up permanently unexercised.
#[cfg(target_os = "linux")]
fn packaged_runtime_needs_no_sandbox_with(
    chrome: &std::path::Path,
    kernel_can_userns_sandbox: bool,
) -> bool {
    if kernel_can_userns_sandbox {
        return false;
    }
    chrome.parent().is_some_and(|runtime| {
        runtime.join("LOBSTER_ENGINE.json").is_file() && !runtime.join("chrome_sandbox").is_file()
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
        entries
            .filter_map(Result::ok)
            .any(|entry| entry.file_name().to_string_lossy().starts_with("renderD"))
    })
}

/// Point the sidecar at the packaged/user-local engine and font resources. These are resolved
/// independently: Linux `.deb` resources contain the font pack while the large Lobium runtime may
/// live in the per-user product installation.
fn ensure_lobium_env(app: &tauri::AppHandle) {
    let resource_dir = app_resource_dir(app);
    // Shared with engine_status()/provision_engine() so all three agree on where the engine lives —
    // and so it resolves at all on Windows, where HOME is unset.
    let user_runtime = user_engine_runtime_dir();

    // A value inherited when the desktop process started is the documented developer override. Only
    // publish the managed-origin marker together with a path selected by this process.
    #[cfg(target_os = "windows")]
    {
        if std::env::var_os("LOBSTER_LOBIUM_BIN").is_some()
            && !LOBIUM_BIN_IS_MANAGED.load(Ordering::Acquire)
        {
            std::env::remove_var(MANAGED_ENGINE_BIN_ORIGIN_ENV);
        }
    }

    // Same resolver as engine_status and provision_engine - see engine_manifest_path.
    let manifest = engine_manifest_path(app);
    let managed_source = match engine_provision::resolve_source(manifest.as_deref()) {
        Ok(source) => Some(source),
        Err(error) => {
            tracing::warn!(%error, "managed Lobium source is unavailable; canonical runtime denied");
            None
        }
    };
    publish_managed_engine_expectation(managed_source.as_ref());

    if std::env::var_os("LOBSTER_LOBIUM_BIN").is_none() {
        let mut resource_candidates = Vec::new();
        if let Some(resources) = resource_dir.as_ref() {
            resource_candidates.push(resources.join("lobium").join(CHROME_BIN));
            resource_candidates.push(resources.join("engines").join("lobium").join(CHROME_BIN));
        }
        // ORDER MATTERS, AND IT IS NOT THE OBVIOUS ONE. The bundled engine used to be taken
        // unconditionally, which is what made "engine bundled in the installer" mean "engine can
        // never be updated": a newer runtime provisioned from the manifest sat on disk unused, and
        // the only way to move an engine was to rebuild and redistribute the installer.
        //
        // A managed runtime is preferred ONLY when it satisfies the current manifest. That is the
        // whole condition: it exists, and it is the engine the manifest currently names. Otherwise
        // the bundled copy wins, so a fresh install runs immediately with no download, and a machine
        // that has never updated behaves exactly as if this branch did not exist.
        let managed = user_runtime
            .as_ref()
            .and_then(|runtime| current_managed_lobium_bin(runtime, managed_source.as_ref()));
        if let Some(chrome) = managed {
            publish_lobium_env(&chrome, LobiumBinOrigin::Managed);
        } else if let Some(chrome) = resource_candidates.into_iter().find(|path| path.is_file()) {
            publish_lobium_env(&chrome, LobiumBinOrigin::NonManaged);
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
async fn stop_profile(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    id: String,
) -> Result<serde_json::Value, String> {
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    let result = local_api::stop_profile_via_sidecar(&state.db, sidecar, &id)
        .await
        .map_err(|e| e.to_string())?;
    // A stopped profile is the one moment every store is mutually consistent, which is why the backup
    // is triggered here and not on a timer. It runs behind the returned result: the Stop button must
    // not wait on a capture, let alone on an upload.
    profile_sync::spawn_backup_after_stop(app, id);
    Ok(result)
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

/// Start the per-profile web agent. The profile does not need to be launched: the run begins with
/// the browser closed, and the browser opens only if the agent takes a browser action (the
/// `run.needsBrowser` → launch → `agent.attachBrowser` round-trip below). Returns `{ sessionId, profileId }`;
/// progress arrives on the UI as streamed `agent-event` Tauri events. `llm` carries the provider +
/// model; a BYOK key supplied inline is persisted ENCRYPTED at rest (SecretCipher, global
/// `scope='provider'`) and then forwarded to the sidecar over local stdio for the run — it is never
/// written in plaintext or logged. Memory lives under the profile's own dir with a per-profile key, so
/// it can never touch another profile's memory.
#[tauri::command]
async fn agent_start(
    state: State<'_, AppState>,
    id: String,
    task: String,
    mut llm: serde_json::Value,
    config: Option<serde_json::Value>,
) -> Result<serde_json::Value, String> {
    validate_agent_id(&id)?;
    if task.trim().is_empty() || task.len() > 20_000 {
        return Err("agent task must be 1..20000 characters".to_string());
    }
    let llm_obj = llm
        .as_object_mut()
        .ok_or_else(|| "llm must be an object".to_string())?;
    let provider = llm_obj
        .get("provider")
        .and_then(serde_json::Value::as_str)
        .ok_or_else(|| "llm.provider is required".to_string())?
        .to_string();
    agent_secrets::validate_provider(&provider).map_err(|e| e.to_string())?;
    let managed = llm_obj.get("managed").and_then(serde_json::Value::as_bool) == Some(true);
    // A client-supplied base URL is never trusted — managed mode's URL comes from operator env only,
    // and BYOK always uses the built-in provider endpoint. This keeps the model/UI from redirecting a
    // credential or the proxy token to an arbitrary host (SSRF guard).
    if llm_obj.get("baseUrl").is_some() {
        return Err("custom LLM base URLs are not accepted by desktop IPC".to_string());
    }
    // The provider key only matters for BYOK; in managed mode the server holds the OpenRouter key.
    let supplied_key = llm_obj
        .remove("apiKey")
        .and_then(|value| value.as_str().map(ToString::to_string));
    let (byok_key, memory_key) = {
        let conn = state
            .db
            .lock()
            .map_err(|_| "profile store lock poisoned".to_string())?;
        profile_store::get(&conn, &state.cipher, &id)
            .map_err(|e| e.to_string())?
            .ok_or_else(|| "profile not found".to_string())?;
        let memory_key =
            agent_secrets::memory_key(&conn, &state.cipher, &id).map_err(|e| e.to_string())?;
        let byok_key = if managed {
            None
        } else {
            if let Some(key) = supplied_key.as_deref() {
                agent_secrets::set_provider_key(&conn, &state.cipher, &provider, Some(key))
                    .map_err(|e| e.to_string())?;
            }
            Some(
                agent_secrets::provider_key(&conn, &state.cipher, &provider)
                    .map_err(|e| e.to_string())?
                    .ok_or_else(|| format!("no API key is stored for {provider}"))?,
            )
        };
        (byok_key, memory_key)
    };
    if managed {
        // Managed runs go through the backend proxy: its base follows the API origin this app signs
        // in against, and the bearer is a short-lived agent token minted from that session — never an
        // OpenRouter key. The sidecar's managed client uses `apiKey` as the proxy bearer token, and
        // resolves it again per model call so a token that turns over mid-run does not end the run.
        let access = agent_proxy::access(false)
            .await
            .map_err(|e| e.to_string())?;
        let credential = match access {
            // A refusal is the product answer, not a failure: the account is on a package that does
            // not include Lobee, has no Credit left, or is not signed in. The backend's own sentence
            // is what the user reads, so the desktop and the panel never disagree about why.
            agent_proxy::Access::Denied(refusal) => return Err(refusal.message),
            agent_proxy::Access::Granted(credential) => credential,
        };
        llm_obj.insert(
            "baseUrl".to_string(),
            serde_json::Value::String(credential.base_url.clone()),
        );
        llm_obj.insert(
            "apiKey".to_string(),
            serde_json::Value::String(credential.token.clone()),
        );
        if let Some(sidecar) = state.sidecar.as_ref() {
            // Keep the sidecar's copy in step with the run's, so its mid-run renewal continues from
            // the same token rather than one minted under a session that has since changed.
            let _ = sidecar
                .call(
                    "agent.setCredential",
                    agent_proxy::sidecar_params(&agent_proxy::Access::Granted(credential)),
                )
                .await;
        }
    } else if let Some(key) = byok_key {
        llm_obj.insert("apiKey".to_string(), serde_json::Value::String(key));
    }
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    // The browser is NOT launched here. The run starts against a closed browser; only if the agent
    // decides the task needs the web does it emit `run.needsBrowser`, which the event forwarder
    // answers by launching the profile and calling `agent.attachBrowser` (see setup). A pure Q&A
    // task therefore never opens a window.
    let memory_dir = state.profiles_dir.join(&id).join("agent");
    let params = serde_json::json!({
        "profileId": id,
        "task": task,
        "memoryDir": memory_dir.to_string_lossy(),
        "memoryKey": memory_key,
        "llm": llm,
        "config": config,
    });
    sidecar
        .call("agent.start", params)
        .await
        .map_err(|e| e.to_string())
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentApiKeyStatus {
    stored: bool,
}

#[tauri::command]
fn agent_set_api_key(
    state: State<'_, AppState>,
    provider: String,
    api_key: Option<String>,
) -> Result<AgentApiKeyStatus, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "profile store lock poisoned".to_string())?;
    let stored =
        agent_secrets::set_provider_key(&conn, &state.cipher, &provider, api_key.as_deref())
            .map_err(|e| e.to_string())?;
    Ok(AgentApiKeyStatus { stored })
}

#[tauri::command]
fn agent_api_key_status(
    state: State<'_, AppState>,
    provider: String,
) -> Result<AgentApiKeyStatus, String> {
    let conn = state
        .db
        .lock()
        .map_err(|_| "profile store lock poisoned".to_string())?;
    let stored = agent_secrets::has_provider_key(&conn, &provider).map_err(|e| e.to_string())?;
    Ok(AgentApiKeyStatus { stored })
}

/// Validate a BYOK key and list the chat models it can use. Uses the supplied `api_key` when present
/// (the just-typed key, for immediate validation), otherwise the stored encrypted key. The key is sent
/// to the sidecar over local stdio only for the provider round-trip; it is never logged.
#[tauri::command]
async fn agent_list_models(
    state: State<'_, AppState>,
    provider: String,
    api_key: Option<String>,
) -> Result<serde_json::Value, String> {
    agent_secrets::validate_provider(&provider).map_err(|e| e.to_string())?;
    let key = match api_key.as_deref().map(str::trim).filter(|k| !k.is_empty()) {
        Some(k) => k.to_string(),
        None => {
            let conn = state
                .db
                .lock()
                .map_err(|_| "profile store lock poisoned".to_string())?;
            agent_secrets::provider_key(&conn, &state.cipher, &provider)
                .map_err(|e| e.to_string())?
                .ok_or_else(|| format!("no API key is stored for {provider}"))?
        }
    };
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    sidecar
        .call(
            "agent.listModels",
            serde_json::json!({ "provider": provider, "apiKey": key }),
        )
        .await
        .map_err(|e| e.to_string())
}

fn validate_agent_id(id: &str) -> Result<(), String> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'_' || byte == b'-')
    {
        return Err("invalid profile id".to_string());
    }
    Ok(())
}

/// Stop a running agent on a profile (idempotent).
#[tauri::command]
async fn agent_stop(state: State<'_, AppState>, id: String) -> Result<serde_json::Value, String> {
    validate_agent_id(&id)?;
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    sidecar
        .call("agent.stop", serde_json::json!({ "profileId": id }))
        .await
        .map_err(|e| e.to_string())
}

/// Answer an agent that is awaiting human input (an `ask`, or a `confirm` verdict `approve`/`reject`).
#[tauri::command]
async fn agent_send_input(
    state: State<'_, AppState>,
    id: String,
    text: String,
) -> Result<serde_json::Value, String> {
    validate_agent_id(&id)?;
    if text.is_empty() || text.len() > 20_000 {
        return Err("agent input must be 1..20000 characters".to_string());
    }
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    sidecar
        .call(
            "agent.sendInput",
            serde_json::json!({ "profileId": id, "text": text }),
        )
        .await
        .map_err(|e| e.to_string())
}

/// Snapshot running agents (all profiles, or one) — backs the running-agents tray + per-row status.
#[tauri::command]
async fn agent_status(
    state: State<'_, AppState>,
    id: Option<String>,
) -> Result<serde_json::Value, String> {
    if let Some(value) = id.as_deref() {
        validate_agent_id(value)?;
    }
    let sidecar = state
        .sidecar
        .as_ref()
        .ok_or("engine-runner sidecar is not available (failed to start)")?;
    sidecar
        .call("agent.status", serde_json::json!({ "profileId": id }))
        .await
        .map_err(|e| e.to_string())
}

/// Where the desktop app writes its log. `%LOCALAPPDATA%\lobster\logs` / `~/.local/share/lobster/logs`.
///
/// Beside the engine runtime dir rather than under the Tauri app-data dir, because logging is
/// initialised BEFORE the Tauri builder exists and therefore cannot ask `app.path()` for anything.
fn user_log_dir() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("LOCALAPPDATA")
            .map(PathBuf::from)
            .or_else(|| user_home_dir().map(|home| home.join("AppData").join("Local")))
            .map(|base| base.join("lobster").join("logs"))
    }
    #[cfg(not(windows))]
    {
        user_home_dir().map(|home| home.join(".local/share/lobster/logs"))
    }
}

/// A `MakeWriter` over one shared append-mode file.
///
/// `tracing_subscriber` implements `MakeWriter` for `Fn() -> W`, so this only has to be a `Write`
/// that can be handed out repeatedly. The mutex makes a whole formatted event one `write_all`, which
/// is what stops two threads interleaving mid-line — a log that shreds its own lines under
/// concurrency is worse than no log, because it reads as corruption rather than as contention.
#[derive(Clone)]
struct SharedFileWriter(std::sync::Arc<std::sync::Mutex<std::fs::File>>);

impl std::io::Write for SharedFileWriter {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        match self.0.lock() {
            Ok(mut file) => file.write_all(buf).map(|()| buf.len()),
            // A poisoned mutex means another thread panicked mid-log. Dropping the line is strictly
            // better than propagating a panic out of the logger and taking the app with it.
            Err(_) => Ok(buf.len()),
        }
    }
    fn flush(&mut self) -> std::io::Result<()> {
        match self.0.lock() {
            Ok(mut file) => file.flush(),
            Err(_) => Ok(()),
        }
    }
}

/// Initialise logging to a FILE, and say where.
///
/// WHY A FILE. `tracing_subscriber::fmt()` defaults to stdout, and a Tauri app is built for the
/// Windows GUI subsystem — it has no console attached, so on the shipped Windows product every log
/// line went to a handle nobody could read. Combined with sidecar stderr being logged at `debug!`
/// under an `INFO` max level (so it was filtered out even in a dev console), the practical effect
/// was that the installed product produced NO diagnostic output at all.
///
/// That is why the phantom first launch — `launch` returns a pid and `code=0`, yet no engine process
/// exists and `stop` reports nothing running — has never been explained: the one component that
/// knows what happened, the sidecar, was writing its reason into a void.
///
/// `LOBSTER_LOG` overrides the level (`trace`/`debug`/`info`/`warn`/`error`). The previous log is
/// kept as `.1` so a crash-and-relaunch does not destroy the evidence of the crash.
fn init_logging() -> Option<PathBuf> {
    let level = match std::env::var("LOBSTER_LOG").unwrap_or_default().to_ascii_lowercase().as_str() {
        "trace" => tracing::Level::TRACE,
        "debug" => tracing::Level::DEBUG,
        "warn" => tracing::Level::WARN,
        "error" => tracing::Level::ERROR,
        // DEBUG by default, not INFO: sidecar stderr is logged at debug, and that is precisely the
        // stream needed to diagnose a launch that reports success and does nothing.
        _ => tracing::Level::DEBUG,
    };

    let path = user_log_dir().map(|dir| dir.join("lobster.log"));
    if let Some(path) = path {
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        // Rotate once, so the log cannot grow without bound and the previous run survives.
        if let Ok(meta) = std::fs::metadata(&path) {
            if meta.len() > 8 * 1024 * 1024 {
                let _ = std::fs::rename(&path, path.with_extension("log.1"));
            }
        }
        if let Ok(file) = std::fs::OpenOptions::new().create(true).append(true).open(&path) {
            let writer = SharedFileWriter(std::sync::Arc::new(std::sync::Mutex::new(file)));
            // WINDOWS ONLY takes the file-only path. The no-console problem this exists for is
            // specific to the Windows GUI subsystem; on Linux and macOS the app is routinely run
            // from a terminal, and silently swallowing stdout there would REMOVE working
            // diagnostics to fix a platform that never had any. So elsewhere the same events go to
            // BOTH the file and stderr.
            #[cfg(windows)]
            {
                tracing_subscriber::fmt()
                    .with_max_level(level)
                    .with_ansi(false) // a file is not a terminal; escape codes only obscure it
                    .with_writer(move || writer.clone())
                    .init();
            }
            #[cfg(not(windows))]
            {
                // `Tee` rather than two layers, to keep this free of extra crates.
                struct Tee(SharedFileWriter);
                impl std::io::Write for Tee {
                    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
                        let _ = std::io::Write::write_all(&mut std::io::stderr(), buf);
                        std::io::Write::write(&mut self.0.clone(), buf)
                    }
                    fn flush(&mut self) -> std::io::Result<()> {
                        let _ = std::io::Write::flush(&mut std::io::stderr());
                        std::io::Write::flush(&mut self.0.clone())
                    }
                }
                tracing_subscriber::fmt()
                    .with_max_level(level)
                    .with_ansi(false)
                    .with_writer(move || Tee(writer.clone()))
                    .init();
            }
            return Some(path);
        }
    }

    // No writable log location. Fall back to the old behaviour rather than losing logging entirely
    // on a host with an unusual profile layout.
    tracing_subscriber::fmt().with_max_level(level).init();
    None
}

/// Application entrypoint invoked by `main.rs` (and the mobile entry macro later).
pub fn run() {
    let log_path = init_logging();
    tracing::info!(
        version = env!("CARGO_PKG_VERSION"),
        log = ?log_path,
        "lobster desktop starting"
    );

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

    // Native save/open dialogs, used only by profile export/import. A profile file can be tens of
    // megabytes and the user chooses where it lands, so the `<a download>` blob trick the cookie
    // export uses is not an option here.
    builder = builder.plugin(tauri_plugin_dialog::init());

    builder
        .setup(|app| {
            // Open the local profile store under the OS app-data dir.
            // De-verbatim'd for the same reason as the resource dir: `profiles_dir` derives from this
            // and is handed to the Node sidecar as the agent `memoryDir`, where the journal and memory
            // stores do path-containment checks. A `\\?\`-prefixed root would not compare equal to the
            // plain paths those checks resolve, so containment could fail on correct input.
            let dir = strip_verbatim_prefix(app.path().app_data_dir().map_err(|e| e.to_string())?);
            std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
            let conn =
                profile_store::init(dir.join("profiles.sqlite")).map_err(|e| e.to_string())?;
            proxy_store::init(&conn).map_err(|e| e.to_string())?;
            template_store::init(&conn).map_err(|e| e.to_string())?;
            agent_secrets::init(&conn).map_err(|e| e.to_string())?;
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
                            // Owner-only where the platform expresses it as a mode. On Windows the
                            // file inherits the user-profile ACL and stays in the clear on purpose:
                            // this is a bearer token that external automation clients READ, so it
                            // cannot be user-bound the way the store key is (see `keychain`).
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
            // Refresh the engine manifest BEFORE anything reads it.
            //
            // This is what lets a published engine reach clients that are already installed: the
            // manifest ships inside the installer, so without this an engine republish silently
            // invalidated every installer already downloaded - the copy inside still pinned the old
            // digest, the hash check failed, and the first-run screen retried forever. That shipped
            // twice.
            //
            // Blocking, with a short deadline, and deliberately so: ensure_lobium_env, engine_status
            // and provision_engine must all see the SAME manifest within one launch. Refreshing in
            // the background would let the file change between two of those reads, and a client that
            // installed the engine one named while the other reported none present would provision
            // in a loop. A failure here is a no-op - the bundled manifest still applies - so a user
            // offline on first run is no worse off than before.
            {
                let handle = app.handle().clone();
                let cache = dir.join("engine-manifest.json");
                let url = engine_provision::remote_manifest_url();
                let refreshed = tauri::async_runtime::block_on(async {
                    engine_provision::refresh_manifest_cache(
                        &cache,
                        &url,
                        std::time::Duration::from_secs(6),
                    )
                    .await
                });
                match refreshed {
                    Ok(()) => tracing::info!(%url, "engine manifest refreshed"),
                    Err(error) => {
                        tracing::warn!(%error, %url, "engine manifest not refreshed; using the bundled copy")
                    }
                }
                let _ = handle;
            }
            ensure_lobium_env(app.handle());

            // BACKGROUND ENGINE UPDATE. The installer carries an engine, so first run needs no
            // download and the gate passes straight through. That is the whole point of bundling -
            // and it is also how bundling previously made engines unupdatable, because nothing ever
            // looked again.
            //
            // So: if the refreshed manifest names an engine that is not the one in use, fetch it
            // here, in the background, after the window is already up. ensure_lobium_env prefers a
            // managed runtime that satisfies the manifest, so the new engine takes effect on the
            // NEXT launch. Deliberately not applied mid-session: swapping the engine under running
            // profiles would kill live browsers.
            //
            // Silent by design. The user asked for a browser, not a maintenance report; a failure
            // here costs nothing because the bundled engine still runs.
            {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    let manifest = engine_manifest_path(&handle);
                    let Ok(source) = engine_provision::resolve_source(manifest.as_deref()) else {
                        return;
                    };
                    let Some(runtime_dir) = user_engine_runtime_dir() else {
                        return;
                    };
                    if engine_provision::engine_matches_source(&runtime_dir, &source) {
                        return; // already have exactly this engine
                    }
                    if bundled_engine_satisfies(&handle, &source) {
                        return; // the shipped engine IS the one the manifest names
                    }
                    tracing::info!(version = %source.version, "a newer engine is published; fetching it for the next launch");
                    match engine_provision::provision(&source, &runtime_dir, |_, _| {}).await {
                        Ok(()) => tracing::info!("engine update staged; it takes effect on the next launch"),
                        Err(error) => tracing::warn!(%error, "engine update failed; the bundled engine still applies"),
                    }
                });
            }
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

            // Forward per-profile agent events (streamed by the sidecar as `notify` lines) to the UI as
            // `agent-event` Tauri events, and answer `run.needsBrowser` by launching the profile and
            // attaching it to the waiting run (the lazy-launch round-trip). Subscribe BEFORE the sidecar
            // Option is moved into the local API state below. A lagged/closed channel ends the forwarder
            // without touching the sidecar.
            if let Some(sc) = sidecar.as_ref() {
                let mut rx = sc.subscribe();
                let handle = app.handle().clone();
                let attach_sidecar = sc.clone();
                let attach_db = db.clone();
                let attach_cipher = cipher.clone();
                let attach_profiles_dir = profiles_dir.clone();
                let credential_sidecar = sc.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        match rx.recv().await {
                            Ok(v) => {
                                // A run whose agent token was rejected asks for a new one rather than
                                // dying. Minting is forced: the sidecar only asks after the proxy
                                // refused what it had, so the cached copy is exactly what must not be
                                // handed back.
                                if v.get("notify").and_then(serde_json::Value::as_str)
                                    == Some("agentCredential")
                                {
                                    let sidecar = credential_sidecar.clone();
                                    tauri::async_runtime::spawn(async move {
                                        agent_proxy::push(&sidecar, true).await;
                                    });
                                    continue;
                                }
                                let payload = v.get("event").cloned().unwrap_or(v);
                                if payload.get("type").and_then(serde_json::Value::as_str)
                                    == Some("run.needsBrowser")
                                {
                                    if let Some(profile_id) = payload
                                        .get("profileId")
                                        .and_then(serde_json::Value::as_str)
                                        .map(ToString::to_string)
                                    {
                                        let sidecar = attach_sidecar.clone();
                                        let db = attach_db.clone();
                                        let cipher = attach_cipher.clone();
                                        let profiles_dir = attach_profiles_dir.clone();
                                        tauri::async_runtime::spawn(async move {
                                            // Skip the launch when the profile is already running —
                                            // attachBrowser re-resolves the live endpoint either way.
                                            let already_running = db
                                                .lock()
                                                .ok()
                                                .and_then(|conn| {
                                                    profile_store::get(&conn, &cipher, &profile_id)
                                                        .ok()
                                                        .flatten()
                                                })
                                                .map(|p| p.status == "running")
                                                .unwrap_or(false);
                                            let launch_error = if already_running {
                                                None
                                            } else {
                                                local_api::start_profile_via_sidecar(
                                                    &db,
                                                    &cipher,
                                                    &sidecar,
                                                    &profiles_dir,
                                                    &profile_id,
                                                    None,
                                                    false,
                                                )
                                                .await
                                                .err()
                                                .map(|e| e.to_string())
                                            };
                                            let params = match launch_error {
                                                None => serde_json::json!({
                                                    "profileId": profile_id,
                                                }),
                                                Some(error) => serde_json::json!({
                                                    "profileId": profile_id,
                                                    "error": error,
                                                }),
                                            };
                                            if let Err(error) =
                                                sidecar.call("agent.attachBrowser", params).await
                                            {
                                                tracing::error!(
                                                    %error,
                                                    "agent.attachBrowser failed"
                                                );
                                            }
                                        });
                                    }
                                }
                                let _ = handle.emit("agent-event", payload);
                            }
                            Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                            Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                        }
                    }
                });

                // Hand the sidecar an agent credential at startup and keep it current.
                //
                // Nothing else can: the token is minted from the session in the OS keychain, which
                // only this process can read, and the in-browser Lobee panel starts runs through the
                // sidecar without the desktop in the loop. Without this push, a panel run had no
                // credential at all — which is exactly how managed Lobee came to be dead in a real
                // install while looking perfectly alive in the UI.
                let renew_sidecar = sc.clone();
                tauri::async_runtime::spawn(async move {
                    loop {
                        agent_proxy::push(&renew_sidecar, false).await;
                        tokio::time::sleep(std::time::Duration::from_secs(5 * 60)).await;
                    }
                });
            }

            app.manage(AppState {
                db: db.clone(),
                sidecar: sidecar.clone(),
                profiles_dir: profiles_dir.clone(),
                cipher: cipher.clone(),
                account_key: Arc::new(Mutex::new(None)),
                sign_in: cloud_auth::SignInCoordinator::default(),
            });

            // Bring this machine and the account into agreement, behind first paint. A second machine
            // has nothing to restore into until this runs: it is what creates the local rows for
            // profiles the account holds and this install has never seen.
            profile_sync::spawn_startup_reconcile(app.handle().clone());

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
            profile_sync::sync_push_profile,
            profile_sync::sync_pull_profile,
            profile_sync::sync_now,
            profile_sync::sync_status,
            account_summary,
            open_billing,
            open_pricing,
            auth_status_cached,
            vault_status,
            app_version,
            auth_status,
            auth_sign_in,
            auth_cancel_sign_in,
            auth_sign_out,
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
            update_template,
            duplicate_template,
            delete_template,
            launch_profile,
            stop_profile,
            export_profile_cookies,
            encrypt_profile_blob,
            decrypt_profile_blob,
            snapshot::commands::snapshot_list,
            snapshot::commands::snapshot_capture,
            snapshot::commands::snapshot_restore,
            snapshot::commands::snapshot_verify,
            profile_portable::export_profile_file,
            profile_portable::inspect_profile_file,
            profile_portable::import_profile_file,
            profile_portable::cancel_profile_file_op,
            agent_start,
            agent_set_api_key,
            agent_api_key_status,
            agent_list_models,
            agent_stop,
            agent_send_input,
            agent_status
        ])
        .run(tauri::generate_context!())
        .expect("error while running the Lobster desktop application");
}

#[cfg(test)]
mod lifecycle_tests {
    use super::{
        current_managed_lobium_bin, discovered_lobium_bin_origin, explicit_lobium_bin_from,
        first_font_pack_dir, managed_engine_expectation, remove_profile_data_dir, LobiumBinOrigin,
        CHROME_BIN,
    };

    #[cfg(target_os = "windows")]
    use super::managed_engine_bin_origin_value;

    #[cfg(target_os = "linux")]
    use super::packaged_runtime_needs_software_gpu;

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

    #[test]
    fn explicit_engine_origin_distinguishes_local_package_from_managed_discovery() {
        let root =
            std::env::temp_dir().join(format!("lobster-explicit-engine-{}", uuid::Uuid::new_v4()));
        let managed_runtime = root.join("managed");
        let missing_override = root.join("missing").join(CHROME_BIN);

        let error = explicit_lobium_bin_from(Some(missing_override.clone()), false)
            .expect_err("a missing developer override must not silently use the managed engine");
        assert!(error.contains("LOBSTER_LOBIUM_BIN"), "{error}");
        assert!(error.contains("update or unset"), "{error}");

        std::fs::create_dir_all(missing_override.parent().unwrap()).unwrap();
        std::fs::write(&missing_override, b"browser").unwrap();
        assert_eq!(
            explicit_lobium_bin_from(Some(missing_override.clone()), false,).unwrap(),
            Some(missing_override),
            "a real explicit developer binary remains supported"
        );

        // A pre-set override remains explicit even at the canonical Windows install path. This is
        // how a locally packaged engine can be exercised before a win-x64 download is published.
        let canonical = managed_runtime.join(CHROME_BIN);
        std::fs::create_dir_all(&managed_runtime).unwrap();
        std::fs::write(&canonical, b"browser").unwrap();
        assert_eq!(
            explicit_lobium_bin_from(Some(canonical.clone()), false).unwrap(),
            Some(canonical.clone())
        );

        // But the exact same path auto-published by ensure_lobium_env is not an override. Status and
        // provisioning must evaluate the exact manifest version + digest stamp for this branch.
        assert_eq!(
            explicit_lobium_bin_from(Some(canonical), true).unwrap(),
            None,
            "auto-discovery must not weaken the managed-runtime integrity contract"
        );

        let resource_runtime = root.join("resources").join("lobium");
        let resource_chrome = resource_runtime.join(CHROME_BIN);
        std::fs::create_dir_all(&resource_runtime).unwrap();
        std::fs::write(&resource_chrome, b"browser").unwrap();
        assert_eq!(
            discovered_lobium_bin_origin(&resource_chrome, Some(&managed_runtime)),
            LobiumBinOrigin::NonManaged,
            "a bundled resource runtime must not be subjected to the downloader stamp"
        );
        assert_eq!(
            explicit_lobium_bin_from(Some(resource_chrome.clone()), false).unwrap(),
            Some(resource_chrome),
            "a discovered bundled runtime remains directly usable"
        );
        assert_eq!(
            discovered_lobium_bin_origin(&managed_runtime.join(CHROME_BIN), Some(&managed_runtime)),
            LobiumBinOrigin::Managed,
            "canonical user-runtime discovery must retain exact manifest validation"
        );
        assert!(
            LobiumBinOrigin::Managed.is_managed(),
            "provision_engine must publish downloaded runtimes with managed origin"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn managed_discovery_requires_the_exact_resolved_source_stamp() {
        let root =
            std::env::temp_dir().join(format!("lobster-managed-engine-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::write(root.join(CHROME_BIN), b"browser").unwrap();
        let source = crate::engine_provision::EngineSource {
            url: "https://example.invalid/lobium.zip".into(),
            sha256: "A".repeat(64),
            version: "152.0.7977.42".into(),
        };

        assert_eq!(
            managed_engine_expectation(Some(&source)),
            Some((source.version.clone(), "a".repeat(64))),
            "the sidecar expectation must use lowercase canonical archive hex"
        );
        assert!(current_managed_lobium_bin(&root, None).is_none());
        assert!(current_managed_lobium_bin(&root, Some(&source)).is_none());
        std::fs::write(
            root.join(".lobium-engine-version"),
            format!("version={}\nsha256={}\n", source.version, "b".repeat(64)),
        )
        .unwrap();
        assert!(current_managed_lobium_bin(&root, Some(&source)).is_none());
        std::fs::write(
            root.join(".lobium-engine-version"),
            format!(
                "version={}\nsha256={}\n",
                source.version,
                source.sha256.to_ascii_lowercase()
            ),
        )
        .unwrap();
        assert_eq!(
            current_managed_lobium_bin(&root, Some(&source)),
            Some(root.join(CHROME_BIN))
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn managed_origin_sidecar_marker_is_windows_only_and_origin_bound() {
        assert_eq!(
            managed_engine_bin_origin_value(LobiumBinOrigin::Managed),
            Some("managed")
        );
        assert_eq!(
            managed_engine_bin_origin_value(LobiumBinOrigin::NonManaged),
            None
        );
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_sandbox_is_only_disabled_where_the_kernel_cannot_provide_one() {
        use super::packaged_runtime_needs_no_sandbox_with as needs;
        let root = std::env::temp_dir().join(format!("lobster-runtime-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let chrome = root.join("chrome");
        std::fs::write(&chrome, b"").unwrap();

        // A kernel that CAN do the user-namespace sandbox never needs the flag, whatever the
        // runtime looks like. This is the case on any current kernel, and it is what removes both
        // the security downgrade and Chromium's yellow --no-sandbox infobar.
        std::fs::write(root.join("LOBSTER_ENGINE.json"), b"{}").unwrap();
        assert!(!needs(&chrome, true), "userns kernel must keep the sandbox");

        // Only where the kernel cannot does the old shape of the runtime decide.
        assert!(
            needs(&chrome, false),
            "marked runtime, no setuid helper, no userns -> must disable"
        );
        std::fs::write(root.join("chrome_sandbox"), b"").unwrap();
        assert!(
            !needs(&chrome, false),
            "a setuid helper is a sandbox, so the flag is not needed"
        );
        std::fs::remove_file(root.join("chrome_sandbox")).unwrap();
        std::fs::remove_file(root.join("LOBSTER_ENGINE.json")).unwrap();
        assert!(
            !needs(&chrome, false),
            "an unmarked/system Chromium is never relaxed"
        );
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

#[cfg(test)]
mod startup_tests {
    /// The boot path must not contain a network call.
    ///
    /// `auth_status_cached` exists so first paint answers from local state; if someone later routes
    /// it through `current_user` (or any HTTP client) the 15-second `/auth/me` timeout is back on the
    /// critical path and a cold start looks like a hung app again — a regression that is invisible on
    /// a fast connection and only shows up for users on a bad one.
    #[test]
    fn the_cached_auth_status_makes_no_network_call() {
        let source = include_str!("lib.rs");
        let start = source
            .find("fn auth_status_cached()")
            .expect("auth_status_cached must exist");
        let body_end = source[start..]
            .find("\n}")
            .expect("function body must terminate");
        let body = &source[start..start + body_end];

        for forbidden in ["current_user", "reqwest", "await", ".send("] {
            assert!(
                !body.contains(forbidden),
                "auth_status_cached must stay local, but its body mentions `{forbidden}`"
            );
        }
    }
}
