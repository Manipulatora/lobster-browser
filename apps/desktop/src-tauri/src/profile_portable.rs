//! A profile as ONE portable file: `.lobprofile`.
//!
//! ## Why this is not `profile_sync`
//!
//! [`crate::profile_sync`] already moves a snapshot between machines, but it seals under the ACCOUNT
//! key and needs a signed-in session at both ends. A file that a user mails to themselves, drops on a
//! USB stick, or archives before reinstalling has to open with nothing but a passphrase. That single
//! difference — passphrase instead of account key — is the whole reason this module exists; the
//! capture and restore machinery underneath is the same snapshot ledger, deliberately not duplicated.
//!
//! ## Why the file carries the profile ROW and not just the data
//!
//! The row is the authority on identity, not the user-data-dir: `writeLobiumConfig` rewrites
//! `lobium-fp.json` from the row's seed, overrides and proxy on EVERY launch. A file containing only
//! cookies and site data would restore a session onto a *different device* — same logins, different
//! fingerprint — which is precisely the condition that gets an account flagged.
//!
//! The seed specifically is load-bearing. It is immutable and unique per profile, and import PINS it
//! (`CreateProfileInput::fingerprint_seed`). If it were not pinned the restore would be REFUSED, not
//! silently wrong: the manifest's `Identity` diff reports a persona mismatch and the restore bails.
//! That refusal is the safety net proving the seed round-tripped.
//!
//! ## What is deliberately NOT in the file
//!
//! - the per-install Local Store Key — export RE-SEALS under the passphrase, it never copies the vault
//! - the account key and the cloud token — those are account credentials, not profile data
//! - `proxy_id` / `template_id` — ids in *this* install's tables; the proxy is resolved inline instead
//! - proxy username/password — opt-in only, because the whole point of a file is that it travels
//! - `status` / `trashed_at` — transient; a fresh import is always `idle`
//!
//! ## Layout
//!
//! ```text
//! 0   4    magic "LBP1"
//! 4   4    u32 LE header length
//! 8   N    header JSON, PLAINTEXT
//! 8+N ..   one LBv1 envelope (see crate::blob_crypto) over the CBOR body
//! ```
//!
//! The header is plaintext on purpose so the import dialog can show what a file contains *before*
//! asking for its passphrase — the alternative is a password prompt for a file the user cannot
//! identify. The trade is that the profile name and OS are readable without the passphrase, which the
//! export dialog states outright. Everything that matters — cookies, logins, site data, the seed —
//! is inside the envelope.
//!
//! CBOR rather than JSON for the body because artifact payloads are raw bytes: `serde_json` renders a
//! `Vec<u8>` as a list of decimal numbers and inflates a 50 MB profile roughly fourfold.

use std::fs;
use std::io::{Read, Write};
use std::path::Path;

use anyhow::{anyhow, bail, Context, Result};
use argon2::{Algorithm, Argon2, Params, Version};
use serde::{Deserialize, Serialize};
use tauri::State;

use crate::blob_crypto::{BlobCipher, LB_V1_KEY_ID_LEN, LB_V1_KEY_LEN};
use crate::profile_store::{self, CreateProfileInput, Profile};
use crate::snapshot::manifest::{CaptureMode, SnapshotManifest};
use crate::snapshot::vault::SnapshotVault;
use crate::snapshot::{self, CaptureOptions, RestoreReport};
use crate::AppState;

const MAGIC: &[u8; 4] = b"LBP1";
/// Bump only for a breaking body change. A reader that sees a higher number refuses with a message
/// telling the user to update, rather than misparsing a newer layout.
///
/// v2: artifact payloads are CBOR byte strings (see [`ArtifactBytes`]) and the body is deflated. A v1
/// reader handed a v2 file would decode neither, so it refuses on the version instead — and this
/// reader still opens v1 files, which is the half of the promise that matters to anyone holding one.
const FORMAT_VERSION: u32 = 2;
/// A header larger than this is a corrupt or hostile file, not one of ours; refuse before allocating.
const MAX_HEADER_BYTES: u32 = 256 * 1024;
/// Argon2id cost. 64 MiB / 3 passes is the OWASP baseline and takes well under a second on a laptop,
/// while making an offline guessing run against a stolen file expensive.
const KDF_MEMORY_KIB: u32 = 65_536;
const KDF_PASSES: u32 = 3;
const KDF_LANES: u32 = 1;
const BODY_DEFLATE_LEVEL: flate2::Compression = flate2::Compression::new(1);

/// Fields on the proxy blob that are credentials rather than routing.
const PROXY_SECRET_FIELDS: [&str; 2] = ["username", "password"];

/// One artifact's payload, encoded as a CBOR BYTE STRING rather than an array of integers.
///
/// Not a micro-optimisation. `Vec<u8>` is a `seq` to serde, and every CBOR encoder renders a seq of
/// integers as one item per byte — two bytes on the wire for every byte above 0x17. Measured on a
/// real profile: 27.33 MB of captured artifacts produced a 53.02 MB file, and every stage after the
/// encode (Argon2 aside: the deflate, the seal, the write, and all of it again on import) paid for
/// the doubling. A byte string carries the same bytes behind a five-byte header.
///
/// The reader accepts BOTH shapes, so a file written before this existed still opens. That is why
/// this is a type and not a `serde(with = …)` on one field: the two encodings have to be one type,
/// or every reader needs a version branch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ArtifactBytes(pub Vec<u8>);

impl Serialize for ArtifactBytes {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_bytes(&self.0)
    }
}

impl<'de> Deserialize<'de> for ArtifactBytes {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct Visitor;

        impl<'de> serde::de::Visitor<'de> for Visitor {
            type Value = ArtifactBytes;

            fn expecting(&self, f: &mut std::fmt::Formatter) -> std::fmt::Result {
                f.write_str("an artifact payload as a byte string or a sequence of bytes")
            }

            fn visit_bytes<E: serde::de::Error>(self, v: &[u8]) -> Result<Self::Value, E> {
                Ok(ArtifactBytes(v.to_vec()))
            }

            fn visit_byte_buf<E: serde::de::Error>(self, v: Vec<u8>) -> Result<Self::Value, E> {
                Ok(ArtifactBytes(v))
            }

            /// The old shape: one CBOR integer per byte.
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<Self::Value, A::Error> {
                let mut out = Vec::with_capacity(seq.size_hint().unwrap_or(0));
                while let Some(byte) = seq.next_element::<u8>()? {
                    out.push(byte);
                }
                Ok(ArtifactBytes(out))
            }
        }

        deserializer.deserialize_any(Visitor)
    }
}

/// The profile row, reduced to what is portable. See the module docs for the exclusions.
///
/// Shared with [`crate::profile_sync`] rather than restated there. A row that crosses to another
/// machine has to carry the same fields whether it travels in a file or through the account, and two
/// definitions of "what travels" would drift into a field that syncs but does not export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PortableRow {
    pub source_profile_id: String,
    pub name: String,
    pub engine: String,
    pub os: String,
    pub os_version: Option<String>,
    /// Verbatim — this IS the identity, and pinning it on import is what makes the restore verify.
    pub fingerprint_seed: String,
    /// The raw column TEXT, not a re-serialized value. `Identity` digests the overrides with
    /// `serde_json::to_string`, so a decode/encode round-trip that renumbers a float would change the
    /// digest and make the import refuse its own file.
    pub fingerprint_overrides_json: Option<String>,
    pub proxy: Option<serde_json::Value>,
    pub cookies_import: Option<serde_json::Value>,
    pub cookies_import_applied_at: Option<String>,
    pub extensions: Option<serde_json::Value>,
    pub tags: Vec<String>,
    pub folder: Option<String>,
    pub notes: Option<String>,
    /// Argon2 PHC string. Not reversible, so carrying it keeps the copy locked with the same password
    /// instead of silently unlocking a protected profile by exporting it.
    pub password_hash: Option<String>,
}

/// Project a stored profile into the portable shape.
///
/// Reads two columns the [`Profile`] struct does not expose: the password hash (deliberately absent
/// from anything that reaches the UI) and the fingerprint-overrides TEXT verbatim, for the digest
/// reason above.
pub fn portable_row(conn: &rusqlite::Connection, profile: &Profile) -> Result<PortableRow> {
    let password_hash: Option<String> = conn
        .query_row(
            "SELECT password_hash FROM profiles WHERE id = ?1",
            rusqlite::params![profile.id],
            |row| row.get(0),
        )
        .with_context(|| format!("reading {}'s password hash", profile.id))?;
    let fingerprint_overrides_json: Option<String> = conn
        .query_row(
            "SELECT fingerprint_overrides FROM profiles WHERE id = ?1",
            rusqlite::params![profile.id],
            |row| row.get(0),
        )
        .with_context(|| format!("reading {}'s fingerprint overrides", profile.id))?;

    Ok(PortableRow {
        source_profile_id: profile.id.clone(),
        name: profile.name.clone(),
        engine: profile.engine.clone(),
        os: profile.os.clone(),
        os_version: profile.os_version.clone(),
        fingerprint_seed: profile.fingerprint_seed.clone(),
        fingerprint_overrides_json,
        proxy: profile.proxy.clone(),
        cookies_import: profile.cookies_import.clone(),
        cookies_import_applied_at: profile.cookies_import_applied_at.clone(),
        extensions: profile.extensions.clone(),
        tags: profile.tags.clone(),
        folder: profile.folder.clone(),
        notes: profile.notes.clone(),
        password_hash,
    })
}

/// Create a local profile from a portable row, PINNING the seed and carrying the password across.
///
/// `name` is passed separately because the caller owns collision handling: a file import renames a
/// clash, a pull keeps the account's name.
pub fn create_from_portable_row(
    conn: &rusqlite::Connection,
    cipher: &crate::secrets::SecretCipher,
    row: &PortableRow,
    name: String,
) -> Result<Profile> {
    // The seed is the imported browser identity. Validate it before parsing secondary metadata or
    // writing a row; substituting a generated seed here would make the import appear successful while
    // restoring the session onto a different fingerprint.
    profile_store::validate_fingerprint_seed(&row.fingerprint_seed)
        .context("the imported profile carries an invalid fingerprint seed")?;
    let overrides = match &row.fingerprint_overrides_json {
        Some(text) => Some(
            serde_json::from_str::<serde_json::Value>(text)
                .context("the profile's fingerprint overrides are malformed")?,
        ),
        None => None,
    };
    let created = profile_store::create_preserving_fingerprint_seed(
        conn,
        cipher,
        CreateProfileInput {
            name,
            engine: row.engine.clone(),
            os: row.os.clone(),
            os_version: row.os_version.clone(),
            fingerprint_seed: Some(row.fingerprint_seed.clone()),
            fingerprint_overrides: overrides,
            proxy: row.proxy.clone(),
            proxy_id: None,
            template_id: None,
            cookies_import: row.cookies_import.clone(),
            extensions: row.extensions.clone(),
            tags: Some(row.tags.clone()),
            folder: row.folder.clone(),
            notes: row.notes.clone(),
        },
    )
    .with_context(|| format!("creating a local profile for {}", row.source_profile_id))?;

    if let Some(hash) = &row.password_hash {
        profile_store::set_password_hash(conn, &created.id, Some(hash))
            .context("carrying the profile's password across")?;
    }
    // The stamp is what stops a launch re-injecting an import the source machine already applied.
    if row.cookies_import_applied_at.is_some() {
        profile_store::mark_cookie_import_applied(conn, &created.id)
            .context("carrying the cookie import's applied stamp across")?;
    }
    Ok(created)
}

/// A name nothing else in `existing` holds, derived from `wanted`.
///
/// Suffixed rather than rejected: a second machine's profile arriving under a name this one already
/// uses is a normal outcome, and refusing the import would leave the user with no way in at all. The
/// counter is what stops importing the same file twice producing two profiles with one name.
pub fn free_name(existing: &[Profile], wanted: &str) -> String {
    if !existing.iter().any(|p| p.name == wanted) {
        return wanted.to_string();
    }
    let mut candidate = format!("{wanted} (imported)");
    let mut suffix = 2;
    while existing.iter().any(|p| p.name == candidate) {
        candidate = format!("{wanted} (imported {suffix})");
        suffix += 1;
    }
    candidate
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableBody {
    format_version: u32,
    row: PortableRow,
    manifest: SnapshotManifest,
    /// `(artifact id, payload)` — the same shape `profile_sync` uses, so the two stay comparable.
    artifacts: Vec<(String, ArtifactBytes)>,
}

/// Encode the body for the CURRENT format: CBOR, then deflate.
///
/// Deflate level 1, not the default 6. Measured on the artifacts of a real profile, level 6 buys
/// between 0.1% and 4.6% for 40% to 110% more CPU — and the seconds are what the user waits through
/// while the dialog says "Encrypting the file".
fn encode_body(body: &PortableBody) -> Result<Vec<u8>> {
    let mut cbor = Vec::new();
    ciborium::into_writer(body, &mut cbor).context("encoding the profile for export")?;
    let mut encoder =
        flate2::write::ZlibEncoder::new(Vec::with_capacity(cbor.len() / 2), BODY_DEFLATE_LEVEL);
    encoder
        .write_all(&cbor)
        .context("compressing the profile for export")?;
    encoder
        .finish()
        .context("compressing the profile for export")
}

/// Decode a body written by ANY format version this build reads.
fn decode_body(format_version: u32, plain: &[u8]) -> Result<PortableBody> {
    let damaged = "this file is damaged and cannot be imported";
    if format_version < 2 {
        return ciborium::from_reader(plain).context(damaged);
    }
    let mut cbor = Vec::new();
    flate2::read::ZlibDecoder::new(plain)
        .read_to_end(&mut cbor)
        .context(damaged)?;
    ciborium::from_reader(&cbor[..]).context(damaged)
}

/// The plaintext preamble. Readable without the passphrase so the import dialog can describe the file.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileHeader {
    format_version: u32,
    manifest_version: u32,
    app_version: String,
    exported_at: String,
    profile_name: String,
    engine: String,
    os: String,
    os_version: Option<String>,
    source_profile_id: String,
    artifacts: Vec<String>,
    password_protected: bool,
    has_proxy: bool,
    has_proxy_credentials: bool,
    /// Length and BLAKE3 of the sealed body, so a truncated or corrupted file is diagnosed as
    /// DAMAGED before the passphrase is even tried.
    ///
    /// Without them the AEAD tag is the only check, and it cannot distinguish a wrong passphrase from
    /// a file that lost its last megabyte to a failed copy — so every damaged file would be reported
    /// as a password the user typed wrong, and they would retype it forever.
    ///
    /// Defaulted rather than required: files exported before these existed are still openable, which
    /// is the same forward/backward promise `format_version` makes.
    #[serde(default)]
    body_bytes: u64,
    #[serde(default)]
    body_digest: String,
    kdf: KdfParams,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct KdfParams {
    alg: String,
    /// Argon2 version constant (0x13 = 19).
    v: u32,
    m: u32,
    t: u32,
    p: u32,
    salt_b64: String,
}

#[derive(Debug, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct ExportOptions {
    #[serde(default)]
    pub include_proxy_credentials: bool,
    #[serde(default)]
    pub exclude_artifacts: Vec<String>,
    /// `reuse-latest` | `quiesced` | `live` | `dirty`. Defaults to a quiesced capture.
    #[serde(default)]
    pub capture: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportReport {
    pub path: String,
    pub bytes: u64,
    pub profile_id: String,
    pub profile_name: String,
    pub snapshot_version: u64,
    pub coherence: String,
    pub artifacts: Vec<String>,
    /// What the file does NOT contain, in words the dialog can show verbatim.
    pub omitted: Vec<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportPreview {
    pub format_version: u32,
    pub manifest_version: u32,
    pub profile_name: String,
    pub engine: String,
    pub os: String,
    pub os_version: Option<String>,
    pub exported_at: String,
    pub exported_by_app_version: String,
    pub bytes: u64,
    pub artifacts: Vec<String>,
    pub source_profile_id: String,
    pub password_protected: bool,
    pub has_proxy: bool,
    pub has_proxy_credentials: bool,
    /// A profile exported from this same install is already here — running both at once from one
    /// machine is the fastest way to link the two accounts.
    pub already_present: bool,
    pub name_collision: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportReport {
    pub profile: Profile,
    pub snapshot_version: u64,
    pub restore: RestoreReport,
    pub warnings: Vec<String>,
}

/// Everything export and import touch, gathered out of `AppState`.
///
/// A struct rather than the `State` itself so the round trip is assertable in a unit test: the
/// property that matters — a file this build writes is a file this build can open — is exactly the
/// one that was broken, and it cannot be proven through a command boundary that needs a Tauri
/// runtime to exist.
pub struct ProfileData<'a> {
    pub db: &'a std::sync::Mutex<rusqlite::Connection>,
    pub cipher: &'a crate::secrets::SecretCipher,
    pub profiles_dir: &'a Path,
    /// The snapshot ledger, opened by the caller.
    ///
    /// Passed in rather than opened here because opening it reads the Local Store Key from the OS
    /// keychain, and a test that did that would prompt — or hang — on the developer's own keyring
    /// while proving something that has nothing to do with key custody.
    pub vault: SnapshotVault,
}

impl<'a> ProfileData<'a> {
    fn from_state(state: &'a AppState) -> Result<Self> {
        let app_data_dir = state.profiles_dir.parent().ok_or_else(|| {
            anyhow!("profiles directory has no parent; cannot locate the snapshot ledger")
        })?;
        Ok(Self {
            db: &state.db,
            cipher: &state.cipher,
            profiles_dir: &state.profiles_dir,
            vault: SnapshotVault::open(app_data_dir).context("opening the snapshot ledger")?,
        })
    }

    fn conn(&self) -> Result<std::sync::MutexGuard<'_, rusqlite::Connection>> {
        self.db
            .lock()
            .map_err(|e| anyhow!("the profile store lock is poisoned: {e}"))
    }
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

/// Stretch the passphrase into a content key. The salt lives in the plaintext header, which is what
/// makes the same passphrase produce a different key for every exported file.
fn derive_key(passphrase: &str, salt: &[u8]) -> Result<[u8; LB_V1_KEY_LEN]> {
    if passphrase.is_empty() {
        bail!(
            "a passphrase is required — an unencrypted profile file is a credential in the clear"
        );
    }
    let params = Params::new(KDF_MEMORY_KIB, KDF_PASSES, KDF_LANES, Some(LB_V1_KEY_LEN))
        .map_err(|e| anyhow!("invalid Argon2 parameters: {e}"))?;
    let argon = Argon2::new(Algorithm::Argon2id, Version::V0x13, params);
    let mut key = [0u8; LB_V1_KEY_LEN];
    argon
        .hash_password_into(passphrase.as_bytes(), salt, &mut key)
        .map_err(|e| anyhow!("deriving the file key failed: {e}"))?;
    Ok(key)
}

/// A key id for the LBv1 envelope. Derived from the salt rather than random so it is reproducible
/// from the header alone, and it identifies the file rather than any install or account.
fn key_id_from_salt(salt: &[u8]) -> [u8; LB_V1_KEY_ID_LEN] {
    let digest = blake3::hash(salt);
    let mut id = [0u8; LB_V1_KEY_ID_LEN];
    id.copy_from_slice(&digest.as_bytes()[..LB_V1_KEY_ID_LEN]);
    id
}

/// Strip credentials from a proxy blob unless the user explicitly opted in.
///
/// Returns the blob and whether it still CARRIES credentials, which is what the file header records
/// so the import dialog can warn the recipient that the file contains a live proxy login.
fn redact_proxy(
    proxy: Option<serde_json::Value>,
    include_credentials: bool,
) -> (Option<serde_json::Value>, bool) {
    let Some(mut value) = proxy else {
        return (None, false);
    };
    if include_credentials {
        let carries = value
            .as_object()
            .map(|o| PROXY_SECRET_FIELDS.iter().any(|f| o.contains_key(*f)))
            .unwrap_or(false);
        return (Some(value), carries);
    }
    if let Some(object) = value.as_object_mut() {
        for field in PROXY_SECRET_FIELDS {
            object.remove(field);
        }
    }
    (Some(value), false)
}

// --- Progress and cancellation --------------------------------------------------------------

/// One step of an export or import, streamed to the dialog over a [`Channel`] while it runs.
///
/// `done`/`total` are both zero for a phase with nothing countable in it — capture and restore run
/// as single units — so the dialog shows an indeterminate bar rather than a fake percentage.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileProgress {
    /// `capture` | `read` | `seal` | `write` | `open` | `ledger` | `restore` | `done`.
    pub phase: String,
    /// What is happening, in words the dialog shows verbatim.
    pub detail: String,
    pub done: u64,
    pub total: u64,
}

/// Cancellation flags for the operations currently in flight, keyed by the id the caller minted.
///
/// A module-level registry rather than a field on `AppState`: cancelling is a property of one export
/// or import, nothing else in the app can observe it, and threading a map through the command
/// signatures would put it in front of every caller that does not care.
static CANCELLED: std::sync::OnceLock<std::sync::Mutex<std::collections::HashSet<String>>> =
    std::sync::OnceLock::new();

fn cancellations() -> &'static std::sync::Mutex<std::collections::HashSet<String>> {
    CANCELLED.get_or_init(|| std::sync::Mutex::new(std::collections::HashSet::new()))
}

/// Ask an in-flight export or import to stop.
///
/// It stops at the next step boundary, not mid-artifact: a capture or a restore that has started is
/// transactional and interrupting it part-way is exactly the half-written state both are built to
/// avoid. The operation then unwinds completely — an export removes its `.part`, an import removes
/// the row and the directory it created.
#[tauri::command]
pub fn cancel_profile_file_op(op_id: String) {
    if let Ok(mut set) = cancellations().lock() {
        set.insert(op_id);
    }
}

/// The reporting side of one operation: streams steps out and answers whether to keep going.
struct Reporter {
    op_id: Option<String>,
    channel: Option<tauri::ipc::Channel<FileProgress>>,
}

impl Reporter {
    fn new(op_id: Option<String>, channel: Option<tauri::ipc::Channel<FileProgress>>) -> Self {
        Self { op_id, channel }
    }

    /// Emit a step, and fail if the user cancelled. Every long phase goes through here, so the check
    /// and the report can never drift apart.
    fn step(&self, phase: &str, detail: impl Into<String>, done: u64, total: u64) -> Result<()> {
        self.bail_if_cancelled()?;
        if let Some(channel) = &self.channel {
            let _ = channel.send(FileProgress {
                phase: phase.to_string(),
                detail: detail.into(),
                done,
                total,
            });
        }
        Ok(())
    }

    fn bail_if_cancelled(&self) -> Result<()> {
        let Some(op_id) = &self.op_id else {
            return Ok(());
        };
        let cancelled = cancellations()
            .lock()
            .map(|set| set.contains(op_id))
            .unwrap_or(false);
        if cancelled {
            bail!("CANCELLED: stopped at your request; nothing was left behind");
        }
        Ok(())
    }
}

impl Drop for Reporter {
    /// The flag outlives the operation it belongs to unless it is cleared here, and a reused id would
    /// then cancel the next operation before it started.
    fn drop(&mut self) {
        if let (Some(op_id), Ok(mut set)) = (&self.op_id, cancellations().lock()) {
            set.remove(op_id);
        }
    }
}

// The arity is the IPC schema, not a design choice: Tauri deserialises each parameter by name from
// the invoke payload, so collapsing these into a params struct would change the wire format the
// frontend calls with. Same reasoning as `snapshot::capture_artifacts`.
#[allow(clippy::too_many_arguments)]
#[tauri::command]
pub fn export_profile_file(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
    passphrase: String,
    profile_password: Option<String>,
    options: Option<ExportOptions>,
    op_id: Option<String>,
    on_progress: tauri::ipc::Channel<FileProgress>,
) -> Result<ExportReport, String> {
    let reporter = Reporter::new(op_id, Some(on_progress));
    let data = ProfileData::from_state(&state).map_err(|e| format!("{e:#}"))?;
    export_inner(
        &data,
        &id,
        &dest_path,
        &passphrase,
        profile_password.as_deref(),
        options.unwrap_or_default(),
        ExportRuntime {
            reporter: &reporter,
            keyring: None,
        },
    )
    .map_err(|e| format!("{e:#}"))
}

struct ExportRuntime<'a> {
    reporter: &'a Reporter,
    keyring: Option<&'a dyn snapshot::oscrypt::OsCryptKeyring>,
}

fn export_inner(
    data: &ProfileData<'_>,
    id: &str,
    dest_path: &str,
    passphrase: &str,
    profile_password: Option<&str>,
    options: ExportOptions,
    runtime: ExportRuntime<'_>,
) -> Result<ExportReport> {
    let reporter = runtime.reporter;
    let keyring = runtime.keyring;
    let mut row = {
        let conn = data.conn()?;
        let profile = profile_store::get(&conn, data.cipher, id)
            .map_err(|e| anyhow!("{e}"))?
            .ok_or_else(|| anyhow!("profile {id} not found"))?;

        // Exporting a row we could not fully decrypt would ship a profile that has silently lost its
        // session, and the loss would only surface on the target machine.
        if !profile.unreadable_secrets.is_empty() {
            bail!(
                "cannot export {id}: this machine cannot decrypt {} — exporting would ship a profile \
                 that has lost these values",
                profile.unreadable_secrets.join(", ")
            );
        }

        // Export must not be a way around the per-profile lock.
        if profile.password_protected
            && !profile_store::verify_password(&conn, id, profile_password)
                .map_err(|e| anyhow!("{e}"))?
        {
            bail!("PROFILE_PASSWORD_REQUIRED: this profile is password protected — enter its password to export it");
        }

        portable_row(&conn, &profile)?
    };

    let vault = &data.vault;
    let identity = {
        let conn = data.conn()?;
        snapshot::commands::identity_of_row(&conn, data.cipher, id).map_err(|e| anyhow!("{e}"))?
    };

    let mut omitted: Vec<String> = Vec::new();

    let manifest = match options.capture.as_deref() {
        Some("reuse-latest") => {
            reporter.step("capture", "Reading the last capture…", 0, 0)?;
            let version = vault
                .latest_version(id)?
                .ok_or_else(|| anyhow!("{id} has no snapshot to reuse — capture one first"))?;
            vault.manifest(id, version)?
        }
        mode => {
            reporter.step("capture", "Capturing the profile's data…", 0, 0)?;
            let mode = parse_mode(mode.unwrap_or("quiesced")).map_err(|e| anyhow!("{e}"))?;
            let capture_options = CaptureOptions {
                exclude: options.exclude_artifacts.clone(),
            };
            let udd = data.profiles_dir.join(id);
            match keyring {
                Some(keyring) => snapshot::capture_with_keyring(
                    vault,
                    &udd,
                    id,
                    mode,
                    &identity,
                    &capture_options,
                    keyring,
                ),
                None => snapshot::capture(vault, &udd, id, mode, &identity, &capture_options),
            }
            .context("capturing the profile's data")?
        }
    };

    for (artifact, reason) in &manifest.skipped {
        omitted.push(format!("{artifact} ({reason})"));
    }

    let total = manifest.artifacts.len() as u64;
    let mut artifacts = Vec::with_capacity(manifest.artifacts.len());
    for (index, record) in manifest.artifacts.iter().enumerate() {
        reporter.step(
            "read",
            format!("Collecting {}…", record.id),
            index as u64,
            total,
        )?;
        let bytes = vault
            .get_artifact(
                id,
                record.captured_in_version,
                &record.id,
                &record.sealed_digest,
            )
            .with_context(|| format!("reading `{}` out of the ledger to export", record.id))?;
        artifacts.push((record.id.clone(), ArtifactBytes(bytes)));
    }

    let carries_proxy = row.proxy.is_some();
    let (proxy, credentials_included) =
        redact_proxy(row.proxy.take(), options.include_proxy_credentials);
    row.proxy = proxy;
    if carries_proxy && !options.include_proxy_credentials {
        omitted.push("proxy username and password".to_string());
    }

    let profile_id = row.source_profile_id.clone();
    let profile_name = row.name.clone();
    let artifact_ids: Vec<String> = manifest.artifacts.iter().map(|a| a.id.clone()).collect();
    let coherence = manifest.coherence.label.clone();
    let snapshot_version = manifest.version;
    let password_protected = row.password_hash.is_some();

    let body = PortableBody {
        format_version: FORMAT_VERSION,
        row,
        manifest,
        artifacts,
    };

    reporter.step("seal", "Encrypting the file…", 0, 0)?;
    let encoded = encode_body(&body)?;

    let salt = uuid::Uuid::new_v4().as_bytes().to_vec();
    let key = derive_key(passphrase, &salt)?;
    let sealed = BlobCipher::new(&key).encrypt(&encoded, &key_id_from_salt(&salt))?;

    let header = FileHeader {
        format_version: FORMAT_VERSION,
        manifest_version: body.manifest.manifest_version,
        app_version: env!("CARGO_PKG_VERSION").to_string(),
        exported_at: chrono::Utc::now().to_rfc3339(),
        profile_name: body.row.name.clone(),
        engine: body.row.engine.clone(),
        os: body.row.os.clone(),
        os_version: body.row.os_version.clone(),
        source_profile_id: body.row.source_profile_id.clone(),
        artifacts: artifact_ids.clone(),
        password_protected,
        has_proxy: body.row.proxy.is_some(),
        has_proxy_credentials: credentials_included,
        body_bytes: sealed.len() as u64,
        body_digest: snapshot::manifest::digest_hex(&sealed),
        kdf: KdfParams {
            alg: "argon2id".to_string(),
            v: 19,
            m: KDF_MEMORY_KIB,
            t: KDF_PASSES,
            p: KDF_LANES,
            salt_b64: base64_encode(&salt),
        },
    };
    let header_json = serde_json::to_vec(&header).context("encoding the file header")?;

    let dest = Path::new(dest_path);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).with_context(|| format!("creating {}", parent.display()))?;
    }

    reporter.step("write", "Writing the file…", 0, 0)?;

    // Never write the destination directly: a half-written file with the real extension looks
    // importable. Write a sibling `.part`, flush it, then rename — the vault's own pattern.
    let part = dest.with_extension("part");
    let written = write_part(&part, MAGIC, &header_json, &sealed).and_then(|()| {
        fs::rename(&part, dest)
            .with_context(|| format!("moving the export into place at {}", dest.display()))
    });
    if let Err(err) = written {
        // A `.part` left beside the destination is a file the user will find and wonder about, and
        // one a retry would then have to overwrite blind.
        let _ = fs::remove_file(&part);
        return Err(err);
    }

    let bytes = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);

    reporter.step("done", "Exported.", 1, 1)?;

    Ok(ExportReport {
        path: dest_path.to_string(),
        bytes,
        profile_id,
        profile_name,
        snapshot_version,
        coherence,
        artifacts: artifact_ids,
        omitted,
    })
}

fn write_part(part: &Path, magic: &[u8; 4], header_json: &[u8], sealed: &[u8]) -> Result<()> {
    let mut file =
        fs::File::create(part).with_context(|| format!("creating {}", part.display()))?;
    file.write_all(magic)?;
    file.write_all(&(header_json.len() as u32).to_le_bytes())?;
    file.write_all(header_json)?;
    file.write_all(sealed)?;
    file.flush()?;
    file.sync_all().ok();
    Ok(())
}

fn base64_encode(bytes: &[u8]) -> String {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD.encode(bytes)
}

fn base64_decode(text: &str) -> Result<Vec<u8>> {
    use base64::Engine as _;
    base64::engine::general_purpose::STANDARD
        .decode(text)
        .context("the file header's salt is not valid base64")
}

/// Read and validate the plaintext header, returning it with the whole file and the offset the
/// sealed body starts at.
///
/// The bytes come back rather than being dropped because the importer needs them: reading a file
/// that can carry tens of megabytes of site data twice doubles the import's disk cost, and the
/// header validated on the first pass would not be the header the second pass decrypts.
fn read_header(path: &Path) -> Result<(FileHeader, Vec<u8>, usize)> {
    let bytes = fs::read(path).with_context(|| format!("reading {}", path.display()))?;
    if bytes.len() < 8 || &bytes[..4] != MAGIC {
        bail!("this is not a Lobster profile file");
    }
    let header_len = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]);
    if header_len > MAX_HEADER_BYTES {
        bail!("this file is damaged and cannot be imported");
    }
    let start = 8;
    let end = start + header_len as usize;
    if bytes.len() < end {
        bail!("this file is truncated and cannot be imported");
    }
    let header: FileHeader = serde_json::from_slice(&bytes[start..end])
        .context("this file's header is damaged and cannot be read")?;
    if header.format_version > FORMAT_VERSION {
        bail!(
            "this profile was exported by a newer version of Lobster (format {}). Update Lobster, \
             then import it.",
            header.format_version
        );
    }
    // The body carries a snapshot manifest, which is decoded straight out of CBOR rather than through
    // `SnapshotManifest::decode` — so its own version gate never runs, and a manifest from a newer
    // build would be misread as one of ours. Checking it HERE also means the refusal happens before
    // the passphrase prompt, off the plaintext header.
    if header.manifest_version > snapshot::manifest::MANIFEST_VERSION {
        bail!(
            "this profile's data was written by a newer version of Lobster (snapshot format {}). \
             Update Lobster, then import it.",
            header.manifest_version
        );
    }

    let body = &bytes[end..];
    if header.body_bytes > 0 && (body.len() as u64) < header.body_bytes {
        bail!(
            "this file is truncated: it should hold {} bytes of profile data and holds {}. Copy it \
             again from the original.",
            header.body_bytes,
            body.len()
        );
    }
    if !header.body_digest.is_empty() {
        let actual = snapshot::manifest::digest_hex(&body[..header.body_bytes as usize]);
        if actual != header.body_digest {
            bail!(
                "this file is damaged: its contents do not match the checksum it carries. Copy it \
                 again from the original."
            );
        }
    }
    Ok((header, bytes, end))
}

#[tauri::command]
pub fn inspect_profile_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportPreview, String> {
    let data = ProfileData::from_state(&state).map_err(|e| format!("{e:#}"))?;
    inspect_inner(&data, Path::new(&path)).map_err(|e| format!("{e:#}"))
}

fn inspect_inner(data: &ProfileData<'_>, path: &Path) -> Result<ImportPreview> {
    let (header, bytes, _) = read_header(path)?;
    let bytes = bytes.len() as u64;

    let (already_present, name_collision) = {
        let conn = data.conn()?;
        let existing = profile_store::list(&conn, data.cipher).map_err(|e| anyhow!("{e}"))?;
        (
            existing.iter().any(|p| p.id == header.source_profile_id),
            existing.iter().any(|p| p.name == header.profile_name),
        )
    };

    Ok(ImportPreview {
        format_version: header.format_version,
        manifest_version: header.manifest_version,
        profile_name: header.profile_name,
        engine: header.engine,
        os: header.os,
        os_version: header.os_version,
        exported_at: header.exported_at,
        exported_by_app_version: header.app_version,
        bytes,
        artifacts: header.artifacts,
        source_profile_id: header.source_profile_id,
        password_protected: header.password_protected,
        has_proxy: header.has_proxy,
        has_proxy_credentials: header.has_proxy_credentials,
        already_present,
        name_collision,
    })
}

#[tauri::command]
pub fn import_profile_file(
    state: State<'_, AppState>,
    path: String,
    passphrase: String,
    name_override: Option<String>,
    op_id: Option<String>,
    on_progress: tauri::ipc::Channel<FileProgress>,
) -> Result<ImportReport, String> {
    let reporter = Reporter::new(op_id, Some(on_progress));
    let data = ProfileData::from_state(&state).map_err(|e| format!("{e:#}"))?;
    import_inner(
        &data,
        Path::new(&path),
        &passphrase,
        name_override,
        &reporter,
        None,
    )
    .map_err(|e| format!("{e:#}"))
}

/// `keyring` is the TARGET machine's OSCrypt key source. `None` resolves the host's, which is what
/// every real import does; a test supplies one to stand in for another platform, because a file
/// written on Windows and opened on Linux is the case that decides whether the promise holds.
fn import_inner(
    data: &ProfileData<'_>,
    path: &Path,
    passphrase: &str,
    name_override: Option<String>,
    reporter: &Reporter,
    keyring: Option<&dyn snapshot::oscrypt::OsCryptKeyring>,
) -> Result<ImportReport> {
    // 1. Open the file. NOTHING is written until this has fully succeeded.
    reporter.step("open", "Checking the file…", 0, 0)?;
    let (header, all, body_offset) = read_header(path)?;
    let sealed = &all[body_offset..];

    reporter.step("open", "Unlocking…", 0, 0)?;
    let salt = base64_decode(&header.kdf.salt_b64)?;
    let key = derive_key(passphrase, &salt)?;
    let (plain, _) = BlobCipher::new(&key)
        .decrypt(sealed)
        // `read_header` has already proved the bytes are the ones the file was written with, so an
        // AEAD failure here is the passphrase and nothing else.
        .map_err(|_| anyhow!("WRONG_PASSPHRASE: that password does not open this file"))?;
    let body = decode_body(header.format_version, &plain)?;
    if body.format_version > FORMAT_VERSION {
        bail!(
            "this profile was exported by a newer version of Lobster. Update Lobster, then import it."
        );
    }

    let mut warnings: Vec<String> = Vec::new();

    // 2. Create the row FIRST, with the seed PINNED, so `identity_of` on the new id reproduces the
    //    manifest's identity and the restore below can verify rather than be forced.
    reporter.step("ledger", "Creating the profile…", 0, 0)?;
    let created = {
        let conn = data.conn()?;
        let existing = profile_store::list(&conn, data.cipher).map_err(|e| anyhow!("{e}"))?;
        let wanted = name_override.unwrap_or_else(|| body.row.name.clone());
        let name = free_name(&existing, &wanted);
        if name != wanted {
            warnings.push(format!(
                "A profile named \"{wanted}\" already existed, so this one was named \"{name}\"."
            ));
        }
        create_from_portable_row(&conn, data.cipher, &body.row, name)?
    };

    // From here on, any failure must leave nothing behind.
    let result = finish_import(data, &created, body, &mut warnings, reporter, keyring);
    match result {
        Ok(report) => Ok(report),
        Err(err) => {
            rollback(data, &created.id);
            Err(err)
        }
    }
}

/// Write the snapshot into the vault under the NEW id, then restore it into the new user-data-dir.
fn finish_import(
    data: &ProfileData<'_>,
    created: &Profile,
    body: PortableBody,
    warnings: &mut Vec<String>,
    reporter: &Reporter,
    keyring: Option<&dyn snapshot::oscrypt::OsCryptKeyring>,
) -> Result<ImportReport> {
    let vault = &data.vault;

    reporter.step(
        "ledger",
        "Checking the profile's data…",
        0,
        body.artifacts.len() as u64,
    )?;

    // `adopt` re-points the manifest at this install: the new profile id, a fresh version, and — the
    // part that decides whether the import works at all — the sealed digest of every artifact as this
    // ledger's own key sealed it.
    let adopted = vault
        .adopt(
            &created.id,
            &body.manifest,
            body.artifacts
                .into_iter()
                .map(|(id, bytes)| (id, bytes.0))
                .collect(),
        )
        .context("writing the imported profile's data into the ledger")?;
    let snapshot_version = adopted.version;

    let udd = data.profiles_dir.join(&created.id);
    let target = {
        let conn = data.conn()?;
        snapshot::commands::identity_of_row(&conn, data.cipher, &created.id)
            .map_err(|e| anyhow!("{e}"))?
    };

    reporter.step(
        "restore",
        format!("Restoring {} items…", adopted.artifacts.len()),
        0,
        0,
    )?;

    // force = FALSE, always. The seed was pinned above, so a mismatch here means the export was
    // wrong, and forcing it would write a session onto a device it does not belong to.
    let report = match keyring {
        Some(keyring) => snapshot::restore_with_keyring(
            vault,
            &udd,
            &created.id,
            snapshot_version,
            &target,
            false,
            keyring,
        ),
        None => snapshot::restore(vault, &udd, &created.id, snapshot_version, &target, false),
    }
    .context("restoring the imported profile's data")?;

    if !report.ok {
        bail!(
            "IMPORT_FAILED: {}",
            report
                .failure
                .clone()
                .unwrap_or_else(|| "the profile's data could not be restored".to_string())
        );
    }

    for artifact in &report.artifacts {
        if !matches!(artifact.status, snapshot::RestoreStatus::Restored) {
            warnings.push(format!(
                "{}: {}",
                artifact.id,
                artifact
                    .detail
                    .clone()
                    .unwrap_or_else(|| format!("{:?}", artifact.status))
            ));
        }
    }

    // The last chance to honour a cancel. A restore cannot be interrupted part-way, so one asked for
    // during it is applied by unwinding the whole import afterwards rather than by stopping mid-swap.
    reporter.step("done", "Imported.", 1, 1)?;

    Ok(ImportReport {
        profile: created.clone(),
        snapshot_version,
        restore: report,
        warnings: std::mem::take(warnings),
    })
}

/// Undo a partial import. Best effort by design: the caller is already returning an error, and a
/// failure to clean up must not replace that error with a less useful one.
fn rollback(data: &ProfileData<'_>, id: &str) {
    if let Ok(conn) = data.db.lock() {
        // `purge` only deletes a trashed row, so trash it first — the profile never really existed.
        let _ = profile_store::delete(&conn, id);
        let _ = profile_store::purge(&conn, id);
    }
    let _ = crate::remove_profile_data_dir(data.profiles_dir, id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn portable_row_with_seed(seed: &str) -> PortableRow {
        PortableRow {
            source_profile_id: "prf_source".into(),
            name: "Portable".into(),
            engine: "lobium".into(),
            os: "windows".into(),
            os_version: Some("11".into()),
            fingerprint_seed: seed.into(),
            fingerprint_overrides_json: None,
            proxy: None,
            cookies_import: None,
            cookies_import_applied_at: None,
            extensions: None,
            tags: vec!["portable".into()],
            folder: None,
            notes: None,
            password_hash: None,
        }
    }

    #[test]
    fn portable_rows_reject_invalid_seeds_and_preserve_canonical_or_legacy_identity() {
        let conn = rusqlite::Connection::open_in_memory().unwrap();
        conn.execute_batch(profile_store::SCHEMA).unwrap();
        let cipher = crate::secrets::SecretCipher::new(&[42u8; 32]);

        for (index, seed) in [
            "".to_string(),
            "abcdefg".to_string(),
            "deadbeeG".to_string(),
            "DEADBEEF".to_string(),
            "a".repeat(257),
            "a".repeat(1024 * 1024),
        ]
        .into_iter()
        .enumerate()
        {
            let invalid = portable_row_with_seed(&seed);
            let error =
                create_from_portable_row(&conn, &cipher, &invalid, format!("Invalid {index}"))
                    .expect_err(
                        "an import must reject malformed identity instead of regenerating it",
                    );
            assert!(
                error.to_string().contains("invalid fingerprint seed"),
                "unexpected error: {error:#}"
            );
        }
        assert_eq!(profile_store::count_active(&conn).unwrap(), 0);

        for seed in ["deadbeef", "0123456789abcdef0123456789abcdef"] {
            let valid = portable_row_with_seed(seed);
            let created = create_from_portable_row(&conn, &cipher, &valid, format!("Valid {seed}"))
                .expect("bounded lowercase-hex identity must import");
            assert_eq!(
                created.fingerprint_seed, seed,
                "import identity must be pinned without reseeding"
            );
        }
    }

    #[test]
    fn the_same_passphrase_under_a_different_salt_yields_a_different_key() {
        // The salt is what stops one cracked file from opening every other file the user exported
        // with the same passphrase.
        let a = derive_key("correct horse battery staple", b"0123456789abcdef").unwrap();
        let b = derive_key("correct horse battery staple", b"fedcba9876543210").unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn a_wrong_passphrase_fails_closed_rather_than_returning_garbage() {
        let salt = b"0123456789abcdef";
        let key = derive_key("right", salt).unwrap();
        let sealed = BlobCipher::new(&key)
            .encrypt(b"the profile body", &key_id_from_salt(salt))
            .unwrap();

        let wrong = derive_key("wrong", salt).unwrap();
        assert!(BlobCipher::new(&wrong).decrypt(&sealed).is_err());

        let (opened, _) = BlobCipher::new(&key).decrypt(&sealed).unwrap();
        assert_eq!(opened, b"the profile body");
    }

    #[test]
    fn an_empty_passphrase_is_refused() {
        // An unencrypted export is a live credential in a file the user is about to email.
        assert!(derive_key("", b"0123456789abcdef").is_err());
    }

    #[test]
    fn proxy_credentials_are_stripped_unless_opted_in() {
        let proxy = serde_json::json!({
            "host": "gw.example.com",
            "port": 8080,
            "username": "u",
            "password": "p"
        });

        let (redacted, included) = redact_proxy(Some(proxy.clone()), false);
        let redacted = redacted.unwrap();
        assert!(redacted.get("username").is_none());
        assert!(redacted.get("password").is_none());
        assert_eq!(
            redacted.get("host").and_then(|v| v.as_str()),
            Some("gw.example.com")
        );
        assert!(!included);

        let (kept, included) = redact_proxy(Some(proxy), true);
        assert_eq!(
            kept.unwrap().get("username").and_then(|v| v.as_str()),
            Some("u")
        );
        assert!(included);
    }

    // --- The round trip ------------------------------------------------------------------------
    //
    // Everything below drives `export_inner`/`import_inner` against a real SQLite store, a real
    // user-data-dir and a real ledger. Nothing here is a mock: the defect these exist for — the
    // manifest still naming the EXPORTING machine's sealed digests, so every import failed on its own
    // integrity check — was invisible to every unit test of the pieces, and only a whole round trip
    // catches its like again.

    use crate::secrets::SecretCipher;
    use crate::snapshot::manifest::digest_hex;
    use crate::snapshot::oscrypt;
    use rusqlite::Connection;
    use std::path::PathBuf;
    use std::sync::Mutex;

    /// A scratch directory that removes itself even when an assertion fires. These hold a cookie jar
    /// and an exported `.lobprofile`, so a leaked one is a session on disk outside any profile.
    struct TempRoot(PathBuf);

    impl Drop for TempRoot {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    impl TempRoot {
        fn join(&self, p: impl AsRef<Path>) -> PathBuf {
            self.0.join(p)
        }
    }

    fn temp_root(tag: &str) -> TempRoot {
        let dir =
            std::env::temp_dir().join(format!("lobster-portable-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        TempRoot(dir)
    }

    /// One machine: its profile store, its Local Store Key, its profiles root.
    ///
    /// `lsk` is what makes the cross-machine tests real. Two harnesses over the same directory with
    /// DIFFERENT keys are two installs, and an artifact sealed by one is unreadable to the other —
    /// which is exactly the condition a `.lobprofile` has to survive.
    struct Machine {
        db: Mutex<Connection>,
        cipher: SecretCipher,
        profiles_dir: PathBuf,
        ledger_dir: PathBuf,
        lsk: [u8; 32],
    }

    impl Machine {
        fn new(root: &TempRoot, tag: &str, lsk: u8) -> Self {
            let profiles_dir = root.join(format!("{tag}/profiles"));
            let ledger_dir = root.join(format!("{tag}/snapshots"));
            std::fs::create_dir_all(&profiles_dir).unwrap();
            std::fs::create_dir_all(&ledger_dir).unwrap();
            let conn = Connection::open_in_memory().unwrap();
            conn.execute_batch(crate::profile_store::SCHEMA).unwrap();
            Self {
                db: Mutex::new(conn),
                cipher: SecretCipher::new(&[7u8; 32]),
                profiles_dir,
                ledger_dir,
                lsk: [lsk; 32],
            }
        }

        fn data(&self) -> ProfileData<'_> {
            ProfileData {
                db: &self.db,
                cipher: &self.cipher,
                profiles_dir: &self.profiles_dir,
                vault: SnapshotVault::with_key(&self.ledger_dir, &self.lsk).unwrap(),
            }
        }

        fn create(&self, name: &str) -> Profile {
            let conn = self.db.lock().unwrap();
            profile_store::create(
                &conn,
                &self.cipher,
                CreateProfileInput {
                    name: name.to_string(),
                    engine: "lobium".into(),
                    os: "windows".into(),
                    os_version: Some("11".into()),
                    fingerprint_seed: None,
                    fingerprint_overrides: Some(serde_json::json!({ "screen": { "width": 1920 } })),
                    proxy: Some(serde_json::json!({
                        "type": "https",
                        "host": "gw.example.com",
                        "port": 8080,
                        "username": "operator",
                        "password": "s3cret",
                    })),
                    proxy_id: None,
                    template_id: None,
                    cookies_import: None,
                    extensions: Some(serde_json::json!([
                        { "source": "chrome_web_store", "enabled": true,
                          "id": "dilfmeocbnifnkedfcioghohbppbkkje", "name": "MetaMask" }
                    ])),
                    tags: Some(vec!["retail".into(), "us".into()]),
                    folder: Some("Shopping".into()),
                    notes: Some("the one with the card on file".into()),
                },
            )
            .unwrap()
        }

        fn list(&self) -> Vec<Profile> {
            let conn = self.db.lock().unwrap();
            profile_store::list(&conn, &self.cipher).unwrap()
        }
    }

    /// A user-data-dir with a cookie jar whose session cookie is sealed under `seal`, plus DOM
    /// storage and a login. Shaped like the real ones — the v24 cookie schema with all twenty NOT
    /// NULL columns, WAL-mode DOM storage — because a fixture that is not shaped like the field
    /// proves nothing about the field.
    fn build_udd(udd: &Path, seal: &oscrypt::OsKey, cookie: &[u8], ls_value: &str) {
        let default = udd.join("Default");
        std::fs::create_dir_all(&default).unwrap();

        let cookies = Connection::open(default.join("Cookies")).unwrap();
        cookies
            .pragma_update(None, "journal_mode", "delete")
            .unwrap();
        cookies
            .execute_batch(
                "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
                 INSERT INTO meta VALUES('version','24'),('last_compatible_version','24');
                 CREATE TABLE cookies(creation_utc INTEGER NOT NULL, host_key TEXT NOT NULL,\
                     top_frame_site_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,\
                     encrypted_value BLOB NOT NULL, path TEXT NOT NULL, expires_utc INTEGER NOT NULL,\
                     is_secure INTEGER NOT NULL, is_httponly INTEGER NOT NULL,\
                     last_access_utc INTEGER NOT NULL, has_expires INTEGER NOT NULL,\
                     is_persistent INTEGER NOT NULL, priority INTEGER NOT NULL, samesite INTEGER NOT NULL,\
                     source_scheme INTEGER NOT NULL, source_port INTEGER NOT NULL,\
                     last_update_utc INTEGER NOT NULL, source_type INTEGER NOT NULL,\
                     has_cross_site_ancestor INTEGER NOT NULL);",
            )
            .unwrap();
        let sealed = oscrypt::encrypt_cookie_value(seal, "1procard.com", cookie).unwrap();
        cookies
            .execute(
                "INSERT INTO cookies VALUES(13429403387583785,'1procard.com','','authToken','',?1,\
                 '/',0,1,1,0,0,1,1,0,2,443,0,0,0)",
                rusqlite::params![sealed],
            )
            .unwrap();
        drop(cookies);

        let ls = Connection::open(default.join("LocalStorage")).unwrap();
        ls.pragma_update(None, "journal_mode", "WAL").unwrap();
        ls.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        ls.execute_batch(
            "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
             INSERT INTO meta VALUES('mmap_status','-1'),('version','1'),('last_compatible_version','1');
             CREATE TABLE maps(row_id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key BLOB NOT NULL,\
                 last_accessed INTEGER, last_modified INTEGER, total_size INTEGER);
             CREATE UNIQUE INDEX maps_by_storage_key ON maps(storage_key);
             CREATE TABLE map_entries(map_id INTEGER NOT NULL, value_compression_type INTEGER NOT NULL,\
                 key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(map_id, key)) WITHOUT ROWID;
             INSERT INTO maps(row_id, storage_key, last_accessed, last_modified, total_size)\
                 VALUES(1, x'68747470733a2f2f3170726f636172642e636f6d2f', 1, 1, 42);",
        )
        .unwrap();
        ls.execute(
            "INSERT INTO map_entries VALUES(1, 0, ?1, ?2)",
            rusqlite::params![
                b"\x01device_session_v1".to_vec(),
                format!("\u{1}{ls_value}").into_bytes()
            ],
        )
        .unwrap();
        drop(ls);

        // Extension-origin storage: a LevelDB store under the extension's own id. Its survival is the
        // whole reason extension ids are pinned rather than paths.
        let ext = default
            .join("Local Extension Settings")
            .join("dilfmeocbnifnkedfcioghohbppbkkje");
        std::fs::create_dir_all(&ext).unwrap();
        std::fs::write(ext.join("000003.log"), b"wallet-unlocked-state").unwrap();
        std::fs::write(ext.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
    }

    fn linux_key() -> oscrypt::OsKey {
        oscrypt::OsKey::Aes128Cbc(oscrypt::linux::LINUX_V10_KEY)
    }

    fn windows_key() -> oscrypt::OsKey {
        oscrypt::OsKey::Aes256Gcm([0x5au8; 32])
    }

    fn read_cookie(udd: &Path, keyring: &dyn oscrypt::OsCryptKeyring) -> Vec<u8> {
        let conn = Connection::open(udd.join("Default").join("Cookies")).unwrap();
        let sealed: Vec<u8> = conn
            .query_row(
                "SELECT encrypted_value FROM cookies WHERE name='authToken'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        oscrypt::decrypt_cookie_value(keyring, "1procard.com", &sealed).unwrap()
    }

    fn read_local_storage(udd: &Path) -> Vec<u8> {
        let conn = Connection::open(udd.join("Default").join("LocalStorage")).unwrap();
        conn.query_row("SELECT value FROM map_entries WHERE map_id=1", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    fn export(machine: &Machine, id: &str, dest: &Path, passphrase: &str) -> ExportReport {
        // Synthetic profile values are sealed under this fixture key on every host. Inject it
        // explicitly instead of asking Windows to unwrap a nonexistent DPAPI Local State.
        let keyring = oscrypt::InjectedKeyring::single(linux_key());
        export_inner(
            &machine.data(),
            id,
            dest.to_str().unwrap(),
            passphrase,
            None,
            ExportOptions::default(),
            ExportRuntime {
                reporter: &Reporter::new(None, None),
                keyring: Some(&keyring),
            },
        )
        .unwrap()
    }

    fn import(machine: &Machine, file: &Path, passphrase: &str) -> Result<ImportReport> {
        let keyring = oscrypt::InjectedKeyring::single(linux_key());
        import_inner(
            &machine.data(),
            file,
            passphrase,
            None,
            &Reporter::new(None, None),
            Some(&keyring),
        )
    }

    /// THE test. A profile leaves one machine as a file and arrives on another — a different Local
    /// Store Key, a different profile id — with its identity, its session and its settings intact.
    ///
    /// It fails on the unfixed code at the first artifact: the exported manifest names the sealed
    /// digests of the SOURCE ledger, the destination ledger seals with its own key, and
    /// `get_artifact` rightly refuses to decrypt a blob that is not the one the manifest recorded.
    #[test]
    fn a_profile_travels_to_another_machine_as_one_file() {
        let root = temp_root("roundtrip");
        let source = Machine::new(&root, "source", 11);
        let target = Machine::new(&root, "target", 22);

        let profile = source.create("US Retail");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=live-session",
            "device-token-42",
        );

        let file = root.join("US Retail.lobprofile");
        let report = export(&source, &profile.id, &file, "correct horse battery staple");
        assert!(report.bytes > 0);
        assert!(file.is_file());
        assert!(
            report.artifacts.contains(&"cookies".to_string()),
            "the cookie jar must be in the file: {:?}",
            report.artifacts
        );
        assert!(
            report.omitted.iter().any(|o| o.contains("proxy username")),
            "an exclusion the user is not told about is a silent drop: {:?}",
            report.omitted
        );

        let imported = import(&target, &file, "correct horse battery staple").unwrap();
        assert!(imported.restore.ok, "{:?}", imported.restore.failure);

        // Identity: the seed is what makes this the same browser, and the restore verifying at all
        // proves it was pinned — a mismatch is refused, never applied.
        let landed = &imported.profile;
        assert_eq!(landed.fingerprint_seed, profile.fingerprint_seed);
        assert_ne!(landed.id, profile.id, "the target mints its own local id");
        assert_eq!(landed.fingerprint_overrides, profile.fingerprint_overrides);
        assert_eq!(landed.os, "windows");
        assert_eq!(landed.os_version.as_deref(), Some("11"));

        // Settings.
        assert_eq!(landed.tags, vec!["retail".to_string(), "us".to_string()]);
        assert_eq!(landed.folder.as_deref(), Some("Shopping"));
        assert_eq!(
            landed.notes.as_deref(),
            Some("the one with the card on file")
        );
        assert_eq!(landed.extensions, profile.extensions);

        // The proxy travels; its credentials do not, because the file is meant to be mailed.
        let proxy = landed.proxy.as_ref().expect("the proxy travelled");
        assert_eq!(proxy.get("host").unwrap(), "gw.example.com");
        assert_eq!(proxy.get("port").unwrap(), 8080);
        assert!(proxy.get("password").is_none());

        // Session data.
        let restored_udd = target.profiles_dir.join(&landed.id);
        assert_eq!(
            read_cookie(
                &restored_udd,
                &oscrypt::InjectedKeyring::single(linux_key())
            ),
            b"SID=live-session"
        );
        assert_eq!(read_local_storage(&restored_udd), b"\x01device-token-42");
        assert_eq!(
            std::fs::read(
                restored_udd
                    .join("Default/Local Extension Settings/dilfmeocbnifnkedfcioghohbppbkkje")
                    .join("000003.log")
            )
            .unwrap(),
            b"wallet-unlocked-state",
            "extension-origin storage must survive, keyed by the extension's own id"
        );

        // And the target's ledger now holds a snapshot it can verify on its own terms.
        let verified =
            snapshot::verify(&target.data().vault, &landed.id, imported.snapshot_version).unwrap();
        assert!(verified.ok, "{:?}", verified.artifacts);
    }

    /// A file written on Windows opens on Linux still logged in.
    ///
    /// The cookie is sealed under a Windows-shaped AES-256-GCM key at capture and the import re-seals
    /// it under the Linux key, so the value survives a change of platform key custody. `reuse-latest`
    /// is what lets the export side stand in for Windows without a Windows key source: the capture
    /// under the injected key has already happened.
    #[test]
    fn a_file_written_on_windows_restores_logged_in_on_linux() {
        let root = temp_root("win-to-linux");
        let source = Machine::new(&root, "source", 33);
        let target = Machine::new(&root, "target", 44);

        let profile = source.create("Windows Origin");
        let udd = source.profiles_dir.join(&profile.id);
        build_udd(&udd, &windows_key(), b"SID=from-windows", "win-token");

        // Capture as the Windows machine would: DPAPI-derived AES-256-GCM.
        let windows = oscrypt::InjectedKeyring::single(windows_key());
        let identity = {
            let conn = source.db.lock().unwrap();
            snapshot::commands::identity_of_row(&conn, &source.cipher, &profile.id).unwrap()
        };
        let data = source.data();
        let manifest = snapshot::capture_with_keyring(
            &data.vault,
            &udd,
            &profile.id,
            CaptureMode::Quiesced,
            &identity,
            &CaptureOptions::default(),
            &windows,
        )
        .unwrap();
        assert_eq!(
            manifest
                .artifact("cookies")
                .unwrap()
                .portable
                .as_ref()
                .unwrap()
                .source_scheme,
            "v10-aes256gcm",
            "the file must record that it was captured under a Windows key"
        );

        let file = root.join("from-windows.lobprofile");
        export_inner(
            &data,
            &profile.id,
            file.to_str().unwrap(),
            "a passphrase that travels",
            None,
            ExportOptions {
                capture: Some("reuse-latest".into()),
                ..Default::default()
            },
            ExportRuntime {
                reporter: &Reporter::new(None, None),
                keyring: None,
            },
        )
        .unwrap();

        // The Linux machine: the fixed v10 key, and no way to read a GCM ciphertext.
        let linux = oscrypt::InjectedKeyring::single(linux_key());
        let imported = import_inner(
            &target.data(),
            &file,
            "a passphrase that travels",
            None,
            &Reporter::new(None, None),
            Some(&linux),
        )
        .unwrap();
        assert!(imported.restore.ok, "{:?}", imported.restore.failure);

        let restored = target.profiles_dir.join(&imported.profile.id);
        assert_eq!(read_cookie(&restored, &linux), b"SID=from-windows");
        assert!(
            oscrypt::decrypt_cookie_value(
                &oscrypt::InjectedKeyring::single(windows_key()),
                "1procard.com",
                &{
                    let conn = Connection::open(restored.join("Default/Cookies")).unwrap();
                    conn.query_row(
                        "SELECT encrypted_value FROM cookies WHERE name='authToken'",
                        [],
                        |r| r.get::<_, Vec<u8>>(0),
                    )
                    .unwrap()
                },
            )
            .is_err(),
            "the value must have been RE-SEALED under the target key, not copied"
        );
    }

    /// The other direction: a Linux file lands on Windows.
    #[test]
    fn a_file_written_on_linux_restores_logged_in_on_windows() {
        let root = temp_root("linux-to-win");
        let source = Machine::new(&root, "source", 55);
        let target = Machine::new(&root, "target", 66);

        let profile = source.create("Linux Origin");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=from-linux",
            "nix-token",
        );
        let file = root.join("from-linux.lobprofile");
        export(&source, &profile.id, &file, "another passphrase");

        let windows = oscrypt::InjectedKeyring::single(windows_key());
        let imported = import_inner(
            &target.data(),
            &file,
            "another passphrase",
            None,
            &Reporter::new(None, None),
            Some(&windows),
        )
        .unwrap();
        assert!(imported.restore.ok, "{:?}", imported.restore.failure);
        assert_eq!(
            read_cookie(&target.profiles_dir.join(&imported.profile.id), &windows),
            b"SID=from-linux"
        );
    }

    /// A file that lost bytes on the way must be named as damaged, not blamed on the password — and
    /// it must leave nothing behind.
    #[test]
    fn a_truncated_file_is_refused_and_creates_nothing() {
        let root = temp_root("truncated");
        let source = Machine::new(&root, "source", 77);
        let target = Machine::new(&root, "target", 88);

        let profile = source.create("Will Not Arrive");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=doomed",
            "token",
        );
        let file = root.join("truncated.lobprofile");
        export(&source, &profile.id, &file, "passphrase");

        // Half the body gone: the shape a copy that ran out of disk or a download that stalled leaves.
        let full = std::fs::read(&file).unwrap();
        let header_len = u32::from_le_bytes([full[4], full[5], full[6], full[7]]) as usize;
        let keep = 8 + header_len + (full.len() - 8 - header_len) / 2;
        std::fs::write(&file, &full[..keep]).unwrap();

        let err = import(&target, &file, "passphrase")
            .unwrap_err()
            .to_string();
        assert!(err.contains("truncated"), "got: {err}");
        assert!(
            !err.contains("password"),
            "a damaged file must never be reported as a wrong password: {err}"
        );
        assert!(
            target.list().is_empty(),
            "a refused import must not leave a profile behind"
        );
        assert!(
            !target.profiles_dir.join(&profile.id).exists(),
            "a refused import must not leave a user-data-dir behind"
        );
    }

    /// A single flipped bit inside the body is damage, not a password problem.
    #[test]
    fn a_corrupted_body_is_reported_as_damage_rather_than_a_wrong_password() {
        let root = temp_root("corrupt");
        let source = Machine::new(&root, "source", 99);
        let target = Machine::new(&root, "target", 100);

        let profile = source.create("Bit Rot");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=rot",
            "token",
        );
        let file = root.join("corrupt.lobprofile");
        export(&source, &profile.id, &file, "passphrase");

        let mut bytes = std::fs::read(&file).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&file, &bytes).unwrap();

        let err = import(&target, &file, "passphrase")
            .unwrap_err()
            .to_string();
        assert!(err.contains("damaged"), "got: {err}");
        assert!(target.list().is_empty());
    }

    /// The passphrase is still the passphrase: an intact file with the wrong one says so.
    #[test]
    fn an_intact_file_with_the_wrong_passphrase_says_it_is_the_password() {
        let root = temp_root("wrongpass");
        let source = Machine::new(&root, "source", 101);
        let target = Machine::new(&root, "target", 102);

        let profile = source.create("Locked");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=locked",
            "token",
        );
        let file = root.join("locked.lobprofile");
        export(&source, &profile.id, &file, "the right one");

        let err = import(&target, &file, "the wrong one")
            .unwrap_err()
            .to_string();
        assert!(err.contains("WRONG_PASSPHRASE"), "got: {err}");
        assert!(target.list().is_empty());
    }

    /// Importing the same file twice is a normal thing to do. Both copies must exist and be tellable
    /// apart, and the second must not silently take the first one's name.
    #[test]
    fn importing_one_file_twice_yields_two_distinctly_named_profiles() {
        let root = temp_root("twice");
        let source = Machine::new(&root, "source", 103);
        let target = Machine::new(&root, "target", 104);

        let profile = source.create("Duplicate Me");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=dup",
            "token",
        );
        let file = root.join("dup.lobprofile");
        export(&source, &profile.id, &file, "passphrase");

        let first = import(&target, &file, "passphrase").unwrap();
        let second = import(&target, &file, "passphrase").unwrap();
        let third = import(&target, &file, "passphrase").unwrap();

        assert_eq!(first.profile.name, "Duplicate Me");
        assert_eq!(second.profile.name, "Duplicate Me (imported)");
        assert_eq!(third.profile.name, "Duplicate Me (imported 2)");
        assert!(second
            .warnings
            .iter()
            .any(|w| w.contains("already existed")));

        let names: Vec<String> = target.list().into_iter().map(|p| p.name).collect();
        assert_eq!(names.len(), 3);
        let mut unique = names.clone();
        unique.sort();
        unique.dedup();
        assert_eq!(
            unique.len(),
            3,
            "two profiles ended up with one name: {names:?}"
        );
    }

    /// Format versioning, in both directions. A newer file is refused off the PLAINTEXT header, so the
    /// user is told to update instead of being asked for a password first.
    #[test]
    fn a_file_from_a_newer_build_is_refused_before_the_password_is_asked_for() {
        let root = temp_root("versioning");
        let source = Machine::new(&root, "source", 105);

        let profile = source.create("From The Future");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=future",
            "token",
        );
        let file = root.join("future.lobprofile");
        export(&source, &profile.id, &file, "passphrase");

        for (field, expect) in [
            ("formatVersion", "newer version of Lobster (format"),
            ("manifestVersion", "snapshot format"),
        ] {
            let bytes = std::fs::read(&file).unwrap();
            let header_len = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
            let mut header: serde_json::Value =
                serde_json::from_slice(&bytes[8..8 + header_len]).unwrap();
            header[field] = serde_json::json!(99);
            let header_json = serde_json::to_vec(&header).unwrap();

            let rewritten = root.join(format!("future-{field}.lobprofile"));
            write_part(&rewritten, MAGIC, &header_json, &bytes[8 + header_len..]).unwrap();

            let err = read_header(&rewritten).unwrap_err().to_string();
            assert!(err.contains(expect), "for {field}, got: {err}");
            assert!(err.contains("Update Lobster"), "for {field}, got: {err}");
        }
    }

    /// The forward half of the same promise: a file written before the header carried a checksum still
    /// opens. Files already on users' disks must not become unreadable because the format grew.
    #[test]
    fn a_file_written_before_the_body_checksum_existed_still_opens() {
        let root = temp_root("older-header");
        let source = Machine::new(&root, "source", 106);
        let target = Machine::new(&root, "target", 107);

        let profile = source.create("From The Past");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=past",
            "token",
        );
        let file = root.join("past.lobprofile");
        export(&source, &profile.id, &file, "passphrase");

        // Strip the fields a previous build did not write.
        let bytes = std::fs::read(&file).unwrap();
        let header_len = u32::from_le_bytes([bytes[4], bytes[5], bytes[6], bytes[7]]) as usize;
        let mut header: serde_json::Value =
            serde_json::from_slice(&bytes[8..8 + header_len]).unwrap();
        let map = header.as_object_mut().unwrap();
        map.remove("bodyBytes");
        map.remove("bodyDigest");
        let header_json = serde_json::to_vec(&header).unwrap();

        let older = root.join("older.lobprofile");
        write_part(&older, MAGIC, &header_json, &bytes[8 + header_len..]).unwrap();

        let imported = import(&target, &older, "passphrase").unwrap();
        assert!(imported.restore.ok, "{:?}", imported.restore.failure);
        assert_eq!(
            read_cookie(
                &target.profiles_dir.join(&imported.profile.id),
                &oscrypt::InjectedKeyring::single(linux_key())
            ),
            b"SID=past"
        );
    }

    /// Cancelling unwinds completely. A half-imported profile is worse than none: it looks launchable
    /// and is not the browser its cookies came from.
    #[test]
    fn a_cancelled_import_leaves_nothing_behind() {
        let root = temp_root("cancel");
        let source = Machine::new(&root, "source", 108);
        let target = Machine::new(&root, "target", 109);

        let profile = source.create("Interrupted");
        build_udd(
            &source.profiles_dir.join(&profile.id),
            &linux_key(),
            b"SID=cancelled",
            "token",
        );
        let file = root.join("cancel.lobprofile");
        export(&source, &profile.id, &file, "passphrase");

        let op_id = uuid::Uuid::new_v4().to_string();
        cancel_profile_file_op(op_id.clone());
        let reporter = Reporter::new(Some(op_id.clone()), None);
        let err = import_inner(&target.data(), &file, "passphrase", None, &reporter, None)
            .unwrap_err()
            .to_string();

        assert!(err.contains("CANCELLED"), "got: {err}");
        assert!(target.list().is_empty());
        drop(reporter);
        assert!(
            !cancellations().lock().unwrap().contains(&op_id),
            "a finished operation must release its cancel flag, or the next one starts cancelled"
        );
    }

    /// A body whose artifact bytes do not match the manifest describing them is refused, and refused
    /// BEFORE anything reaches the ledger. This is the check that makes a tampered file fail closed
    /// rather than half-restore.
    #[test]
    fn an_artifact_that_does_not_match_its_manifest_is_refused_by_the_ledger() {
        let root = temp_root("mismatch");
        let machine = Machine::new(&root, "m", 110);
        let data = machine.data();

        let profile = machine.create("Tampered");
        let udd = machine.profiles_dir.join(&profile.id);
        build_udd(&udd, &linux_key(), b"SID=tampered", "token");
        let identity = {
            let conn = machine.db.lock().unwrap();
            snapshot::commands::identity_of_row(&conn, &machine.cipher, &profile.id).unwrap()
        };
        let keyring = oscrypt::InjectedKeyring::single(linux_key());
        let manifest = snapshot::capture_with_keyring(
            &data.vault,
            &udd,
            &profile.id,
            CaptureMode::Quiesced,
            &identity,
            &CaptureOptions::default(),
            &keyring,
        )
        .unwrap();

        let mut artifacts: Vec<(String, Vec<u8>)> = manifest
            .artifacts
            .iter()
            .map(|record| {
                (
                    record.id.clone(),
                    data.vault
                        .get_artifact(
                            &profile.id,
                            record.captured_in_version,
                            &record.id,
                            &record.sealed_digest,
                        )
                        .unwrap(),
                )
            })
            .collect();
        artifacts[0].1.push(0);

        let err = data
            .vault
            .adopt("prf_elsewhere", &manifest, artifacts.clone())
            .unwrap_err()
            .to_string();
        assert!(err.contains("PLAIN_DIGEST_MISMATCH"), "got: {err}");
        assert!(
            data.vault.versions("prf_elsewhere").unwrap().is_empty(),
            "a refused adoption must commit nothing"
        );

        // And an artifact the manifest never named is refused too, rather than sitting unreferenced.
        artifacts[0].1.pop();
        artifacts.push(("history".into(), b"not in this manifest".to_vec()));
        let err = data
            .vault
            .adopt("prf_elsewhere", &manifest, artifacts)
            .unwrap_err()
            .to_string();
        assert!(
            err.contains("UNNAMED_ARTIFACT") || err.contains("INCOMPLETE_TRANSFER"),
            "got: {err}"
        );
    }

    /// The digest chain is what a cross-machine transfer has to re-establish, so assert it directly:
    /// after adoption every record names a blob THIS ledger holds, and the plaintext is unchanged.
    #[test]
    fn adoption_re_points_every_sealed_digest_at_this_ledger() {
        let root = temp_root("adopt");
        let source = Machine::new(&root, "source", 111);
        let target = Machine::new(&root, "target", 112);

        let profile = source.create("Digest Chain");
        let udd = source.profiles_dir.join(&profile.id);
        build_udd(&udd, &linux_key(), b"SID=chain", "token");
        let source_data = source.data();
        let identity = {
            let conn = source.db.lock().unwrap();
            snapshot::commands::identity_of_row(&conn, &source.cipher, &profile.id).unwrap()
        };
        let keyring = oscrypt::InjectedKeyring::single(linux_key());
        let manifest = snapshot::capture_with_keyring(
            &source_data.vault,
            &udd,
            &profile.id,
            CaptureMode::Quiesced,
            &identity,
            &CaptureOptions::default(),
            &keyring,
        )
        .unwrap();

        let artifacts: Vec<(String, Vec<u8>)> = manifest
            .artifacts
            .iter()
            .map(|record| {
                (
                    record.id.clone(),
                    source_data
                        .vault
                        .get_artifact(
                            &profile.id,
                            record.captured_in_version,
                            &record.id,
                            &record.sealed_digest,
                        )
                        .unwrap(),
                )
            })
            .collect();

        let target_data = target.data();
        let adopted = target_data
            .vault
            .adopt("prf_target", &manifest, artifacts.clone())
            .unwrap();

        assert_eq!(adopted.profile_id, "prf_target");
        for record in &adopted.artifacts {
            let original = manifest.artifact(&record.id).unwrap();
            assert_ne!(
                record.sealed_digest, original.sealed_digest,
                "`{}` still names the source ledger's blob",
                record.id
            );
            assert_eq!(
                record.plain_digest, original.plain_digest,
                "`{}` changed underneath the transfer",
                record.id
            );
            assert_eq!(record.captured_in_version, adopted.version);
            let bytes = target_data
                .vault
                .get_artifact(
                    "prf_target",
                    record.captured_in_version,
                    &record.id,
                    &record.sealed_digest,
                )
                .unwrap();
            assert_eq!(digest_hex(&bytes), record.plain_digest);
        }
    }

    /// Where the time actually goes, against a REAL profile.
    ///
    /// `#[ignore]`d because it needs a user-data-dir no CI runner has, and because it is a
    /// measurement rather than an assertion — a timing threshold on a shared runner is a flaky test,
    /// and the number that matters is the comparison between two runs of this on one machine.
    ///
    /// ```text
    /// LOBSTER_SNAPSHOT_REAL_PROFILE=~/.local/share/com.lobster.browser/profiles/prf_… \
    ///   cargo test --lib -- --ignored --nocapture where_the_time_goes
    /// ```
    #[test]
    #[ignore = "measurement against a real profile: set LOBSTER_SNAPSHOT_REAL_PROFILE"]
    fn where_the_time_goes_on_a_real_profile() {
        let Ok(source_dir) = std::env::var("LOBSTER_SNAPSHOT_REAL_PROFILE") else {
            eprintln!("set LOBSTER_SNAPSHOT_REAL_PROFILE=<path to a profile user-data-dir>");
            return;
        };
        let source_dir = PathBuf::from(source_dir);
        assert!(
            source_dir.is_dir(),
            "{} is not a directory",
            source_dir.display()
        );

        let root = temp_root("bench");
        let source = Machine::new(&root, "source", 200);
        let target = Machine::new(&root, "target", 201);
        let profile = source.create("Benchmark");
        let udd = source.profiles_dir.join(&profile.id);

        // Only the artifact sources are copied. The rest of a real profile is 1–4 GB of cache that
        // the allowlist never reads, and copying it would time the filesystem instead of the code.
        let mut copied = 0u64;
        for spec in snapshot::manifest::ARTIFACTS {
            for rel in spec.sources {
                let from = source_dir.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                let to = udd.join(rel.replace('/', std::path::MAIN_SEPARATOR_STR));
                copied += copy_source(&from, &to);
            }
        }
        for rel in [
            "Local State",
            "Default/LocalStorage-wal",
            "Default/SessionStorage-wal",
        ] {
            copied += copy_source(&source_dir.join(rel), &udd.join(rel));
        }
        eprintln!("\n=== {} ===", source_dir.display());
        eprintln!("on-disk identity set        {:>10}", human(copied));

        // Split so the three phases are attributable rather than one total: capture is filesystem and
        // codec work, sealing is CBOR + deflate + Argon2 + AES, and import is the ledger write plus a
        // full verified restore.
        let data = source.data();
        let identity = {
            let conn = source.db.lock().unwrap();
            snapshot::commands::identity_of_row(&conn, &source.cipher, &profile.id).unwrap()
        };
        let started = std::time::Instant::now();
        let manifest = snapshot::capture(
            &data.vault,
            &udd,
            &profile.id,
            CaptureMode::Quiesced,
            &identity,
            &CaptureOptions::default(),
        )
        .unwrap();
        let capture_ms = started.elapsed().as_millis();
        let ledger_bytes: u64 = manifest.artifacts.iter().map(|a| a.sealed_bytes).sum();
        let plain_bytes: u64 = manifest.artifacts.iter().map(|a| a.plain_bytes).sum();

        let file = root.join("bench.lobprofile");
        let started = std::time::Instant::now();
        let report = export_inner(
            &data,
            &profile.id,
            file.to_str().unwrap(),
            "benchmark passphrase",
            None,
            ExportOptions {
                capture: Some("reuse-latest".into()),
                ..Default::default()
            },
            ExportRuntime {
                reporter: &Reporter::new(None, None),
                keyring: None,
            },
        )
        .unwrap();
        let seal_ms = started.elapsed().as_millis();

        let started = std::time::Instant::now();
        let imported = import(&target, &file, "benchmark passphrase").unwrap();
        let import_ms = started.elapsed().as_millis();
        assert!(imported.restore.ok, "{:?}", imported.restore.failure);

        // What the same snapshot weighs on the sync wire, against the server's 25 MiB limit.
        let for_sync: Vec<(String, ArtifactBytes)> = manifest
            .artifacts
            .iter()
            .map(|record| {
                (
                    record.id.clone(),
                    ArtifactBytes(
                        data.vault
                            .get_artifact(
                                &profile.id,
                                record.captured_in_version,
                                &record.id,
                                &record.sealed_digest,
                            )
                            .unwrap(),
                    ),
                )
            })
            .collect();
        let (as_json, framed) = crate::profile_sync::measure_encodings(&manifest, for_sync);

        eprintln!("captured artifact bytes     {:>10}", human(plain_bytes));
        eprintln!("sync payload (JSON, was)    {:>10}", human(as_json as u64));
        eprintln!("sync payload (framed, now)  {:>10}", human(framed as u64));
        eprintln!("sealed into the ledger      {:>10}", human(ledger_bytes));
        eprintln!("exported file               {:>10}", human(report.bytes));
        eprintln!("capture                     {:>8} ms", capture_ms);
        eprintln!("export from the ledger      {:>8} ms", seal_ms);
        eprintln!("import (open+ledger+restore){:>8} ms", import_ms);
        eprintln!("artifacts                   {:>10}", report.artifacts.len());
        for id in &report.artifacts {
            eprintln!("  - {id}");
        }
        for note in &report.omitted {
            eprintln!("  omitted: {note}");
        }
    }

    fn copy_source(from: &Path, to: &Path) -> u64 {
        let Ok(meta) = std::fs::symlink_metadata(from) else {
            return 0;
        };
        if meta.file_type().is_symlink() {
            return 0;
        }
        if meta.is_file() {
            if let Some(parent) = to.parent() {
                std::fs::create_dir_all(parent).unwrap();
            }
            std::fs::copy(from, to).unwrap();
            return meta.len();
        }
        if !meta.is_dir() {
            return 0;
        }
        std::fs::create_dir_all(to).unwrap();
        let mut total = 0;
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            total += copy_source(&entry.path(), &to.join(entry.file_name()));
        }
        total
    }

    fn human(bytes: u64) -> String {
        if bytes < 1024 {
            format!("{bytes} B")
        } else if bytes < 1024 * 1024 {
            format!("{:.1} KB", bytes as f64 / 1024.0)
        } else {
            format!("{:.2} MB", bytes as f64 / (1024.0 * 1024.0))
        }
    }

    #[test]
    fn a_file_that_is_not_ours_is_rejected_before_anything_is_parsed() {
        let dir = std::env::temp_dir().join(format!("lobp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("not-a-profile.lobprofile");
        std::fs::write(&path, b"PK\x03\x04 this is a zip file").unwrap();

        let err = read_header(&path).unwrap_err().to_string();
        assert!(err.contains("not a Lobster profile file"), "got: {err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
