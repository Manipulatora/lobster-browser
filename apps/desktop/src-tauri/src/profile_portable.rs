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
use std::io::Write;
use std::path::{Path, PathBuf};

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
const FORMAT_VERSION: u32 = 1;
/// A header larger than this is a corrupt or hostile file, not one of ours; refuse before allocating.
const MAX_HEADER_BYTES: u32 = 256 * 1024;
/// Argon2id cost. 64 MiB / 3 passes is the OWASP baseline and takes well under a second on a laptop,
/// while making an offline guessing run against a stolen file expensive.
const KDF_MEMORY_KIB: u32 = 65_536;
const KDF_PASSES: u32 = 3;
const KDF_LANES: u32 = 1;

/// Fields on the proxy blob that are credentials rather than routing.
const PROXY_SECRET_FIELDS: [&str; 2] = ["username", "password"];

/// The profile row, reduced to what is portable. See the module docs for the exclusions.
#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableRow {
    source_profile_id: String,
    name: String,
    engine: String,
    os: String,
    os_version: Option<String>,
    /// Verbatim — this IS the identity, and pinning it on import is what makes the restore verify.
    fingerprint_seed: String,
    /// The raw column TEXT, not a re-serialized value. `Identity` digests the overrides with
    /// `serde_json::to_string`, so a decode/encode round-trip that renumbers a float would change the
    /// digest and make the import refuse its own file.
    fingerprint_overrides_json: Option<String>,
    proxy: Option<serde_json::Value>,
    cookies_import: Option<serde_json::Value>,
    cookies_import_applied_at: Option<String>,
    extensions: Option<serde_json::Value>,
    tags: Vec<String>,
    folder: Option<String>,
    notes: Option<String>,
    /// Argon2 PHC string. Not reversible, so carrying it keeps the copy locked with the same password
    /// instead of silently unlocking a protected profile by exporting it.
    password_hash: Option<String>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PortableBody {
    format_version: u32,
    row: PortableRow,
    manifest: SnapshotManifest,
    /// `(artifact id, sealed bytes)` — the same shape `profile_sync` uses, so the two stay comparable.
    artifacts: Vec<(String, Vec<u8>)>,
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

fn app_data_dir(state: &AppState) -> Result<PathBuf, String> {
    state
        .profiles_dir
        .parent()
        .map(|p| p.to_path_buf())
        .ok_or_else(|| "profiles directory has no parent; cannot locate the snapshot ledger".into())
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

#[tauri::command]
pub fn export_profile_file(
    state: State<'_, AppState>,
    id: String,
    dest_path: String,
    passphrase: String,
    profile_password: Option<String>,
    options: Option<ExportOptions>,
) -> Result<ExportReport, String> {
    export_inner(
        &state,
        &id,
        &dest_path,
        &passphrase,
        profile_password.as_deref(),
        options.unwrap_or_default(),
    )
    .map_err(|e| format!("{e:#}"))
}

fn export_inner(
    state: &State<'_, AppState>,
    id: &str,
    dest_path: &str,
    passphrase: &str,
    profile_password: Option<&str>,
    options: ExportOptions,
) -> Result<ExportReport> {
    let (profile, password_hash, overrides_json) = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        let profile = profile_store::get(&conn, &state.cipher, id)
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

        let hash: Option<String> = conn
            .query_row(
                "SELECT password_hash FROM profiles WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|e| anyhow!("reading the profile's password hash: {e}"))?;

        // The raw column text, so the overrides digest survives the round trip byte for byte.
        let overrides: Option<String> = conn
            .query_row(
                "SELECT fingerprint_overrides FROM profiles WHERE id = ?1",
                rusqlite::params![id],
                |row| row.get(0),
            )
            .map_err(|e| anyhow!("reading the profile's fingerprint overrides: {e}"))?;

        (profile, hash, overrides)
    };

    let vault = SnapshotVault::open(&app_data_dir(state).map_err(|e| anyhow!("{e}"))?)
        .context("opening the snapshot ledger")?;
    let identity = snapshot::commands::identity_of(state, id).map_err(|e| anyhow!("{e}"))?;

    let mut omitted: Vec<String> = Vec::new();

    let manifest = match options.capture.as_deref() {
        Some("reuse-latest") => {
            let version = vault
                .latest_version(id)?
                .ok_or_else(|| anyhow!("{id} has no snapshot to reuse — capture one first"))?;
            vault.manifest(id, version)?
        }
        mode => {
            let mode = parse_mode(mode.unwrap_or("quiesced")).map_err(|e| anyhow!("{e}"))?;
            snapshot::capture(
                &vault,
                &state.profiles_dir.join(id),
                id,
                mode,
                &identity,
                &CaptureOptions {
                    exclude: options.exclude_artifacts.clone(),
                    ..Default::default()
                },
            )
            .context("capturing the profile's data")?
        }
    };

    for (artifact, reason) in &manifest.skipped {
        omitted.push(format!("{artifact} ({reason})"));
    }

    let mut artifacts = Vec::with_capacity(manifest.artifacts.len());
    for record in &manifest.artifacts {
        let bytes = vault
            .get_artifact(
                id,
                record.captured_in_version,
                &record.id,
                &record.sealed_digest,
            )
            .with_context(|| format!("reading `{}` out of the ledger to export", record.id))?;
        artifacts.push((record.id.clone(), bytes));
    }

    let (proxy, credentials_included) =
        redact_proxy(profile.proxy.clone(), options.include_proxy_credentials);
    if profile.proxy.is_some() && !options.include_proxy_credentials {
        omitted.push("proxy username and password".to_string());
    }

    let row = PortableRow {
        source_profile_id: profile.id.clone(),
        name: profile.name.clone(),
        engine: profile.engine.clone(),
        os: profile.os.clone(),
        os_version: profile.os_version.clone(),
        fingerprint_seed: profile.fingerprint_seed.clone(),
        fingerprint_overrides_json: overrides_json,
        proxy,
        cookies_import: profile.cookies_import.clone(),
        cookies_import_applied_at: profile.cookies_import_applied_at.clone(),
        extensions: profile.extensions.clone(),
        tags: profile.tags.clone(),
        folder: profile.folder.clone(),
        notes: profile.notes.clone(),
        password_hash: password_hash.clone(),
    };

    let artifact_ids: Vec<String> = manifest.artifacts.iter().map(|a| a.id.clone()).collect();
    let coherence = format!("{:?}", manifest.coherence).to_lowercase();
    let snapshot_version = manifest.version;

    let body = PortableBody {
        format_version: FORMAT_VERSION,
        row,
        manifest,
        artifacts,
    };

    let mut encoded = Vec::new();
    ciborium::into_writer(&body, &mut encoded).context("encoding the profile for export")?;

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
        password_protected: password_hash.is_some(),
        has_proxy: body.row.proxy.is_some(),
        has_proxy_credentials: credentials_included,
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

    // Never write the destination directly: a half-written file with the real extension looks
    // importable. Write a sibling `.part`, flush it, then rename — the vault's own pattern.
    let part = dest.with_extension("part");
    {
        let mut file =
            fs::File::create(&part).with_context(|| format!("creating {}", part.display()))?;
        file.write_all(MAGIC)?;
        file.write_all(&(header_json.len() as u32).to_le_bytes())?;
        file.write_all(&header_json)?;
        file.write_all(&sealed)?;
        file.flush()?;
        file.sync_all().ok();
    }
    fs::rename(&part, dest)
        .with_context(|| format!("moving the export into place at {}", dest.display()))?;

    let bytes = fs::metadata(dest).map(|m| m.len()).unwrap_or(0);

    Ok(ExportReport {
        path: dest_path.to_string(),
        bytes,
        profile_id: profile.id,
        profile_name: profile.name,
        snapshot_version,
        coherence,
        artifacts: artifact_ids,
        omitted,
    })
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
    Ok((header, bytes, end))
}

#[tauri::command]
pub fn inspect_profile_file(
    state: State<'_, AppState>,
    path: String,
) -> Result<ImportPreview, String> {
    inspect_inner(&state, Path::new(&path)).map_err(|e| format!("{e:#}"))
}

fn inspect_inner(state: &State<'_, AppState>, path: &Path) -> Result<ImportPreview> {
    let (header, bytes, _) = read_header(path)?;
    let bytes = bytes.len() as u64;

    let (already_present, name_collision) = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        let existing = profile_store::list(&conn, &state.cipher).map_err(|e| anyhow!("{e}"))?;
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
) -> Result<ImportReport, String> {
    import_inner(&state, Path::new(&path), &passphrase, name_override).map_err(|e| format!("{e:#}"))
}

fn import_inner(
    state: &State<'_, AppState>,
    path: &Path,
    passphrase: &str,
    name_override: Option<String>,
) -> Result<ImportReport> {
    // 1. Open the file. NOTHING is written until this has fully succeeded.
    let (header, all, body_offset) = read_header(path)?;
    let sealed = &all[body_offset..];

    let salt = base64_decode(&header.kdf.salt_b64)?;
    let key = derive_key(passphrase, &salt)?;
    let (plain, _) = BlobCipher::new(&key)
        .decrypt(sealed)
        // The AEAD tag cannot tell a wrong passphrase from a tampered file, and the honest message
        // for the overwhelmingly common case is the password one.
        .map_err(|_| anyhow!("WRONG_PASSPHRASE: that password does not open this file"))?;
    let body: PortableBody =
        ciborium::from_reader(&plain[..]).context("this file is damaged and cannot be imported")?;
    if body.format_version > FORMAT_VERSION {
        bail!(
            "this profile was exported by a newer version of Lobster. Update Lobster, then import it."
        );
    }

    let mut warnings: Vec<String> = Vec::new();

    // 2. Create the row FIRST, with the seed PINNED, so `identity_of` on the new id reproduces the
    //    manifest's identity and the restore below can verify rather than be forced.
    let overrides = match &body.row.fingerprint_overrides_json {
        Some(text) => Some(
            serde_json::from_str::<serde_json::Value>(text)
                .context("the exported fingerprint overrides are malformed")?,
        ),
        None => None,
    };

    let created = {
        let conn = state.db.lock().map_err(|e| anyhow!("{e}"))?;
        let existing = profile_store::list(&conn, &state.cipher).map_err(|e| anyhow!("{e}"))?;
        let mut name = name_override.unwrap_or_else(|| body.row.name.clone());
        if existing.iter().any(|p| p.name == name) {
            name = format!("{name} (imported)");
            warnings.push(format!(
                "A profile named \"{}\" already existed, so this one was renamed to \"{name}\".",
                body.row.name
            ));
        }
        let created = profile_store::create(
            &conn,
            &state.cipher,
            CreateProfileInput {
                name,
                engine: body.row.engine.clone(),
                os: body.row.os.clone(),
                os_version: body.row.os_version.clone(),
                fingerprint_seed: Some(body.row.fingerprint_seed.clone()),
                fingerprint_overrides: overrides,
                proxy: body.row.proxy.clone(),
                proxy_id: None,
                template_id: None,
                cookies_import: body.row.cookies_import.clone(),
                extensions: body.row.extensions.clone(),
                tags: Some(body.row.tags.clone()),
                folder: body.row.folder.clone(),
                notes: body.row.notes.clone(),
            },
        )
        .map_err(|e| anyhow!("creating the imported profile: {e}"))?;

        if let Some(hash) = &body.row.password_hash {
            profile_store::set_password_hash(&conn, &created.id, Some(hash))
                .map_err(|e| anyhow!("carrying the profile's password across: {e}"))?;
        }
        created
    };

    // From here on, any failure must leave nothing behind.
    let result = finish_import(state, &created, body, &mut warnings);
    match result {
        Ok(report) => Ok(report),
        Err(err) => {
            rollback(state, &created.id);
            Err(err)
        }
    }
}

/// Write the snapshot into the vault under the NEW id, then restore it into the new user-data-dir.
fn finish_import(
    state: &State<'_, AppState>,
    created: &Profile,
    body: PortableBody,
    warnings: &mut Vec<String>,
) -> Result<ImportReport> {
    let vault = SnapshotVault::open(&app_data_dir(state).map_err(|e| anyhow!("{e}"))?)
        .context("opening the snapshot ledger")?;

    let (snapshot_version, _dir) = vault.begin(&created.id)?;

    // The extra step over `profile_sync::pull`: there the id is identical on both machines, here it
    // is NOT, so the manifest has to be re-pointed or the vault refuses it as an identity mismatch.
    let mut manifest = body.manifest;
    manifest.profile_id = created.id.clone();
    manifest.version = snapshot_version;
    for record in &mut manifest.artifacts {
        record.captured_in_version = snapshot_version;
    }

    for (id, bytes) in body.artifacts {
        vault
            .put_artifact(&created.id, snapshot_version, &id, &bytes)
            .with_context(|| format!("writing imported `{id}` into the ledger"))?;
    }
    vault.commit(&manifest)?;

    let udd = state.profiles_dir.join(&created.id);
    let target = snapshot::commands::identity_of(state, &created.id).map_err(|e| anyhow!("{e}"))?;

    // force = FALSE, always. The seed was pinned above, so a mismatch here means the export was
    // wrong, and forcing it would write a session onto a device it does not belong to.
    let report = snapshot::restore(&vault, &udd, &created.id, snapshot_version, &target, false)
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

    Ok(ImportReport {
        profile: created.clone(),
        snapshot_version,
        restore: report,
        warnings: std::mem::take(warnings),
    })
}

/// Undo a partial import. Best effort by design: the caller is already returning an error, and a
/// failure to clean up must not replace that error with a less useful one.
fn rollback(state: &State<'_, AppState>, id: &str) {
    if let Ok(conn) = state.db.lock() {
        // `purge` only deletes a trashed row, so trash it first — the profile never really existed.
        let _ = profile_store::delete(&conn, id);
        let _ = profile_store::purge(&conn, id);
    }
    let _ = crate::remove_profile_data_dir(&state.profiles_dir, id);
}

#[cfg(test)]
mod tests {
    use super::*;

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
