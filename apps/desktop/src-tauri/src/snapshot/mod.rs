//! Local snapshot engine: capture a profile's identity artifacts, verify them, and restore them
//! without ever being able to destroy the copy that is already on disk.
//!
//! ## What this is for
//!
//! Nothing in the shipping product has ever backed up a byte of profile data. Cookies survive only
//! because the user-data-dir happens to persist; localStorage, sessionStorage, IndexedDB and
//! extension state have no import, export or backup path of any kind; and cookie export requires the
//! profile to be RUNNING and launched by the CURRENT sidecar, so a profile that cannot launch — a dead
//! proxy, a corrupt directory, a crashed sidecar, a forgotten profile password — is exactly the one
//! whose session cannot be recovered. This module is the answer to that, and it deliberately depends
//! on no account, no password and no network:
//!
//! * capture is a FILESYSTEM READ. It never calls `profile_store::verify_password` and never requires
//!   `status == 'running'`. Those two gates are what made an unlaunchable profile unrecoverable.
//! * the ledger is encrypted under the existing per-install Local Store Key only.
//!
//! The LSK is per-install, so a snapshot does not travel to a new machine. That is a real limit, not
//! an oversight, and it is what the account-derived key ladder exists to lift later.
//!
//! ## The restore contract
//!
//! Stage → fsync → structural check → read back THROUGH THE CAPTURE CODEC → digest compare → park the
//! live files (with their `-wal`/`-shm`/`-journal` sidecars) → atomic rename → and on any failure, put
//! the parked files back. Nothing is deleted before its replacement has been verified. A restore that
//! fails must leave the profile exactly as it was, because the situations in which a user reaches for
//! restore are the situations in which they cannot afford to lose what they still have.
//!
//! Rollback is transactional across the WHOLE artifact set, not per artifact: a failure on the eighth
//! artifact undoes the seven that already landed. A profile holding seven artifacts from a snapshot and
//! four from before it is a state no capture ever produced and no site has ever seen.

pub mod commands;
pub mod dir_tar;
pub mod dom_storage;
pub mod idb;
pub mod manifest;
pub mod prefs;
pub mod sqlite_copy;
pub mod vault;

use std::path::{Path, PathBuf};
use std::time::Instant;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use dom_storage::{DomBackend, DomRecords, DomStore};
use idb::IdbRecords;
use manifest::{
    digest_hex, resolve_source, ArtifactKind, ArtifactRecord, CaptureMode, Coherence, Fidelity,
    SnapshotManifest, ARTIFACTS, MANIFEST_VERSION,
};
use vault::SnapshotVault;

/// Highest `meta.version` we know how to read for each schema-versioned artifact, from the fork:
/// Cookies 24/24, Login Data 43/40, Web Data 152/151, History 70/16. Read but not enforced as a
/// restore gate in this phase — the cross-engine-version policy (refuse downgrades, route a differing
/// major through CDP) belongs with the cookie transcoder.
const COOKIES_MAX_VERSION: i64 = 24;

/// Which artifacts to capture. Empty means the whole registry.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CaptureOptions {
    /// Artifact ids to leave out. `serviceworkers` is not in the registry at all yet: a service-worker
    /// registration restored without its matching Cache Storage can be worse than absent, and the
    /// caches are deliberately excluded as re-fetchable.
    #[serde(default)]
    pub exclude: Vec<String>,
}

impl CaptureOptions {
    fn includes(&self, id: &str) -> bool {
        !self.exclude.iter().any(|e| e == id)
    }
}

/// A staged artifact: its payload, plus what the manifest should say about it.
struct Captured {
    payload: Vec<u8>,
    fidelity: Fidelity,
    backend: Option<String>,
    counts: Vec<(String, u64)>,
}

/// One or more whole files carried verbatim, keyed by their path relative to the user-data-dir.
///
/// Used by the SQLite artifacts (payload = the `VACUUM INTO` output) and by `Bookmarks`. Multi-source
/// artifacts ride here too: `Login Data` and `Login Data For Account` are one artifact because a
/// restore that lands one without the other is a half password store.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileSet {
    files: Vec<FileEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
struct FileEntry {
    rel: String,
    bytes: Vec<u8>,
}

impl FileSet {
    fn encode(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::into_writer(self, &mut out).context("encoding file set")?;
        Ok(out)
    }

    fn decode(bytes: &[u8]) -> Result<Self> {
        ciborium::from_reader(bytes).context("decoding file set")
    }
}

/// Capture `udd` into the vault as a new version. Returns the committed manifest.
pub fn capture(
    vault: &SnapshotVault,
    udd: &Path,
    profile_id: &str,
    mode: CaptureMode,
    options: &CaptureOptions,
) -> Result<SnapshotManifest> {
    if !udd.is_dir() {
        bail!(
            "profile {profile_id} has no user-data-dir at {} — nothing to capture",
            udd.display()
        );
    }
    if mode == CaptureMode::Quiesced {
        // A "quiesced" label on a snapshot taken beside a live browser is a lie the restore UI would
        // then act on, preferring it over a genuinely coherent older one.
        match sqlite_copy::assert_no_live_owner(udd)? {
            sqlite_copy::LiveOwner::None => {}
            sqlite_copy::LiveOwner::Alive { detail } => bail!(
                "PROFILE_IS_RUNNING: cannot take a quiesced capture of {profile_id} — {detail}. Stop \
                 the browser, or capture in Live mode and accept a loose coherence window."
            ),
            sqlite_copy::LiveOwner::Unknown { detail } => bail!(
                "PROFILE_OWNER_UNKNOWN: cannot prove {profile_id} is stopped — {detail}. Capture in \
                 Dirty mode to snapshot it anyway; the result will be labelled `dirty`."
            ),
        }
    }

    let previous = match vault.latest_version(profile_id)? {
        Some(version) => vault.manifest(profile_id, version).ok(),
        None => None,
    };
    let (version, version_dir) = vault.begin(profile_id)?;
    let scratch = version_dir.join(".scratch");
    let result = capture_artifacts(
        vault,
        udd,
        profile_id,
        version,
        mode,
        options,
        previous.as_ref(),
        &scratch,
    );
    let _ = std::fs::remove_dir_all(&scratch);
    match result {
        Ok(manifest) => {
            vault.commit(&manifest)?;
            tracing::info!(
                profile_id,
                version,
                mode = mode.label(),
                artifacts = manifest.artifacts.len(),
                coherence = %manifest.coherence.label,
                window_ms = manifest.coherence.window_ms,
                "captured snapshot"
            );
            Ok(manifest)
        }
        Err(err) => {
            // An uncommitted version directory is invisible to `versions()`, but leaving it behind
            // would make the next capture's version number skip and confuse a later reader.
            let _ = vault.discard(profile_id, version);
            Err(err)
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn capture_artifacts(
    vault: &SnapshotVault,
    udd: &Path,
    profile_id: &str,
    version: u64,
    mode: CaptureMode,
    options: &CaptureOptions,
    previous: Option<&SnapshotManifest>,
    scratch: &Path,
) -> Result<SnapshotManifest> {
    std::fs::create_dir_all(scratch)?;
    let started = Instant::now();
    let mut artifacts = Vec::new();
    let mut absent = Vec::new();
    let mut skipped = Vec::new();

    for spec in ARTIFACTS {
        if !options.includes(spec.id) {
            skipped.push((
                spec.id.to_string(),
                "excluded by capture options".to_string(),
            ));
            continue;
        }
        if spec.quiesced_only && mode != CaptureMode::Quiesced {
            // Carry the last good copy forward by REFERENCE rather than dropping the artifact. A
            // snapshot that silently has no extension state is indistinguishable from one whose
            // extension state was genuinely empty.
            match previous.and_then(|m| m.artifact(spec.id)) {
                Some(record) => {
                    skipped.push((
                        spec.id.to_string(),
                        format!(
                            "LevelDB-backed and this is a {} capture; carried forward from version {}",
                            mode.label(),
                            record.captured_in_version
                        ),
                    ));
                    artifacts.push(ArtifactRecord {
                        fidelity: Fidelity::Stale,
                        offset_ms: started.elapsed().as_millis() as u64,
                        ..record.clone()
                    });
                }
                None => skipped.push((
                    spec.id.to_string(),
                    format!(
                        "LevelDB-backed and this is a {} capture; no earlier version to carry forward",
                        mode.label()
                    ),
                )),
            }
            continue;
        }

        let offset_ms = started.elapsed().as_millis() as u64;
        let captured = match capture_artifact(udd, spec, &scratch.join(spec.id)) {
            Ok(Some(captured)) => captured,
            Ok(None) => {
                absent.push(spec.id.to_string());
                continue;
            }
            Err(err) => {
                // One unreadable artifact must not cost the user the other ten. The failure is named
                // in the manifest so a restore can say what this snapshot does not contain.
                tracing::warn!(profile_id, artifact = spec.id, %err, "artifact capture failed");
                skipped.push((spec.id.to_string(), format!("{err:#}")));
                continue;
            }
        };
        let plain_digest = digest_hex(&captured.payload);
        let (sealed_digest, sealed_bytes) =
            vault.put_artifact(profile_id, version, spec.id, &captured.payload)?;
        artifacts.push(ArtifactRecord {
            id: spec.id.to_string(),
            kind: spec.kind,
            plain_digest,
            sealed_digest,
            plain_bytes: captured.payload.len() as u64,
            sealed_bytes,
            fidelity: captured.fidelity,
            backend: captured.backend,
            counts: captured.counts,
            captured_in_version: version,
            offset_ms,
        });
    }

    let window_ms = started.elapsed().as_millis() as u64;
    Ok(SnapshotManifest {
        manifest_version: MANIFEST_VERSION,
        profile_id: profile_id.to_string(),
        version,
        captured_at: chrono::Utc::now().to_rfc3339(),
        capture_mode: mode,
        coherence: Coherence::new(mode, window_ms),
        artifacts,
        absent,
        skipped,
    })
}

/// `Ok(None)` means the artifact is legitimately absent from this profile — the normal answer for
/// `Bookmarks` (0/9 real profiles), `IndexedDB` (4/9) and `Local Extension Settings` (3/9).
fn capture_artifact(
    udd: &Path,
    spec: &manifest::ArtifactSpec,
    scratch: &Path,
) -> Result<Option<Captured>> {
    match spec.kind {
        ArtifactKind::SqliteVacuum => {
            std::fs::create_dir_all(scratch)?;
            let mut files = Vec::new();
            for (index, source) in spec.sources.iter().enumerate() {
                let path = resolve_source(udd, source)?;
                if !path.is_file() {
                    continue;
                }
                let staged = scratch.join(format!("{index}.db"));
                sqlite_copy::vacuum_into(&path, &staged)?;
                if spec.id == "cookies" {
                    let conn = sqlite_copy::open_read_write(&staged)?;
                    sqlite_copy::meta_version(&conn, COOKIES_MAX_VERSION)?;
                }
                files.push(FileEntry {
                    rel: (*source).to_string(),
                    bytes: std::fs::read(&staged)?,
                });
                let _ = std::fs::remove_file(&staged);
            }
            if files.is_empty() {
                return Ok(None);
            }
            files.sort_by(|a, b| a.rel.cmp(&b.rel));
            let counts = files
                .iter()
                .map(|f| (f.rel.clone(), f.bytes.len() as u64))
                .collect();
            Ok(Some(Captured {
                payload: FileSet { files }.encode()?,
                fidelity: Fidelity::Full,
                backend: None,
                counts,
            }))
        }
        ArtifactKind::DomStorage => {
            let store = DomStore::from_artifact_id(spec.id)
                .ok_or_else(|| anyhow::anyhow!("{} is not a DOM storage artifact", spec.id))?;
            let backend = dom_storage::detect_backend(udd, store);
            match backend {
                DomBackend::Empty => Ok(None),
                DomBackend::Ambiguous => bail!(
                    "DOM_BACKEND_AMBIGUOUS: {} has BOTH a SQLite file and a non-empty LevelDB \
                     directory for {:?} storage; refusing to guess which one the engine reads",
                    udd.display(),
                    store
                ),
                DomBackend::Sqlite => {
                    std::fs::create_dir_all(scratch)?;
                    let records = dom_storage::capture(
                        &dom_storage::sqlite_path(udd, store),
                        &scratch.join("vacuumed"),
                        store,
                    )?;
                    let counts = vec![
                        ("origins".to_string(), records.area_count()),
                        ("keys".to_string(), records.key_count()),
                    ];
                    Ok(Some(Captured {
                        payload: records.encode()?,
                        fidelity: Fidelity::Full,
                        backend: Some(backend.label().to_string()),
                        counts,
                    }))
                }
                DomBackend::LevelDb => {
                    let dir = dom_storage::leveldb_dir(udd, store);
                    let prefix = dir
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "leveldb".to_string());
                    let payload = dir_tar::tar_dirs(&[(prefix, dir)])?;
                    let counts = vec![("files".to_string(), dir_tar::tar_file_count(&payload)?)];
                    Ok(Some(Captured {
                        payload,
                        // A LevelDB DOM store is as opaque as any other LevelDB directory: the tar
                        // proves the bytes, not the store's internal consistency.
                        fidelity: Fidelity::Opaque,
                        backend: Some(backend.label().to_string()),
                        counts,
                    }))
                }
            }
        }
        ArtifactKind::IndexedDb => {
            let root = resolve_source(udd, spec.sources[0])?;
            if !root.is_dir() {
                return Ok(None);
            }
            let records = idb::capture(&root, &scratch.join("vacuumed"))?;
            if records.entries.is_empty() {
                return Ok(None);
            }
            let counts = vec![
                ("databases".to_string(), records.database_count()),
                ("blobDirs".to_string(), records.blob_dir_count()),
            ];
            Ok(Some(Captured {
                payload: records.encode()?,
                fidelity: Fidelity::Full,
                backend: None,
                counts,
            }))
        }
        ArtifactKind::DirTar => {
            let mut roots = Vec::new();
            for source in spec.sources {
                let path = resolve_source(udd, source)?;
                if path.is_dir() {
                    roots.push((tar_prefix(source)?, path));
                }
            }
            if roots.is_empty() {
                return Ok(None);
            }
            let payload = dir_tar::tar_dirs(&roots)?;
            let counts = vec![
                ("files".to_string(), dir_tar::tar_file_count(&payload)?),
                ("dirs".to_string(), roots.len() as u64),
            ];
            Ok(Some(Captured {
                payload,
                fidelity: Fidelity::Opaque,
                backend: None,
                counts,
            }))
        }
        ArtifactKind::RawJson => {
            let path = resolve_source(udd, spec.sources[0])?;
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                // ENOENT is the COMMON path here, not an edge case: `Default/Bookmarks` is created
                // only on the first bookmark write and is absent from all nine real profiles.
                Err(err) if err.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(err) => return Err(err).context(format!("reading {}", path.display())),
            };
            serde_json::from_slice::<serde_json::Value>(&bytes)
                .with_context(|| format!("{} is not valid JSON", path.display()))?;
            let counts = vec![("bytes".to_string(), bytes.len() as u64)];
            Ok(Some(Captured {
                payload: FileSet {
                    files: vec![FileEntry {
                        rel: spec.sources[0].to_string(),
                        bytes,
                    }],
                }
                .encode()?,
                fidelity: Fidelity::Full,
                backend: None,
                counts,
            }))
        }
        ArtifactKind::PrefsSubset => {
            let path = resolve_source(udd, spec.sources[0])?;
            if !path.is_file() {
                return Ok(None);
            }
            let subset = prefs::extract(&prefs::read_file(&path)?)?;
            let payload = serde_json::to_vec(&subset)?;
            let counts = vec![(
                "keys".to_string(),
                subset.as_object().map_or(0, |o| o.len() as u64),
            )];
            Ok(Some(Captured {
                payload,
                fidelity: Fidelity::Full,
                backend: None,
                counts,
            }))
        }
    }
}

/// The top-level tar prefix for a directory source: its last path component, so
/// `Default/Local Extension Settings` unpacks as `Local Extension Settings/…`.
fn tar_prefix(source: &str) -> Result<String> {
    source
        .rsplit('/')
        .next()
        .filter(|p| !p.is_empty())
        .map(|p| p.to_string())
        .ok_or_else(|| anyhow::anyhow!("artifact source `{source}` has no final component"))
}

// --- Verification ------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifiedArtifact {
    pub id: String,
    pub ok: bool,
    /// Which version's blob was checked — a carried-forward artifact lives in an earlier version.
    pub stored_in_version: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VerifyReport {
    pub profile_id: String,
    pub version: u64,
    pub ok: bool,
    pub artifacts: Vec<VerifiedArtifact>,
    /// Where the ledger lives. Surfaced because the answer to "my backup is broken" is usually "copy
    /// this directory somewhere else before you touch anything", and the user cannot do that if the
    /// path is only in our logs.
    pub ledger_dir: String,
}

/// Re-read every artifact of a stored version and check both digests.
///
/// This touches no user-data-dir. It exists so "is my backup still good?" is answerable without
/// risking the thing being backed up — which is the question a user asks precisely when they are about
/// to need it.
pub fn verify(vault: &SnapshotVault, profile_id: &str, version: u64) -> Result<VerifyReport> {
    let manifest = vault.manifest(profile_id, version)?;
    let mut artifacts = Vec::new();
    let mut ok = true;
    for record in &manifest.artifacts {
        let detail = match vault.get_artifact(
            profile_id,
            record.captured_in_version,
            &record.id,
            &record.sealed_digest,
        ) {
            Ok(plaintext) => {
                let actual = digest_hex(&plaintext);
                if actual == record.plain_digest {
                    None
                } else {
                    Some(format!(
                        "plaintext digest is {actual}, manifest says {}",
                        record.plain_digest
                    ))
                }
            }
            Err(err) => Some(format!("{err:#}")),
        };
        ok &= detail.is_none();
        artifacts.push(VerifiedArtifact {
            id: record.id.clone(),
            ok: detail.is_none(),
            stored_in_version: record.captured_in_version,
            detail,
        });
    }
    Ok(VerifyReport {
        profile_id: profile_id.to_string(),
        version,
        ok,
        artifacts,
        ledger_dir: vault.root().to_string_lossy().to_string(),
    })
}

// --- Restore -----------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RestoreStatus {
    Restored,
    /// Present in the snapshot but deliberately not applied — a sessionStorage namespace that cannot
    /// travel, an artifact the caller excluded.
    Skipped,
    Failed,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoredArtifact {
    pub id: String,
    pub status: RestoreStatus,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub counts: Vec<(String, u64)>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detail: Option<String>,
}

/// The outcome of a restore, including a failed one.
///
/// A rolled-back restore returns `Ok(report)` with `ok: false`, not `Err`: the per-artifact detail is
/// the whole value of the operation, and collapsing it into an error string would throw away which
/// artifact failed and whether the original files came back. Only a failure BEFORE any work starts
/// (no such version, undecryptable manifest) is an `Err`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreReport {
    pub profile_id: String,
    pub version: u64,
    pub ok: bool,
    pub rolled_back: bool,
    pub capture_mode: CaptureMode,
    pub coherence: Coherence,
    pub artifacts: Vec<RestoredArtifact>,
    /// Where the replaced files were parked. Kept, never deleted: a "successful" restore the user then
    /// judges wrong is still a data-loss event if we swept the previous state away.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub pre_restore_dir: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub failure: Option<String>,
}

/// A single move performed during the swap, so it can be undone in reverse.
struct SwapJournal {
    moves: Vec<(PathBuf, PathBuf)>,
}

impl SwapJournal {
    fn record(&mut self, from: PathBuf, to: PathBuf) {
        self.moves.push((from, to));
    }

    /// Undo every move, newest first. Best-effort by necessity — if the filesystem is failing, the
    /// most useful thing left is a log naming exactly what did not come back.
    fn rewind(&mut self) -> Vec<String> {
        let mut problems = Vec::new();
        while let Some((from, to)) = self.moves.pop() {
            if !to.exists() {
                continue;
            }
            if from.exists() {
                let discard = if from.is_dir() {
                    std::fs::remove_dir_all(&from)
                } else {
                    std::fs::remove_file(&from)
                };
                if let Err(err) = discard {
                    problems.push(format!(
                        "could not clear {} before restoring it: {err}",
                        from.display()
                    ));
                    continue;
                }
            }
            if let Err(err) = std::fs::rename(&to, &from) {
                problems.push(format!(
                    "could not move {} back to {}: {err}",
                    to.display(),
                    from.display()
                ));
            }
        }
        problems
    }
}

/// A verified artifact waiting to be swapped in: `(live_path, staged_path)` pairs plus its report row.
struct Staged {
    id: String,
    placements: Vec<(PathBuf, PathBuf)>,
    counts: Vec<(String, u64)>,
    detail: Option<String>,
}

pub fn restore(
    vault: &SnapshotVault,
    udd: &Path,
    profile_id: &str,
    version: u64,
) -> Result<RestoreReport> {
    let manifest = vault.manifest(profile_id, version)?;
    if !udd.is_dir() {
        std::fs::create_dir_all(udd)
            .with_context(|| format!("creating user-data-dir {}", udd.display()))?;
    }
    let stamp = chrono::Utc::now().format("%Y%m%dT%H%M%S%.3f").to_string();
    // Both scratch directories sit at the user-data-dir ROOT, not inside `Default/`.
    //
    // The design puts them under `Default/`, and the reason it gives — a rename must stay on one
    // filesystem — holds either way, since `Default/` is a child of the same directory. Keeping them
    // out of `Default/` means Chromium never enumerates them and the path-drift detector never has to
    // learn about them, which is worth more than matching the letter of the doc.
    let stage_root = udd.join(format!(".lobster-stage-{stamp}"));
    let pre_restore = udd.join(format!(".lobster-pre-restore-{stamp}"));

    let mut report = RestoreReport {
        profile_id: profile_id.to_string(),
        version,
        ok: false,
        rolled_back: false,
        capture_mode: manifest.capture_mode,
        coherence: manifest.coherence.clone(),
        artifacts: Vec::new(),
        pre_restore_dir: None,
        failure: None,
    };

    // PHASE 1 — stage and verify. Nothing in the live directory is touched, so a failure here needs no
    // rollback at all.
    let mut staged = Vec::new();
    for record in &manifest.artifacts {
        match stage_artifact(vault, udd, profile_id, record, &stage_root) {
            Ok(Some(item)) => staged.push(item),
            Ok(None) => report.artifacts.push(RestoredArtifact {
                id: record.id.clone(),
                status: RestoreStatus::Skipped,
                counts: Vec::new(),
                detail: Some("nothing to apply".into()),
            }),
            Err(err) => {
                let detail = format!("{err:#}");
                tracing::error!(profile_id, version, artifact = %record.id, %detail, "staging failed");
                report.artifacts.push(RestoredArtifact {
                    id: record.id.clone(),
                    status: RestoreStatus::Failed,
                    counts: Vec::new(),
                    detail: Some(detail.clone()),
                });
                report.failure = Some(format!("{}: {detail}", record.id));
                let _ = std::fs::remove_dir_all(&stage_root);
                return Ok(report);
            }
        }
    }

    // PHASE 2 — swap. Every move is journalled so the set is all-or-nothing.
    let mut journal = SwapJournal { moves: Vec::new() };
    for item in &staged {
        match swap_in(&item.placements, &pre_restore, udd, &mut journal) {
            Ok(()) => report.artifacts.push(RestoredArtifact {
                id: item.id.clone(),
                status: RestoreStatus::Restored,
                counts: item.counts.clone(),
                detail: item.detail.clone(),
            }),
            Err(err) => {
                let detail = format!("{err:#}");
                tracing::error!(profile_id, version, artifact = %item.id, %detail, "swap failed; rolling back");
                let problems = journal.rewind();
                report.rolled_back = true;
                report.failure = Some(if problems.is_empty() {
                    format!("{}: {detail} (rolled back)", item.id)
                } else {
                    format!(
                        "{}: {detail} (rollback incomplete: {})",
                        item.id,
                        problems.join("; ")
                    )
                });
                for row in &mut report.artifacts {
                    if row.status == RestoreStatus::Restored {
                        row.status = RestoreStatus::Skipped;
                        row.detail = Some("rolled back".into());
                    }
                }
                report.artifacts.push(RestoredArtifact {
                    id: item.id.clone(),
                    status: RestoreStatus::Failed,
                    counts: Vec::new(),
                    detail: Some(detail),
                });
                let _ = std::fs::remove_dir_all(&stage_root);
                if pre_restore.exists() {
                    report.pre_restore_dir = Some(pre_restore.to_string_lossy().to_string());
                }
                return Ok(report);
            }
        }
    }

    let _ = std::fs::remove_dir_all(&stage_root);
    report.ok = true;
    if pre_restore.exists() {
        report.pre_restore_dir = Some(pre_restore.to_string_lossy().to_string());
    }
    // The parked copy IS the undo for the restore that just happened, so the newest one stays. Older
    // ones are pruned: they are complete copies of Login Data, Web Data and the cookie jar, and left
    // unbounded they accumulate a set of stale credential databases inside the user-data-dir that any
    // backup or folder-sync tool would happily pick up. One undo is worth that; five are not.
    prune_pre_restore_dirs(udd, &pre_restore);
    tracing::info!(
        profile_id,
        version,
        artifacts = staged.len(),
        "restored snapshot"
    );
    Ok(report)
}

/// Decrypt, digest-check, materialise and read back one artifact. `Ok(None)` when there is nothing to
/// apply on this machine.
fn stage_artifact(
    vault: &SnapshotVault,
    udd: &Path,
    profile_id: &str,
    record: &ArtifactRecord,
    stage_root: &Path,
) -> Result<Option<Staged>> {
    let payload = vault.get_artifact(
        profile_id,
        record.captured_in_version,
        &record.id,
        &record.sealed_digest,
    )?;
    let actual = digest_hex(&payload);
    if actual != record.plain_digest {
        bail!(
            "PLAIN_DIGEST_MISMATCH: {} decrypted to {actual}, manifest says {}",
            record.id,
            record.plain_digest
        );
    }
    let stage = stage_root.join(&record.id);
    std::fs::create_dir_all(&stage)?;

    match record.kind {
        ArtifactKind::SqliteVacuum | ArtifactKind::RawJson => {
            let set = FileSet::decode(&payload)?;
            let mut placements = Vec::new();
            let mut counts = Vec::new();
            let mut readback = Vec::new();
            for file in &set.files {
                let live = resolve_source(udd, &file.rel)?;
                let staged_path = stage.join(&file.rel);
                if let Some(parent) = staged_path.parent() {
                    std::fs::create_dir_all(parent)?;
                }
                write_and_sync(&staged_path, &file.bytes)?;
                if record.kind == ArtifactKind::SqliteVacuum {
                    sqlite_copy::integrity_check(&staged_path)?;
                } else {
                    serde_json::from_slice::<serde_json::Value>(&file.bytes)
                        .with_context(|| format!("staged {} is not valid JSON", file.rel))?;
                }
                readback.push(FileEntry {
                    rel: file.rel.clone(),
                    bytes: std::fs::read(&staged_path)?,
                });
                counts.push((file.rel.clone(), file.bytes.len() as u64));
                placements.push((live, staged_path));
            }
            readback.sort_by(|a, b| a.rel.cmp(&b.rel));
            assert_readback(
                &record.id,
                &record.plain_digest,
                &FileSet { files: readback }.encode()?,
            )?;
            Ok(Some(Staged {
                id: record.id.clone(),
                placements,
                counts,
                detail: None,
            }))
        }
        ArtifactKind::DomStorage => {
            let store = DomStore::from_artifact_id(&record.id)
                .ok_or_else(|| anyhow::anyhow!("{} is not a DOM storage artifact", record.id))?;
            let captured_backend = match record.backend.as_deref() {
                Some("sqlite") => DomBackend::Sqlite,
                Some("leveldb") => DomBackend::LevelDb,
                other => bail!(
                    "{} records DOM backend {other:?}, which this build cannot restore",
                    record.id
                ),
            };
            dom_storage::assert_backend_match(
                captured_backend,
                dom_storage::detect_backend(udd, store),
                store,
            )?;
            match captured_backend {
                DomBackend::Sqlite => {
                    let records = DomRecords::decode(&payload)?;
                    if records.store != store {
                        bail!(
                            "{} holds {:?} records but is being restored as {:?}",
                            record.id,
                            records.store,
                            store
                        );
                    }
                    let live = dom_storage::sqlite_path(udd, store);
                    let staged_path = stage.join(
                        live.file_name()
                            .ok_or_else(|| anyhow::anyhow!("DOM storage path has no file name"))?,
                    );
                    dom_storage::write_records(&staged_path, &records)?;
                    sync_path(&staged_path)?;
                    sqlite_copy::integrity_check(&staged_path)?;
                    let reread = dom_storage::read_records(&staged_path, store)?;
                    assert_readback(&record.id, &record.plain_digest, &reread.encode()?)?;
                    Ok(Some(Staged {
                        id: record.id.clone(),
                        placements: vec![(live, staged_path)],
                        counts: vec![
                            ("origins".to_string(), records.area_count()),
                            ("keys".to_string(), records.key_count()),
                        ],
                        // sessionStorage keys off the per-run SNSS namespace id, so its areas only mean
                        // anything to the machine that captured them. Restoring the file is still
                        // right — the map bytes are what a same-machine reopen needs — but promising
                        // cross-machine sessionStorage would be the silent half-session this whole
                        // design exists to avoid.
                        detail: (store == DomStore::Session).then(|| {
                            "session_metadata.session_id is a per-run SNSS namespace id; these areas \
                             resolve only on the machine that captured them"
                                .to_string()
                        }),
                    }))
                }
                DomBackend::LevelDb => {
                    let live = dom_storage::leveldb_dir(udd, store);
                    let prefix = live
                        .file_name()
                        .map(|n| n.to_string_lossy().to_string())
                        .unwrap_or_else(|| "leveldb".to_string());
                    let files = dir_tar::untar_into(&payload, &stage)?;
                    let staged_path = stage.join(&prefix);
                    if !staged_path.is_dir() {
                        bail!(
                            "{} unpacked without the expected `{prefix}` directory",
                            record.id
                        );
                    }
                    assert_readback(
                        &record.id,
                        &record.plain_digest,
                        &dir_tar::tar_dirs(&[(prefix, staged_path.clone())])?,
                    )?;
                    Ok(Some(Staged {
                        id: record.id.clone(),
                        placements: vec![(live, staged_path)],
                        counts: vec![("files".to_string(), files)],
                        detail: None,
                    }))
                }
                _ => unreachable!("captured_backend is Sqlite or LevelDb"),
            }
        }
        ArtifactKind::IndexedDb => {
            let records = IdbRecords::decode(&payload)?;
            let live = resolve_source(udd, "Default/IndexedDB")?;
            let staged_path = stage.join("IndexedDB");
            idb::write_records(&staged_path, &records)?;
            sync_path(&staged_path)?;
            let reread = idb::read_records(&staged_path, &records)?;
            assert_readback(&record.id, &record.plain_digest, &reread.encode()?)?;
            Ok(Some(Staged {
                id: record.id.clone(),
                placements: vec![(live, staged_path)],
                counts: vec![
                    ("databases".to_string(), records.database_count()),
                    ("blobDirs".to_string(), records.blob_dir_count()),
                ],
                detail: None,
            }))
        }
        ArtifactKind::DirTar => {
            let spec = manifest::spec(&record.id).ok_or_else(|| {
                anyhow::anyhow!("artifact `{}` is not in the registry", record.id)
            })?;
            let files = dir_tar::untar_into(&payload, &stage)?;
            let present = dir_tar::tar_prefixes(&payload)?;
            let mut placements = Vec::new();
            let mut roots = Vec::new();
            for source in spec.sources {
                let prefix = tar_prefix(source)?;
                if !present.contains(&prefix) {
                    continue;
                }
                let staged_path = stage.join(&prefix);
                if !staged_path.is_dir() {
                    bail!("{} unpacked without the `{prefix}` directory", record.id);
                }
                roots.push((prefix, staged_path.clone()));
                placements.push((resolve_source(udd, source)?, staged_path));
            }
            if placements.is_empty() {
                return Ok(None);
            }
            assert_readback(
                &record.id,
                &record.plain_digest,
                &dir_tar::tar_dirs(&roots)?,
            )?;
            Ok(Some(Staged {
                id: record.id.clone(),
                placements,
                counts: vec![
                    ("files".to_string(), files),
                    ("dirs".to_string(), roots.len() as u64),
                ],
                detail: None,
            }))
        }
        ArtifactKind::PrefsSubset => {
            let subset: serde_json::Value =
                serde_json::from_slice(&payload).context("prefs subset is not valid JSON")?;
            let live = resolve_source(udd, "Default/Preferences")?;
            // Merge into whatever the target already has. A target with no Preferences at all is
            // normal on a fresh user-data-dir that has not been launched yet.
            let mut merged = if live.is_file() {
                prefs::read_file(&live)?
            } else {
                serde_json::Value::Object(serde_json::Map::new())
            };
            let applied = prefs::merge(&mut merged, &subset)?;
            let staged_path = stage.join("Preferences");
            prefs::write_file_atomic(&staged_path, &merged)?;
            sync_path(&staged_path)?;
            // The read-back cannot equal the capture digest here — the staged file is a MERGE, not the
            // subset — so the check is that extracting the allowlist back out of the merged document
            // reproduces exactly what the snapshot carried.
            let reextracted = prefs::extract(&prefs::read_file(&staged_path)?)?;
            if reextracted != subset {
                bail!(
                    "PREFS_MERGE_MISMATCH: re-extracting the allowlist from the merged Preferences did \
                     not reproduce the captured subset"
                );
            }
            Ok(Some(Staged {
                id: record.id.clone(),
                placements: vec![(live, staged_path)],
                counts: vec![("keysApplied".to_string(), applied.len() as u64)],
                detail: None,
            }))
        }
    }
}

fn assert_readback(id: &str, expected_digest: &str, readback: &[u8]) -> Result<()> {
    let actual = digest_hex(readback);
    if actual != expected_digest {
        bail!(
            "READBACK_DIGEST_MISMATCH: {id} staged to disk and read back as {actual}, but the manifest \
             recorded {expected_digest}; refusing to move it into the profile"
        );
    }
    Ok(())
}

/// Park the live paths, then rename the staged ones in. Every move is journalled BEFORE the next one
/// starts, so a failure at any point can be wound back exactly.
fn swap_in(
    placements: &[(PathBuf, PathBuf)],
    pre_restore: &Path,
    udd: &Path,
    journal: &mut SwapJournal,
) -> Result<()> {
    for (live, staged) in placements {
        let relative = live.strip_prefix(udd).unwrap_or(live);
        let parked = pre_restore.join(relative);
        if let Some(parent) = parked.parent() {
            std::fs::create_dir_all(parent)?;
        }
        if live.exists() {
            if live.is_dir() {
                std::fs::rename(live, &parked).with_context(|| {
                    format!("parking {} -> {}", live.display(), parked.display())
                })?;
                journal.record(live.clone(), parked);
            } else {
                // A database's sidecars must move WITH it: a restored main file beside the previous
                // `-wal` is corruption, and SQLite would replay frames for pages the new file lacks.
                let parked_dir = parked
                    .parent()
                    .ok_or_else(|| anyhow::anyhow!("parked path has no parent"))?;
                for (from, to) in sqlite_copy::park_with_sidecars(live, parked_dir)? {
                    journal.record(from, to);
                }
            }
        }
        if let Some(parent) = live.parent() {
            std::fs::create_dir_all(parent)?;
        }
        std::fs::rename(staged, live)
            .with_context(|| format!("placing {} -> {}", staged.display(), live.display()))?;
        journal.record(staged.clone(), live.clone());
    }
    Ok(())
}

/// Delete every `.lobster-pre-restore-*` directory in `udd` except `keep`.
///
/// Best-effort by design: a parked copy that cannot be removed (a file still mapped by a running
/// browser, a permissions oddity) must not fail a restore that has already succeeded. The next
/// restore tries again.
fn prune_pre_restore_dirs(udd: &Path, keep: &Path) {
    let Ok(entries) = std::fs::read_dir(udd) else {
        return;
    };
    for entry in entries.flatten() {
        let path = entry.path();
        if path == keep || !path.is_dir() {
            continue;
        }
        let is_parked = path
            .file_name()
            .and_then(|name| name.to_str())
            .is_some_and(|name| name.starts_with(".lobster-pre-restore-"));
        if is_parked {
            if let Err(err) = std::fs::remove_dir_all(&path) {
                tracing::warn!(dir = %path.display(), %err, "could not prune parked restore copy");
            }
        }
    }
}

fn write_and_sync(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let mut file =
        std::fs::File::create(path).with_context(|| format!("creating {}", path.display()))?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(())
}

/// fsync a staged file, or the files directly inside a staged directory.
///
/// Best-effort on directories: the point is that a crash between the verify and the rename cannot
/// leave a staged artifact whose bytes are still only in the page cache, so a subsequent rollback has
/// something real to work with.
fn sync_path(path: &Path) -> Result<()> {
    if path.is_file() {
        let file = std::fs::File::open(path)?;
        file.sync_all()?;
        return Ok(());
    }
    if path.is_dir() {
        for entry in std::fs::read_dir(path)? {
            sync_path(&entry?.path())?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;

    fn temp_root(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("lobster-snapshot-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn vault_at(root: &Path) -> SnapshotVault {
        SnapshotVault::with_key(&root.join("snapshots"), &[42u8; 32]).unwrap()
    }

    /// A user-data-dir shaped like the real ones: SQLite DOM storage in WAL mode, a v24 cookie jar
    /// with `journal_mode=delete`, Login Data, Web Data, an IndexedDB origin, two LevelDB extension
    /// stores, both Sessions directories, a 40 KB-shaped Preferences, and NO Bookmarks.
    fn build_profile(udd: &Path, cookie_value: &str, ls_token: &str) {
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
                     encrypted_value BLOB, has_cross_site_ancestor INTEGER NOT NULL);
                 CREATE UNIQUE INDEX cookies_unique_index ON cookies(host_key, top_frame_site_key, name);",
            )
            .unwrap();
        cookies
            .execute(
                "INSERT INTO cookies VALUES(13429403387583785,'1procard.com','','authToken',?1,NULL,0)",
                [cookie_value],
            )
            .unwrap();
        // The real partitioned row observed on disk: api.hcaptcha.com/hmt_id under 1procard.com.
        cookies
            .execute(
                "INSERT INTO cookies VALUES(13429403387583786,'api.hcaptcha.com','https://1procard.com','hmt_id','partitioned',NULL,1)",
                [],
            )
            .unwrap();
        drop(cookies);

        for (name, table) in [("Login Data", "logins"), ("Web Data", "credit_cards")] {
            let conn = Connection::open(default.join(name)).unwrap();
            conn.execute_batch(&format!(
                "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
                 INSERT INTO meta VALUES('version','43'),('last_compatible_version','40');
                 CREATE TABLE {table}(id INTEGER PRIMARY KEY, blob BLOB);
                 INSERT INTO {table} VALUES(1, x'deadbeef');"
            ))
            .unwrap();
        }

        // WAL-mode DOM storage with the content left unmerged in the -wal: the prf_6d04dd17 shape.
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
                b"\x011procard_device_session_v1".to_vec(),
                format!("\u{1}{ls_token}").into_bytes()
            ],
        )
        .unwrap();
        drop(ls);

        let ss = Connection::open(default.join("SessionStorage")).unwrap();
        ss.pragma_update(None, "journal_mode", "WAL").unwrap();
        ss.execute_batch(
            "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
             INSERT INTO meta VALUES('mmap_status','-1'),('version','1'),('last_compatible_version','1');
             CREATE TABLE session_metadata(session_id TEXT NOT NULL, storage_key BLOB NOT NULL,\
                 map_id INTEGER NOT NULL, PRIMARY KEY(session_id, storage_key)) WITHOUT ROWID;
             CREATE TABLE map_entries(map_id INTEGER NOT NULL, value_compression_type INTEGER NOT NULL,\
                 key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(map_id, key)) WITHOUT ROWID;
             INSERT INTO session_metadata VALUES('1', x'68747470733a2f2f3170726f636172642e636f6d2f', 3);
             INSERT INTO map_entries VALUES(3, 0, x'0174', x'0176');",
        )
        .unwrap();
        drop(ss);

        let idb = default.join("IndexedDB").join("https_www.payoneer.com_0");
        std::fs::create_dir_all(&idb).unwrap();
        let db = Connection::open(idb.join("ZU2QUWW27DDP5GWUEU2FLLH4Z5EF65VZSSLF3UKXV54PCLPHHRVA"))
            .unwrap();
        db.pragma_update(None, "journal_mode", "WAL").unwrap();
        db.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        db.execute_batch(
            "CREATE TABLE object_data(id INTEGER PRIMARY KEY, value BLOB NOT NULL);
             INSERT INTO object_data VALUES(1, x'6964622d61757468');",
        )
        .unwrap();
        drop(db);

        for id in [
            "dilfmeocbnifnkedfcioghohbppbkkje",
            "opbicdcjjlpehmibpmkmkconpnnkijel",
        ] {
            let dir = default.join("Local Extension Settings").join(id);
            std::fs::create_dir_all(&dir).unwrap();
            std::fs::write(dir.join("000003.log"), format!("state for {id}")).unwrap();
            std::fs::write(dir.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
            std::fs::write(dir.join("LOCK"), b"").unwrap();
            std::fs::write(dir.join("LOG"), b"noisy").unwrap();
        }
        let ext_state = default.join("Extension State");
        std::fs::create_dir_all(&ext_state).unwrap();
        std::fs::write(ext_state.join("000003.log"), b"ext state").unwrap();

        for (dir, name, body) in [
            ("Sessions", "Session_13430898126032860", "snss"),
            (
                "Sessions_Encrypted",
                "Session_13430898126033555",
                "snss-enc",
            ),
        ] {
            let d = default.join(dir);
            std::fs::create_dir_all(&d).unwrap();
            std::fs::write(d.join(name), body).unwrap();
        }

        let history = Connection::open(default.join("History")).unwrap();
        history.pragma_update(None, "journal_mode", "WAL").unwrap();
        history
            .execute_batch(
                "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
                 INSERT INTO meta VALUES('version','70'),('last_compatible_version','16');
                 CREATE TABLE urls(id INTEGER PRIMARY KEY, url TEXT);
                 INSERT INTO urls VALUES(1,'https://1procard.com/');",
            )
            .unwrap();
        drop(history);

        prefs::write_file_atomic(
            &default.join("Preferences"),
            &serde_json::json!({
                "profile": {
                    "name": "persona",
                    "content_settings": { "exceptions": {
                        "site_engagement": { "https://1procard.com,*": { "setting": 7 } }
                    }}
                },
                "intl": { "accept_languages": "en-US,en" },
                "session": { "restore_on_startup": 1 },
                "extensions": { "settings": { "opbicdcjjlpehmibpmkmkconpnnkijel": { "state": 1 } } }
            }),
        )
        .unwrap();
    }

    fn read_cookie(udd: &Path) -> String {
        let conn = Connection::open(udd.join("Default").join("Cookies")).unwrap();
        conn.query_row(
            "SELECT value FROM cookies WHERE name='authToken'",
            [],
            |r| r.get(0),
        )
        .unwrap()
    }

    fn read_local_storage_token(udd: &Path) -> Vec<u8> {
        let conn = Connection::open(udd.join("Default").join("LocalStorage")).unwrap();
        conn.query_row("SELECT value FROM map_entries WHERE map_id=1", [], |r| {
            r.get(0)
        })
        .unwrap()
    }

    #[test]
    fn capture_then_wipe_then_restore_recovers_every_artifact() {
        let root = temp_root("roundtrip");
        let udd = root.join("prf_test");
        build_profile(&udd, "live-session-token", "ls-token-1");
        let vault = vault_at(&root);

        let manifest = capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap();
        assert_eq!(manifest.version, 1);
        assert_eq!(manifest.coherence.label, "quiesced");
        for expected in [
            "cookies",
            "localstorage",
            "sessionstorage",
            "indexeddb",
            "passwords",
            "autofill",
            "history",
            "extension-state",
            "sessions",
            "prefs-subset",
        ] {
            assert!(
                manifest.artifact(expected).is_some(),
                "{expected} missing from {:?}",
                manifest.artifacts.iter().map(|a| &a.id).collect::<Vec<_>>()
            );
        }
        // Bookmarks is absent in 0/9 real profiles; that must be recorded, not treated as an error.
        assert_eq!(manifest.absent, vec!["bookmarks".to_string()]);
        assert!(verify(&vault, "prf_test", 1).unwrap().ok);

        // Wipe the user-data-dir the way a reinstall or a corrupt-profile purge would.
        std::fs::remove_dir_all(&udd).unwrap();
        let report = restore(&vault, &udd, "prf_test", 1).unwrap();
        assert!(report.ok, "{:?}", report.failure);
        assert!(!report.rolled_back);

        assert_eq!(read_cookie(&udd), "live-session-token");
        assert_eq!(read_local_storage_token(&udd), b"\x01ls-token-1".to_vec());
        // The partitioned cookie is the one a CDP-only capture would have destroyed.
        let conn = Connection::open(udd.join("Default").join("Cookies")).unwrap();
        let ancestor: i64 = conn
            .query_row(
                "SELECT has_cross_site_ancestor FROM cookies WHERE name='hmt_id'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(ancestor, 1);
        drop(conn);

        let idb_value: Vec<u8> = Connection::open(
            udd.join("Default")
                .join("IndexedDB")
                .join("https_www.payoneer.com_0")
                .join("ZU2QUWW27DDP5GWUEU2FLLH4Z5EF65VZSSLF3UKXV54PCLPHHRVA"),
        )
        .unwrap()
        .query_row("SELECT value FROM object_data WHERE id=1", [], |r| r.get(0))
        .unwrap();
        assert_eq!(idb_value, b"idb-auth".to_vec());

        assert_eq!(
            std::fs::read_to_string(
                udd.join("Default")
                    .join("Local Extension Settings")
                    .join("opbicdcjjlpehmibpmkmkconpnnkijel")
                    .join("000003.log")
            )
            .unwrap(),
            "state for opbicdcjjlpehmibpmkmkconpnnkijel"
        );
        assert!(!udd
            .join("Default")
            .join("Local Extension Settings")
            .join("opbicdcjjlpehmibpmkmkconpnnkijel")
            .join("LOG")
            .exists());
        // Both session directories, or the restore is empty windows that report success.
        assert!(udd
            .join("Default")
            .join("Sessions")
            .join("Session_13430898126032860")
            .exists());
        assert!(udd
            .join("Default")
            .join("Sessions_Encrypted")
            .join("Session_13430898126033555")
            .exists());

        let restored_prefs = prefs::read_file(&udd.join("Default").join("Preferences")).unwrap();
        assert_eq!(
            restored_prefs["profile"]["content_settings"]["exceptions"]["site_engagement"]
                ["https://1procard.com,*"]["setting"],
            serde_json::json!(7)
        );
        // The tracked keys the snapshot deliberately does not carry must not appear either.
        assert!(restored_prefs.get("session").is_none());
        assert!(restored_prefs.get("extensions").is_none());

        std::fs::remove_dir_all(root).unwrap();
    }

    /// The one test that matters most for safety: a staged artifact that fails verification must leave
    /// the profile EXACTLY as it was, including the artifacts that had already been swapped in.
    #[test]
    fn a_corrupted_artifact_rolls_the_whole_restore_back() {
        let root = temp_root("rollback");
        let udd = root.join("prf_test");
        build_profile(&udd, "original-token", "ls-original");
        let vault = vault_at(&root);
        capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap();

        // The profile then moves on: newer cookie, newer localStorage.
        std::fs::remove_dir_all(&udd).unwrap();
        build_profile(&udd, "current-token", "ls-current");
        let before: Vec<(PathBuf, Vec<u8>)> = walk_files(&udd);

        // Corrupt one artifact's SEALED blob in the ledger. `passwords` is the fifth artifact the
        // registry visits, so four have already staged successfully when it fails — the failure has to
        // discard their staged copies too, not just its own.
        let blob = vault
            .root()
            .join("prf_test")
            .join("1")
            .join("passwords.lba");
        let mut bytes = std::fs::read(&blob).unwrap();
        let last = bytes.len() - 1;
        bytes[last] ^= 0xff;
        std::fs::write(&blob, &bytes).unwrap();

        let report = restore(&vault, &udd, "prf_test", 1).unwrap();
        assert!(!report.ok, "a corrupted artifact must not report success");
        assert!(report.failure.unwrap().contains("passwords"));

        // Every byte back where it was, and nothing of the snapshot applied.
        assert_eq!(read_cookie(&udd), "current-token");
        assert_eq!(read_local_storage_token(&udd), b"\x01ls-current".to_vec());
        let after = walk_files(&udd);
        assert_eq!(
            before, after,
            "the user-data-dir must be byte-identical after a failed restore"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The same guarantee for a failure during the SWAP — the phase where live files have already been
    /// moved out of the way — exercised directly against `swap_in` and `SwapJournal::rewind`.
    ///
    /// Driven at this level deliberately. Forcing a mid-restore filesystem failure end-to-end means
    /// relying on a platform quirk (a rename that fails for a reason the OS will keep honouring),
    /// which makes the test about the filesystem instead of about the rollback. The contract under test
    /// is "every move is journalled and every journalled move can be wound back", and that is exactly
    /// what this asserts, including the `-wal` sidecar travelling with its database.
    #[test]
    fn pruning_keeps_the_newest_parked_copy_and_removes_the_rest() {
        let udd = temp_root("prune");
        let keep = udd.join(".lobster-pre-restore-20260817T130000.000");
        let old_a = udd.join(".lobster-pre-restore-20260810T090000.000");
        let old_b = udd.join(".lobster-pre-restore-20260801T090000.000");
        // A real directory that merely lives alongside them must survive untouched.
        let unrelated = udd.join("Default");
        for dir in [&keep, &old_a, &old_b, &unrelated] {
            std::fs::create_dir_all(dir).unwrap();
            std::fs::write(dir.join("Login Data"), b"parked").unwrap();
        }

        prune_pre_restore_dirs(&udd, &keep);

        assert!(keep.exists(), "the undo for the last restore is kept");
        assert!(!old_a.exists(), "older parked copies are pruned");
        assert!(!old_b.exists());
        assert!(
            unrelated.join("Login Data").exists(),
            "only .lobster-pre-restore-* dirs are eligible"
        );
    }

    #[test]
    fn a_failure_during_the_swap_puts_every_parked_file_back() {
        let root = temp_root("swapfail");
        let udd = root.join("prf_test");
        let default = udd.join("Default");
        std::fs::create_dir_all(&default).unwrap();

        // Live state: a database with an unmerged -wal, and a directory.
        let live_db = default.join("Cookies");
        std::fs::write(&live_db, b"live cookies").unwrap();
        std::fs::write(default.join("Cookies-wal"), b"live cookies wal").unwrap();
        let live_dir = default.join("Sessions");
        std::fs::create_dir_all(&live_dir).unwrap();
        std::fs::write(live_dir.join("Session_1"), b"live session").unwrap();
        let before = walk_files(&udd);

        // Staged replacements for both, plus a third placement whose staged path does not exist — the
        // stand-in for any failure that strikes after some artifacts have already been swapped.
        let stage = root.join("stage");
        std::fs::create_dir_all(&stage).unwrap();
        let staged_db = stage.join("Cookies");
        std::fs::write(&staged_db, b"restored cookies").unwrap();
        let staged_dir = stage.join("Sessions");
        std::fs::create_dir_all(&staged_dir).unwrap();
        std::fs::write(staged_dir.join("Session_2"), b"restored session").unwrap();

        let pre_restore = udd.join(".lobster-pre-restore-test");
        let mut journal = SwapJournal { moves: Vec::new() };
        swap_in(
            &[(live_db.clone(), staged_db)],
            &pre_restore,
            &udd,
            &mut journal,
        )
        .unwrap();
        swap_in(
            &[(live_dir.clone(), staged_dir)],
            &pre_restore,
            &udd,
            &mut journal,
        )
        .unwrap();
        assert_eq!(std::fs::read(&live_db).unwrap(), b"restored cookies");
        assert!(live_dir.join("Session_2").exists());

        let err = swap_in(
            &[(default.join("History"), stage.join("does-not-exist"))],
            &pre_restore,
            &udd,
            &mut journal,
        )
        .unwrap_err();
        assert!(format!("{err:#}").contains("placing"), "{err:#}");

        assert!(journal.rewind().is_empty(), "rollback reported problems");
        std::fs::remove_dir_all(&pre_restore).unwrap();
        assert_eq!(
            before,
            walk_files(&udd),
            "the user-data-dir must be byte-identical after a rolled-back swap"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A DOM store on the other backend must fail with a named error rather than land a payload the
    /// engine will never read.
    #[test]
    fn restoring_across_dom_backends_is_refused() {
        let root = temp_root("crossbackend");
        let udd = root.join("prf_test");
        build_profile(&udd, "t", "ls");
        let vault = vault_at(&root);
        capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap();

        // The target is a LevelDB-layout profile: no `Default/LocalStorage`, a populated
        // `Default/Local Storage/leveldb/`.
        let target = root.join("prf_leveldb");
        std::fs::create_dir_all(target.join("Default")).unwrap();
        let leveldb = target.join("Default").join("Local Storage").join("leveldb");
        std::fs::create_dir_all(&leveldb).unwrap();
        std::fs::write(leveldb.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        assert_eq!(
            dom_storage::detect_backend(&target, DomStore::Local),
            DomBackend::LevelDb
        );

        let report = restore(&vault, &target, "prf_test", 1).unwrap();
        assert!(!report.ok);
        let failure = report.failure.unwrap();
        assert!(failure.contains("DOM_BACKEND_MISMATCH"), "{failure}");
        // Nothing landed: the LevelDB store is untouched and no SQLite file appeared beside it.
        assert!(leveldb.join("CURRENT").exists());
        assert!(!target.join("Default").join("LocalStorage").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A LevelDB-layout profile must capture through the tar codec, and restore back into a LevelDB
    /// profile — the other half of the coexistence requirement.
    #[test]
    fn a_leveldb_dom_profile_captures_and_restores_through_the_tar_codec() {
        let root = temp_root("leveldb");
        let udd = root.join("prf_leveldb");
        let leveldb = udd.join("Default").join("Local Storage").join("leveldb");
        std::fs::create_dir_all(&leveldb).unwrap();
        std::fs::write(leveldb.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        std::fs::write(leveldb.join("000003.log"), b"leveldb localstorage token").unwrap();
        std::fs::write(leveldb.join("LOCK"), b"").unwrap();

        let vault = vault_at(&root);
        let manifest = capture(
            &vault,
            &udd,
            "prf_leveldb",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap();
        let record = manifest.artifact("localstorage").unwrap();
        assert_eq!(record.backend.as_deref(), Some("leveldb"));
        assert_eq!(record.kind, ArtifactKind::DomStorage);
        assert_eq!(record.fidelity, Fidelity::Opaque);

        std::fs::remove_dir_all(udd.join("Default").join("Local Storage")).unwrap();
        let report = restore(&vault, &udd, "prf_leveldb", 1).unwrap();
        assert!(report.ok, "{:?}", report.failure);
        assert_eq!(
            std::fs::read(leveldb.join("000003.log")).unwrap(),
            b"leveldb localstorage token"
        );
        assert!(
            !leveldb.join("LOCK").exists(),
            "the live lock must not travel"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_quiesced_capture_refuses_to_lie_about_a_running_browser() {
        let root = temp_root("running");
        let udd = root.join("prf_test");
        build_profile(&udd, "t", "ls");
        std::os::unix::fs::symlink(
            format!("thishost-{}", std::process::id()),
            udd.join("SingletonLock"),
        )
        .unwrap();
        let vault = vault_at(&root);

        let err = capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap_err()
        .to_string();
        assert!(err.contains("PROFILE_IS_RUNNING"), "{err}");

        // Dirty mode is the escape hatch that makes an unlaunchable or busy profile recoverable.
        let manifest = capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Dirty,
            &CaptureOptions::default(),
        )
        .unwrap();
        assert_eq!(manifest.coherence.label, "dirty");
        assert!(manifest.artifact("cookies").is_some());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// LevelDB artifacts are unsafe to read beside a live browser, so a Live capture carries the last
    /// good copy forward by reference rather than dropping it.
    #[test]
    fn live_mode_carries_leveldb_artifacts_forward_as_stale() {
        let root = temp_root("live");
        let udd = root.join("prf_test");
        build_profile(&udd, "t1", "ls1");
        let vault = vault_at(&root);
        capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap();

        let v2 = capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Live,
            &CaptureOptions::default(),
        )
        .unwrap();
        let ext = v2.artifact("extension-state").unwrap();
        assert_eq!(ext.fidelity, Fidelity::Stale);
        assert_eq!(
            ext.captured_in_version, 1,
            "the bytes still live in version 1"
        );
        assert!(v2
            .skipped
            .iter()
            .any(|(id, why)| id == "extension-state" && why.contains("carried forward")));
        // And the carried-forward reference still resolves, both to verify and to restore.
        assert!(verify(&vault, "prf_test", 2).unwrap().ok);
        std::fs::remove_dir_all(&udd).unwrap();
        let report = restore(&vault, &udd, "prf_test", 2).unwrap();
        assert!(report.ok, "{:?}", report.failure);
        assert!(udd
            .join("Default")
            .join("Extension State")
            .join("000003.log")
            .exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The WAL trap, end to end through capture and restore rather than only at the copy layer.
    #[test]
    fn capture_of_a_stub_main_file_with_a_large_wal_yields_the_wal_contents() {
        let root = temp_root("waltrap");
        let udd = root.join("prf_test");
        let default = udd.join("Default");
        std::fs::create_dir_all(&default).unwrap();

        // Exactly the prf_6d04dd17 shape: everything, including the schema, is in the -wal.
        let path = default.join("LocalStorage");
        let conn = Connection::open(&path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
             INSERT INTO meta VALUES('version','1'),('last_compatible_version','1'),('mmap_status','-1');
             CREATE TABLE maps(row_id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key BLOB NOT NULL,\
                 last_accessed INTEGER, last_modified INTEGER, total_size INTEGER);
             CREATE UNIQUE INDEX maps_by_storage_key ON maps(storage_key);
             CREATE TABLE map_entries(map_id INTEGER NOT NULL, value_compression_type INTEGER NOT NULL,\
                 key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(map_id, key)) WITHOUT ROWID;
             INSERT INTO maps(row_id, storage_key, last_accessed, last_modified, total_size)\
                 VALUES(1, x'6b', 1, 1, 1);
             INSERT INTO map_entries VALUES(1, 0, x'01746f6b656e', x'0177616c2d6f6e6c79');",
        )
        .unwrap();
        // A second handle keeps the `-wal` unmerged: SQLite checkpoints when the LAST connection
        // closes, so a fixture that just drops its writer merges the WAL away and stops reproducing the
        // bug. The real profiles hold an unmerged `-wal` because the process owning it was killed.
        let keep_alive = Connection::open(&path).unwrap();
        keep_alive
            .query_row("SELECT count(*) FROM map_entries", [], |r| {
                r.get::<_, i64>(0)
            })
            .unwrap();
        drop(conn);

        let main_len = std::fs::metadata(&path).unwrap().len();
        let wal_len = std::fs::metadata(default.join("LocalStorage-wal"))
            .unwrap()
            .len();
        assert!(
            wal_len > main_len,
            "fixture must reproduce the trap: main={main_len} wal={wal_len}"
        );
        // Proof the trap is live: the main file alone has no tables at all.
        let bare = Connection::open_with_flags(
            format!("file:{}?immutable=1", path.display()),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
        )
        .unwrap();
        let tables: i64 = bare
            .query_row("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
            .unwrap();
        assert_eq!(tables, 0, "the fixture is not exercising the WAL trap");
        drop(bare);

        let vault = vault_at(&root);
        capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap();
        drop(keep_alive);
        std::fs::remove_dir_all(&udd).unwrap();
        let report = restore(&vault, &udd, "prf_test", 1).unwrap();
        assert!(report.ok, "{:?}", report.failure);
        assert_eq!(read_local_storage_token(&udd), b"\x01wal-only".to_vec());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn verify_names_the_artifact_a_bit_flip_broke() {
        let root = temp_root("verify");
        let udd = root.join("prf_test");
        build_profile(&udd, "t", "ls");
        let vault = vault_at(&root);
        capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .unwrap();
        assert!(verify(&vault, "prf_test", 1).unwrap().ok);

        let blob = vault.root().join("prf_test").join("1").join("cookies.lba");
        let mut bytes = std::fs::read(&blob).unwrap();
        bytes[30] ^= 0x01;
        std::fs::write(&blob, bytes).unwrap();

        let report = verify(&vault, "prf_test", 1).unwrap();
        assert!(!report.ok);
        let cookies = report.artifacts.iter().find(|a| a.id == "cookies").unwrap();
        assert!(!cookies.ok);
        assert!(cookies
            .detail
            .as_ref()
            .unwrap()
            .contains("SEALED_DIGEST_MISMATCH"));
        assert!(
            report.artifacts.iter().filter(|a| a.ok).count() > 1,
            "the others must still verify"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn excluded_artifacts_are_recorded_rather_than_silently_missing() {
        let root = temp_root("exclude");
        let udd = root.join("prf_test");
        build_profile(&udd, "t", "ls");
        let vault = vault_at(&root);
        let manifest = capture(
            &vault,
            &udd,
            "prf_test",
            CaptureMode::Quiesced,
            &CaptureOptions {
                exclude: vec!["history".into(), "sessionstorage".into()],
            },
        )
        .unwrap();
        assert!(manifest.artifact("history").is_none());
        assert!(manifest.artifact("sessionstorage").is_none());
        assert_eq!(
            manifest
                .skipped
                .iter()
                .filter(|(_, why)| why.contains("excluded by capture options"))
                .count(),
            2
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Round-trip a REAL profile directory, gated on `LOBSTER_SNAPSHOT_REAL_PROFILE`.
    ///
    /// The synthetic fixtures above are built to the shapes verified on disk, but a fixture can only
    /// ever contain what its author thought to put in it. This test points the engine at an actual
    /// Lobium user-data-dir: it copies it (the source is NEVER opened for writing), captures, deletes
    /// the copy outright, restores into an empty directory, and asserts every captured artifact comes
    /// back byte-for-byte through the capture codec.
    ///
    /// Skipped when the variable is unset, because no CI runner has a real profile — the equivalent
    /// coverage there is the launch-based round trip in `ci/validation/`.
    #[test]
    fn a_real_profile_directory_round_trips() {
        let Ok(source) = std::env::var("LOBSTER_SNAPSHOT_REAL_PROFILE") else {
            eprintln!(
                "skipping: set LOBSTER_SNAPSHOT_REAL_PROFILE=<path to a profile user-data-dir>"
            );
            return;
        };
        let source = PathBuf::from(source);
        assert!(source.is_dir(), "{} is not a directory", source.display());

        let root = temp_root("real");
        let udd = root.join("prf_real");
        copy_tree(&source, &udd);
        let vault = vault_at(&root);

        // Prefer Quiesced so the LevelDB-backed artifacts (`extension-state`, `sessions`) are exercised
        // on real bytes too; `copy_tree` skips the `SingletonLock` symlink, so the copy has no owner to
        // find. Fall back to Dirty rather than skipping, since a capture of an unclean directory is the
        // mode that matters most.
        let manifest = capture(
            &vault,
            &udd,
            "prf_real",
            CaptureMode::Quiesced,
            &CaptureOptions::default(),
        )
        .or_else(|err| {
            eprintln!("quiesced capture refused ({err:#}); falling back to dirty");
            capture(
                &vault,
                &udd,
                "prf_real",
                CaptureMode::Dirty,
                &CaptureOptions::default(),
            )
        })
        .unwrap();
        eprintln!(
            "captured {} artifacts, {} sealed bytes, coherence {} ({} ms)",
            manifest.artifacts.len(),
            manifest
                .artifacts
                .iter()
                .map(|a| a.sealed_bytes)
                .sum::<u64>(),
            manifest.coherence.label,
            manifest.coherence.window_ms
        );
        for a in &manifest.artifacts {
            eprintln!(
                "  {:<16} kind={:?} fidelity={:?} backend={:?} plain={} sealed={} counts={:?}",
                a.id, a.kind, a.fidelity, a.backend, a.plain_bytes, a.sealed_bytes, a.counts
            );
        }
        for id in &manifest.absent {
            eprintln!("  absent: {id}");
        }
        for (id, why) in &manifest.skipped {
            eprintln!("  skipped: {id} — {why}");
        }
        assert!(verify(&vault, "prf_real", 1).unwrap().ok);

        // A DOM-storage payload always carries the three `meta` rows when the store has been
        // initialised. `prf_6d04dd17` holds those rows ONLY in its `-wal`, so an empty `meta` here would
        // mean the WAL was silently skipped — the exact failure this engine exists to prevent.
        if let Some(record) = manifest.artifact("localstorage") {
            let payload = vault
                .get_artifact(
                    "prf_real",
                    record.captured_in_version,
                    &record.id,
                    &record.sealed_digest,
                )
                .unwrap();
            if record.backend.as_deref() == Some("sqlite") {
                let records = DomRecords::decode(&payload).unwrap();
                assert!(
                    records.meta.iter().any(|(k, _)| k == "version"),
                    "localstorage captured no meta.version — the -wal was not read"
                );
                eprintln!(
                    "  localstorage meta={:?} origins={} keys={}",
                    records.meta,
                    records.area_count(),
                    records.key_count()
                );
            }
        }

        // Destroy the copy the way a corrupt-profile purge or a fresh machine would, then restore into
        // an empty directory.
        std::fs::remove_dir_all(&udd).unwrap();
        let report = restore(&vault, &udd, "prf_real", 1).unwrap();
        assert!(report.ok, "{:?}", report.failure);

        // The byte-level equivalence claim, made against the LIVE paths after the swap rather than the
        // staged copies the restore already checked. Note what it cannot be: a second capture does NOT
        // reproduce the first capture's digests, because `VACUUM INTO` advances the schema cookie by one
        // each time (see `sqlite_copy::vacuum_into`). Reading the restored artifacts back through the
        // capture codec is the claim that is actually true and actually matters.
        for record in &manifest.artifacts {
            let payload = vault
                .get_artifact(
                    "prf_real",
                    record.captured_in_version,
                    &record.id,
                    &record.sealed_digest,
                )
                .unwrap();
            let live = live_readback(&udd, record, &payload);
            assert_eq!(
                digest_hex(&live),
                record.plain_digest,
                "{} did not read back byte-for-byte from the restored profile",
                record.id
            );
        }
        // And for the artifacts that are carried as whole files, assert plain byte equality of the file
        // on disk against the bytes the ledger holds — no codec in the middle at all.
        let mut files_compared = 0;
        for record in manifest
            .artifacts
            .iter()
            .filter(|a| matches!(a.kind, ArtifactKind::SqliteVacuum | ArtifactKind::RawJson))
        {
            let payload = vault
                .get_artifact(
                    "prf_real",
                    record.captured_in_version,
                    &record.id,
                    &record.sealed_digest,
                )
                .unwrap();
            for file in FileSet::decode(&payload).unwrap().files {
                let on_disk = std::fs::read(resolve_source(&udd, &file.rel).unwrap()).unwrap();
                assert_eq!(
                    on_disk, file.bytes,
                    "{} is not byte-identical to the captured payload",
                    file.rel
                );
                files_compared += 1;
            }
        }
        assert!(files_compared >= 4, "expected several whole-file artifacts");
        eprintln!("byte-compared {files_compared} whole files against the ledger");
        std::fs::remove_dir_all(root).unwrap();
    }

    /// Re-read one restored artifact from the LIVE user-data-dir through the same codec the capture
    /// used, so the result is directly comparable to `plain_digest`.
    fn live_readback(udd: &Path, record: &ArtifactRecord, payload: &[u8]) -> Vec<u8> {
        match record.kind {
            ArtifactKind::SqliteVacuum | ArtifactKind::RawJson => {
                let mut files: Vec<FileEntry> = FileSet::decode(payload)
                    .unwrap()
                    .files
                    .into_iter()
                    .map(|f| FileEntry {
                        bytes: std::fs::read(resolve_source(udd, &f.rel).unwrap()).unwrap(),
                        rel: f.rel,
                    })
                    .collect();
                files.sort_by(|a, b| a.rel.cmp(&b.rel));
                FileSet { files }.encode().unwrap()
            }
            ArtifactKind::DomStorage => {
                let store = DomStore::from_artifact_id(&record.id).unwrap();
                match record.backend.as_deref() {
                    Some("sqlite") => {
                        dom_storage::read_records(&dom_storage::sqlite_path(udd, store), store)
                            .unwrap()
                            .encode()
                            .unwrap()
                    }
                    Some("leveldb") => {
                        let dir = dom_storage::leveldb_dir(udd, store);
                        let prefix = dir.file_name().unwrap().to_string_lossy().to_string();
                        dir_tar::tar_dirs(&[(prefix, dir)]).unwrap()
                    }
                    other => panic!("unexpected DOM backend {other:?}"),
                }
            }
            ArtifactKind::IndexedDb => {
                let expected = IdbRecords::decode(payload).unwrap();
                idb::read_records(
                    &resolve_source(udd, "Default/IndexedDB").unwrap(),
                    &expected,
                )
                .unwrap()
                .encode()
                .unwrap()
            }
            ArtifactKind::DirTar => {
                let spec = manifest::spec(&record.id).unwrap();
                let roots: Vec<(String, PathBuf)> = spec
                    .sources
                    .iter()
                    .map(|src| (tar_prefix(src).unwrap(), resolve_source(udd, src).unwrap()))
                    .filter(|(_, path)| path.is_dir())
                    .collect();
                dir_tar::tar_dirs(&roots).unwrap()
            }
            ArtifactKind::PrefsSubset => serde_json::to_vec(
                &prefs::extract(
                    &prefs::read_file(&resolve_source(udd, "Default/Preferences").unwrap())
                        .unwrap(),
                )
                .unwrap(),
            )
            .unwrap(),
        }
    }

    /// Plain recursive copy, skipping symlinks. Used only by the real-profile test; the font pack is
    /// 119 MB of hardlinks with absolute host paths, so a copy that followed links would inflate it.
    fn copy_tree(from: &Path, to: &Path) {
        std::fs::create_dir_all(to).unwrap();
        for entry in std::fs::read_dir(from).unwrap().flatten() {
            let src = entry.path();
            let dst = to.join(entry.file_name());
            let meta = std::fs::symlink_metadata(&src).unwrap();
            if meta.file_type().is_symlink() {
                continue;
            }
            if meta.is_dir() {
                copy_tree(&src, &dst);
            } else if meta.is_file() {
                std::fs::copy(&src, &dst).unwrap();
            }
        }
    }

    /// Every file under `dir`, sorted, with its bytes. Used to assert a failed restore is a no-op.
    fn walk_files(dir: &Path) -> Vec<(PathBuf, Vec<u8>)> {
        let mut out = Vec::new();
        let mut stack = vec![dir.to_path_buf()];
        while let Some(current) = stack.pop() {
            let Ok(entries) = std::fs::read_dir(&current) else {
                continue;
            };
            for entry in entries.flatten() {
                let path = entry.path();
                // The pre-restore parking directory is expected to differ; it is the evidence, not the
                // state under test.
                if path
                    .file_name()
                    .map(|n| n.to_string_lossy().starts_with(".lobster-"))
                    .unwrap_or(false)
                {
                    continue;
                }
                if path.is_dir() {
                    stack.push(path);
                } else if let Ok(bytes) = std::fs::read(&path) {
                    out.push((path, bytes));
                }
            }
        }
        out.sort();
        out
    }
}
