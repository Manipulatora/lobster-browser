//! The artifact registry and the snapshot manifest.
//!
//! The sync unit is an ENUMERATED allowlist, never the user-data-dir and never a denylist. Measured
//! on this machine, a real profile is 0.55–6.44 MB of identity inside 0.96–4.48 GB on disk, and the
//! multi-gigabyte component payloads (`OptGuideOnDeviceModel/weights.bin`, `SODA*`,
//! `component_crx_cache`) are SIBLINGS of the genuine profile state, so no prefix rule can separate
//! them. A denylist of ~40 root names silently re-inflates the moment Chromium adds one; an
//! allowlist cannot, because nothing enumerates the new path.
//!
//! The allowlist's own failure mode is the opposite and is accepted knowingly: a Chromium release
//! that MOVES an artifact makes us capture nothing from it without erroring — which is exactly what
//! 152 did to DOM storage. [`crate::snapshot::dom_storage`] answers that one by probing instead of
//! assuming, and Phase 1's path-drift detector is the general mechanism.
//!
//! Every artifact carries a BLAKE3 digest of its PLAINTEXT and of the SEALED blob. Chromium has no
//! cross-store transaction, so the manifest also records the wall-clock window the capture spanned:
//! a cookie and the localStorage token that authenticates it, captured 30 s apart, are a half
//! session a site can read as a hijack signal. Recording the window makes that legible instead of
//! implied.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

/// Manifest schema version. Bumped when the on-disk layout or artifact encoding changes in a way an
/// older build could misread; [`SnapshotManifest::decode`] refuses anything newer than it knows.
pub const MANIFEST_VERSION: u32 = 1;

/// How an artifact's bytes are produced and applied. The kind, not the path, decides the codec —
/// which is why a LevelDB DOM store and a SQLite one can share the artifact id `localstorage`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ArtifactKind {
    /// One SQLite database copied with `VACUUM INTO`. Never a bare file copy: a WAL-mode database's
    /// most recent (sometimes ALL of its) content lives in the `-wal`, proven on disk by
    /// `prf_6d04dd17`, whose `LocalStorage` main file is 4096 B against 28872 B of `-wal` and holds
    /// not one table without it.
    SqliteVacuum,
    /// DOM storage, backend probed per profile directory. Both backends exist in the field.
    DomStorage,
    /// `IndexedDB/<origin>/<Base32>` — SQLite per file in Lobium 152, plus `*.indexeddb.blob/`
    /// directories tarred alongside.
    IndexedDb,
    /// Whole directories captured as a tar: LevelDB stores and the two SNSS session directories.
    /// Opaque — "verified" here means byte-identical to what we captured, which is weaker than the
    /// read-back-through-the-codec guarantee the structured artifacts get.
    DirTar,
    /// A JSON file copied verbatim.
    RawJson,
    /// `Preferences`, filtered to an allowlist of UNTRACKED keys and merged (never overwritten) on
    /// restore.
    PrefsSubset,
}

/// One entry in the registry: what to read, how, and whether its absence is normal.
#[derive(Debug, Clone, Copy)]
pub struct ArtifactSpec {
    pub id: &'static str,
    /// Paths relative to the profile's user-data-dir. Several sources under ONE id when they must
    /// travel together — `Sessions` without `Sessions_Encrypted` restores to empty windows.
    pub sources: &'static [&'static str],
    pub kind: ArtifactKind,
    /// LevelDB has no equivalent of `VACUUM INTO`: a live directory copy interleaves a compaction
    /// and yields a store Chromium may raze on open. These are captured only when the browser is
    /// provably stopped, and carried forward by digest otherwise.
    pub quiesced_only: bool,
}

/// THE allowlist. Verified against nine real profiles on this machine: `Cookies`, `LocalStorage`,
/// `SessionStorage`, `Login Data`, `Web Data`, `Extension State`, `Sessions`, `Sessions_Encrypted`,
/// `Preferences` and `History` are present in 9/9; `IndexedDB` in 4/9; `Local Extension Settings`
/// in 3/9; `Bookmarks` in **0/9** — for bookmarks, ENOENT is the common path, not an edge case.
pub const ARTIFACTS: &[ArtifactSpec] = &[
    ArtifactSpec {
        id: "cookies",
        sources: &["Default/Cookies"],
        kind: ArtifactKind::SqliteVacuum,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "localstorage",
        sources: &["Default/LocalStorage"],
        kind: ArtifactKind::DomStorage,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "sessionstorage",
        sources: &["Default/SessionStorage"],
        kind: ArtifactKind::DomStorage,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "indexeddb",
        sources: &["Default/IndexedDB"],
        kind: ArtifactKind::IndexedDb,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "passwords",
        sources: &["Default/Login Data", "Default/Login Data For Account"],
        kind: ArtifactKind::SqliteVacuum,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "autofill",
        sources: &["Default/Web Data", "Default/Account Web Data"],
        kind: ArtifactKind::SqliteVacuum,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "history",
        sources: &["Default/History"],
        kind: ArtifactKind::SqliteVacuum,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "extension-state",
        sources: &[
            "Default/Local Extension Settings",
            "Default/Sync Extension Settings",
            "Default/Extension State",
            "Default/Extension Rules",
            "Default/Extension Scripts",
        ],
        kind: ArtifactKind::DirTar,
        quiesced_only: true,
    },
    // Both directories under one id, deliberately. They are two halves of one SNSS session: the
    // plaintext side names the tabs, the encrypted side holds their state, and restoring one
    // without the other opens a window with no tabs and reports success.
    ArtifactSpec {
        id: "sessions",
        sources: &["Default/Sessions", "Default/Sessions_Encrypted"],
        kind: ArtifactKind::DirTar,
        quiesced_only: true,
    },
    ArtifactSpec {
        id: "bookmarks",
        sources: &["Default/Bookmarks"],
        kind: ArtifactKind::RawJson,
        quiesced_only: false,
    },
    ArtifactSpec {
        id: "prefs-subset",
        sources: &["Default/Preferences"],
        kind: ArtifactKind::PrefsSubset,
        quiesced_only: false,
    },
];

pub fn spec(id: &str) -> Option<&'static ArtifactSpec> {
    ARTIFACTS.iter().find(|a| a.id == id)
}

/// How much of the truth an artifact's bytes carry, so a weaker guarantee is visible as data rather
/// than assumed away.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Fidelity {
    /// Read back through the capture codec and digest-matched.
    Full,
    /// Byte-identical to what we captured, with no statement about internal consistency. Every
    /// [`ArtifactKind::DirTar`] artifact is at best this.
    Opaque,
    /// Carried forward from an earlier version because this capture mode could not read it safely.
    Stale,
}

/// A captured artifact. `plain_digest` is what a read-back must reproduce; `sealed_digest` is what
/// the vault must hand back before we even try to decrypt, so a swapped or truncated blob fails
/// before any of its bytes reach a user-data-dir.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArtifactRecord {
    pub id: String,
    pub kind: ArtifactKind,
    pub plain_digest: String,
    pub sealed_digest: String,
    pub plain_bytes: u64,
    pub sealed_bytes: u64,
    pub fidelity: Fidelity,
    /// Backend recorded for DOM storage: `sqlite` or `leveldb`. A restore across backends is
    /// REFUSED, because Chromium has no migration between them and the silent outcome is a
    /// zero-byte transfer that reports success.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub backend: Option<String>,
    /// Per-artifact counts for the UI. Free-form so a codec can report what it actually knows
    /// (origins/keys for DOM storage, files for a tar) without a union type per kind.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub counts: Vec<(String, u64)>,
    /// Version this artifact's bytes were actually captured in. Equal to the manifest's own version
    /// unless [`Fidelity::Stale`] carried it forward.
    pub captured_in_version: u64,
    /// Milliseconds since the capture's first artifact started, so the coherence window is
    /// attributable to a specific pair rather than only reported as a total.
    pub offset_ms: u64,
}

/// Which capture modes are mutually consistent, and which are honest about not being.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum CaptureMode {
    /// The browser is provably not running: no live `SingletonLock` owner, no live
    /// `DevToolsActivePort`. The only mode in which every store is mutually consistent, and the
    /// only mode that may read LevelDB directories.
    Quiesced,
    /// Autosave beside a running browser. Per-database consistency holds (`VACUUM INTO` takes a
    /// read transaction); cross-store does not. LevelDB artifacts are skipped and carried forward.
    Live,
    /// A possibly-dirty directory with no cooperating engine — a crashed sidecar, a profile that
    /// cannot launch at all. This is the mode that makes an unlaunchable profile recoverable, which
    /// is the whole point of an offline capture path.
    Dirty,
}

impl CaptureMode {
    pub fn label(self) -> &'static str {
        match self {
            Self::Quiesced => "quiesced",
            Self::Live => "live",
            Self::Dirty => "dirty",
        }
    }
}

/// Above this many milliseconds between the first and last artifact, a capture is labelled `loose`.
pub const COHERENCE_TIGHT_MS: u64 = 2000;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Coherence {
    /// Wall-clock span from the first artifact's start to the last artifact's end.
    pub window_ms: u64,
    /// `quiesced` | `tight` | `loose` | `dirty`. The restore UI prefers a `quiesced` snapshot over a
    /// newer `loose` one unless the user overrides.
    pub label: String,
}

impl Coherence {
    pub fn new(mode: CaptureMode, window_ms: u64) -> Self {
        let label = match mode {
            CaptureMode::Quiesced => "quiesced",
            CaptureMode::Dirty => "dirty",
            CaptureMode::Live if window_ms <= COHERENCE_TIGHT_MS => "tight",
            CaptureMode::Live => "loose",
        };
        Self {
            window_ms,
            label: label.to_string(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotManifest {
    pub manifest_version: u32,
    pub profile_id: String,
    /// Monotonic per profile, assigned by the vault.
    pub version: u64,
    pub captured_at: String,
    pub capture_mode: CaptureMode,
    pub coherence: Coherence,
    pub artifacts: Vec<ArtifactRecord>,
    /// Artifacts the registry knows but this profile does not have. Recorded because "absent" and
    /// "we failed to look" must be distinguishable when a restore later comes up short — and
    /// because `Bookmarks` is absent in 9/9 real profiles, so absence is the norm.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub absent: Vec<String>,
    /// Artifacts skipped with a reason (a LevelDB store beside a running browser, a probe refusal).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub skipped: Vec<(String, String)>,
}

impl SnapshotManifest {
    pub fn artifact(&self, id: &str) -> Option<&ArtifactRecord> {
        self.artifacts.iter().find(|a| a.id == id)
    }

    /// Encode for storage. Determinism (equal input ⇒ equal bytes ⇒ equal digest) comes from
    /// serializing structs in declared field order and from every collection being built in a
    /// sorted, registry-driven order — NOT from a canonicalizing pass. Nothing here serializes a
    /// `HashMap`, and nothing may start to.
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::into_writer(self, &mut out).context("encoding snapshot manifest as CBOR")?;
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        let manifest: Self =
            ciborium::from_reader(bytes).context("decoding snapshot manifest from CBOR")?;
        if manifest.manifest_version > MANIFEST_VERSION {
            bail!(
                "snapshot manifest version {} was written by a newer build (this build reads {MANIFEST_VERSION}); \
                 refusing to restore rather than guess at an encoding we do not know",
                manifest.manifest_version
            );
        }
        Ok(manifest)
    }
}

/// BLAKE3, lowercase hex. One hash function for artifacts, manifests and (in Phase 5) chunk ids, so
/// a digest can be compared across layers without a conversion step.
pub fn digest_hex(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex().to_string()
}

/// Reject an artifact id that is not in the registry AND is not a safe path component, before it is
/// used to build a vault filename. The registry check alone would be enough today; the second check
/// is what keeps that true when a manifest arrives from somewhere other than our own capture.
pub fn safe_artifact_filename(id: &str) -> Result<String> {
    if id.is_empty()
        || id.len() > 64
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        bail!("artifact id `{id}` is not a safe filename component");
    }
    Ok(format!("{id}.lba"))
}

/// Resolve an artifact source to an absolute path inside `udd`, refusing anything that escapes it.
///
/// The registry is a compile-time constant, so today this can only fail on a programming error. It
/// exists because the same joining happens on the RESTORE side against a manifest read off disk,
/// where a `../` in a source path would write outside the profile.
pub fn resolve_source(udd: &Path, source: &str) -> Result<PathBuf> {
    if source.is_empty() || source.starts_with('/') || source.starts_with('\\') {
        bail!("artifact source `{source}` must be relative to the user-data-dir");
    }
    let mut out = udd.to_path_buf();
    for part in source.split('/') {
        if part.is_empty() || part == "." || part == ".." {
            bail!("artifact source `{source}` must not contain traversal segments");
        }
        out.push(part);
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn registry_ids_are_unique_and_filename_safe() {
        let mut seen = Vec::new();
        for spec in ARTIFACTS {
            assert!(
                !seen.contains(&spec.id),
                "duplicate artifact id {}",
                spec.id
            );
            seen.push(spec.id);
            safe_artifact_filename(spec.id).unwrap();
            assert!(!spec.sources.is_empty(), "{} has no sources", spec.id);
            for source in spec.sources {
                resolve_source(Path::new("/udd"), source).unwrap();
            }
        }
    }

    /// The two SNSS directories must stay in ONE artifact. Splitting them lets a restore land the
    /// tab list without the tab state, which opens empty windows and reports success.
    #[test]
    fn sessions_and_sessions_encrypted_share_one_artifact() {
        let sessions = spec("sessions").expect("sessions artifact");
        assert!(sessions.sources.contains(&"Default/Sessions"));
        assert!(sessions.sources.contains(&"Default/Sessions_Encrypted"));
        for other in ARTIFACTS.iter().filter(|a| a.id != "sessions") {
            for source in other.sources {
                assert!(
                    !source.starts_with("Default/Sessions"),
                    "{} must not also claim {source}",
                    other.id
                );
            }
        }
    }

    /// The excluded set is enforced by the registry not naming it. This asserts the specific paths
    /// that measured 0.96–4.48 GB per profile never entered the allowlist by a later edit.
    #[test]
    fn multi_gigabyte_component_payloads_are_not_in_the_allowlist() {
        const NEVER: &[&str] = &[
            "Cache",
            "Code Cache",
            "GPUCache",
            "OptGuideOnDeviceModel",
            "component_crx_cache",
            "SODA",
            "SODALanguagePacks",
            "TranslateKit",
            "screen_ai",
            "blob_storage",
            "Shared Dictionary",
            "System Profile",
            "font-files",
            "Secure Preferences",
        ];
        for spec in ARTIFACTS {
            for source in spec.sources {
                for banned in NEVER {
                    assert!(
                        !source.split('/').any(|part| part == *banned),
                        "{} must not capture {banned}",
                        spec.id
                    );
                }
            }
        }
    }

    #[test]
    fn manifest_round_trips_and_encoding_is_deterministic() {
        let manifest = SnapshotManifest {
            manifest_version: MANIFEST_VERSION,
            profile_id: "prf_test".into(),
            version: 3,
            captured_at: "2026-08-17T00:00:00Z".into(),
            capture_mode: CaptureMode::Quiesced,
            coherence: Coherence::new(CaptureMode::Quiesced, 41),
            artifacts: vec![ArtifactRecord {
                id: "cookies".into(),
                kind: ArtifactKind::SqliteVacuum,
                plain_digest: digest_hex(b"a"),
                sealed_digest: digest_hex(b"b"),
                plain_bytes: 1,
                sealed_bytes: 2,
                fidelity: Fidelity::Full,
                backend: None,
                counts: vec![("rows".into(), 181)],
                captured_in_version: 3,
                offset_ms: 0,
            }],
            absent: vec!["bookmarks".into()],
            skipped: vec![("sessions".into(), "browser is running".into())],
        };
        let encoded = manifest.encode().unwrap();
        assert_eq!(encoded, manifest.encode().unwrap());
        let decoded = SnapshotManifest::decode(&encoded).unwrap();
        assert_eq!(decoded.version, 3);
        assert_eq!(decoded.artifact("cookies").unwrap().plain_bytes, 1);
        assert_eq!(decoded.absent, vec!["bookmarks".to_string()]);
        assert_eq!(decoded.coherence.label, "quiesced");
    }

    #[test]
    fn a_manifest_from_a_newer_build_is_refused_not_guessed_at() {
        let mut manifest = SnapshotManifest {
            manifest_version: MANIFEST_VERSION + 7,
            profile_id: "prf_test".into(),
            version: 1,
            captured_at: "2026-08-17T00:00:00Z".into(),
            capture_mode: CaptureMode::Dirty,
            coherence: Coherence::new(CaptureMode::Dirty, 0),
            artifacts: Vec::new(),
            absent: Vec::new(),
            skipped: Vec::new(),
        };
        let err = SnapshotManifest::decode(&manifest.encode().unwrap()).unwrap_err();
        assert!(err.to_string().contains("newer build"), "{err}");
        manifest.manifest_version = MANIFEST_VERSION;
        SnapshotManifest::decode(&manifest.encode().unwrap()).unwrap();
    }

    #[test]
    fn coherence_labels_follow_the_capture_mode_then_the_window() {
        assert_eq!(Coherence::new(CaptureMode::Live, 0).label, "tight");
        assert_eq!(
            Coherence::new(CaptureMode::Live, COHERENCE_TIGHT_MS).label,
            "tight"
        );
        assert_eq!(
            Coherence::new(CaptureMode::Live, COHERENCE_TIGHT_MS + 1).label,
            "loose"
        );
        // A quiesced capture is coherent regardless of how long it took: nothing was writing.
        assert_eq!(
            Coherence::new(CaptureMode::Quiesced, 60_000).label,
            "quiesced"
        );
        assert_eq!(Coherence::new(CaptureMode::Dirty, 1).label, "dirty");
    }

    #[test]
    fn source_resolution_refuses_traversal_and_absolute_paths() {
        let udd = Path::new("/udd");
        assert_eq!(
            resolve_source(udd, "Default/Cookies").unwrap(),
            Path::new("/udd/Default/Cookies")
        );
        for bad in ["/etc/passwd", "../../etc/passwd", "Default/../../x", ""] {
            assert!(resolve_source(udd, bad).is_err(), "accepted {bad}");
        }
        assert!(safe_artifact_filename("../../evil").is_err());
        assert!(safe_artifact_filename("").is_err());
    }
}
