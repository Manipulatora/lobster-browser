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

/// The browser identity a snapshot belongs to.
///
/// WHY THIS IS IN THE MANIFEST AT ALL. The artifacts are the session; this is the browser that
/// session was established from, and for an anti-detect product the two are inseparable. Restoring
/// a cookie jar into a profile that presents a different canvas/WebGL persona, a different OS
/// family, or a different exit IP is not a recovery — it is the same account arriving as a visibly
/// different device, which is precisely the event the product exists to avoid.
///
/// It is captured from the PROFILE ROW, not from the user-data-dir, because that is where identity
/// actually lives: `writeLobiumConfig` rewrites `lobium-fp.json` from the row's seed, overrides and
/// proxy geo on EVERY launch (packages/engine-runner/src/lobium-config.ts), so whatever the snapshot
/// copied out of the directory would be overwritten before the browser ever read it.
///
/// `proxy_present` is separate from the proxy's identity on purpose. `lobium-config.ts:186-187`
/// derives `webrtcPolicy` from whether a proxy exists — with none it falls back to
/// `default_public_interface_only`, which exposes host ICE candidates while the persona still
/// asserts its original timezone. So a restore that quietly loses the proxy does not merely change
/// the exit IP: it turns on a host-IP leak. That case must be refused, not warned about.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub engine: String,
    pub os: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub fingerprint_seed: String,
    /// Digest of the canonical fingerprint-overrides JSON rather than the document, so a manifest
    /// never carries persona detail and a comparison is still exact.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub fingerprint_overrides_digest: Option<String>,
    /// Whether a proxy was bound at capture time. See the WebRTC note above.
    pub proxy_present: bool,
    /// The proxy's non-secret coordinates, for reporting WHICH proxy a mismatch is about. Never
    /// credentials.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub proxy_endpoint: Option<String>,
    /// The engine build the session was established under. A cookie DB written by a newer Chromium
    /// is razed by an older one, so a downgrade has to be refusable.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub engine_build: Option<String>,
}

/// How a snapshot's identity differs from the profile it is being restored into.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum IdentityMismatch {
    /// Refuse: the restored browser would present a different device.
    Persona { field: &'static str },
    /// Refuse: the proxy is gone, so WebRTC would fall back to leaking host candidates.
    ProxyLost,
    /// Report: same persona, different proxy endpoint. The user may genuinely have rotated it.
    ProxyChanged { from: String, to: String },
    /// Refuse: restoring into an older engine, which razes a too-new database.
    EngineDowngrade { from: String, to: String },
}

impl IdentityMismatch {
    /// Whether this difference must block a restore rather than merely be reported.
    ///
    /// A changed proxy endpoint is the one difference a user can legitimately have caused (rotating
    /// a residential exit is routine), so it informs rather than blocks. Everything else means the
    /// restored profile is not the browser the session came from.
    pub fn blocks_restore(&self) -> bool {
        !matches!(self, IdentityMismatch::ProxyChanged { .. })
    }
}

impl Identity {
    /// A fixed identity for tests, so a construction site does not have to restate seven fields.
    #[cfg(test)]
    pub fn fixture() -> Self {
        Self {
            engine: "lobium".to_string(),
            os: "windows".to_string(),
            os_version: Some("10".to_string()),
            fingerprint_seed: "0123456789abcdef0123456789abcdef".to_string(),
            fingerprint_overrides_digest: None,
            proxy_present: true,
            proxy_endpoint: Some("proxy.example:8080".to_string()),
            engine_build: Some("152.0.7300.10".to_string()),
        }
    }

    /// Compare a snapshot's identity against the profile it would be restored into.
    pub fn diff(&self, target: &Identity) -> Vec<IdentityMismatch> {
        let mut out = Vec::new();
        for (field, a, b) in [
            ("engine", &self.engine, &target.engine),
            ("os", &self.os, &target.os),
            (
                "fingerprintSeed",
                &self.fingerprint_seed,
                &target.fingerprint_seed,
            ),
        ] {
            if a != b {
                out.push(IdentityMismatch::Persona { field });
            }
        }
        if self.os_version != target.os_version {
            out.push(IdentityMismatch::Persona { field: "osVersion" });
        }
        if self.fingerprint_overrides_digest != target.fingerprint_overrides_digest {
            out.push(IdentityMismatch::Persona {
                field: "fingerprintOverrides",
            });
        }
        if self.proxy_present && !target.proxy_present {
            out.push(IdentityMismatch::ProxyLost);
        } else if self.proxy_present && target.proxy_present {
            match (&self.proxy_endpoint, &target.proxy_endpoint) {
                (Some(from), Some(to)) if from != to => out.push(IdentityMismatch::ProxyChanged {
                    from: from.clone(),
                    to: to.clone(),
                }),
                _ => {}
            }
        }
        // A NEWER engine on the target is fine — Chromium migrates its own databases forward. Only
        // the downgrade direction destroys data.
        if let (Some(from), Some(to)) = (&self.engine_build, &target.engine_build) {
            if build_is_older(to, from) {
                out.push(IdentityMismatch::EngineDowngrade {
                    from: from.clone(),
                    to: to.clone(),
                });
            }
        }
        out
    }
}

/// Compare two engine build strings by their dotted numeric components.
///
/// Unknown or unparseable shapes compare as NOT older, so a build string we do not understand can
/// never manufacture a downgrade refusal out of nothing.
fn build_is_older(candidate: &str, reference: &str) -> bool {
    let parts = |v: &str| -> Vec<u64> {
        v.split('.')
            .map(|p| p.parse::<u64>().unwrap_or(0))
            .collect()
    };
    let (c, r) = (parts(candidate), parts(reference));
    if c.iter().all(|n| *n == 0) || r.iter().all(|n| *n == 0) {
        return false;
    }
    for i in 0..c.len().max(r.len()) {
        let (cv, rv) = (
            c.get(i).copied().unwrap_or(0),
            r.get(i).copied().unwrap_or(0),
        );
        if cv != rv {
            return cv < rv;
        }
    }
    false
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
    /// The browser this session belongs to. See {@link Identity}: a restore that reinstates the data
    /// without it produces a working session on a visibly different device.
    pub identity: Identity,
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

    /// The refusals are the point of the identity block, so each one is asserted explicitly.
    #[test]
    fn a_different_persona_blocks_a_restore() {
        let snap = Identity::fixture();

        for mutate in [
            (|i: &mut Identity| i.engine = "chromium".into()) as fn(&mut Identity),
            |i: &mut Identity| i.os = "macos".into(),
            |i: &mut Identity| i.os_version = Some("11".into()),
            |i: &mut Identity| i.fingerprint_seed = "ffffffffffffffffffffffffffffffff".into(),
            |i: &mut Identity| i.fingerprint_overrides_digest = Some("deadbeef".into()),
        ] {
            let mut target = Identity::fixture();
            mutate(&mut target);
            let diff = snap.diff(&target);
            assert!(!diff.is_empty(), "a changed persona field must be detected");
            assert!(
                diff.iter().any(|m| m.blocks_restore()),
                "a changed persona field must BLOCK: {diff:?}"
            );
        }

        assert!(
            snap.diff(&Identity::fixture()).is_empty(),
            "identical is clean"
        );
    }

    /// Losing the proxy is not merely a different exit IP: `lobium-config.ts` derives webrtcPolicy
    /// from whether a proxy exists, so a proxy-less restore turns on a host-IP leak while the persona
    /// still claims its original timezone. It must block.
    #[test]
    fn losing_the_proxy_blocks_because_webrtc_would_leak() {
        let snap = Identity::fixture();
        let mut target = Identity::fixture();
        target.proxy_present = false;
        target.proxy_endpoint = None;

        let diff = snap.diff(&target);
        assert_eq!(diff, vec![IdentityMismatch::ProxyLost]);
        assert!(diff[0].blocks_restore());
    }

    /// A rotated endpoint is the one difference a user legitimately causes, so it reports rather than
    /// blocks — otherwise every residential rotation would lock them out of their own session.
    #[test]
    fn a_rotated_proxy_endpoint_reports_but_does_not_block() {
        let snap = Identity::fixture();
        let mut target = Identity::fixture();
        target.proxy_endpoint = Some("proxy.example:9090".to_string());

        let diff = snap.diff(&target);
        assert_eq!(
            diff,
            vec![IdentityMismatch::ProxyChanged {
                from: "proxy.example:8080".to_string(),
                to: "proxy.example:9090".to_string(),
            }]
        );
        assert!(!diff[0].blocks_restore());
    }

    /// Chromium migrates its own databases forward but RAZES one that is too new, so only the
    /// downgrade direction is refused — and an unparseable build string must not invent a refusal.
    #[test]
    fn only_an_engine_downgrade_blocks() {
        let snap = Identity::fixture(); // 152.0.7300.10
        let older = Identity {
            engine_build: Some("151.0.7000.1".to_string()),
            ..Identity::fixture()
        };
        assert!(
            snap.diff(&older)
                .iter()
                .any(|m| matches!(m, IdentityMismatch::EngineDowngrade { .. })),
            "restoring into an older engine must block"
        );

        let newer = Identity {
            engine_build: Some("153.0.1.0".to_string()),
            ..Identity::fixture()
        };
        assert!(snap.diff(&newer).is_empty(), "a newer engine is fine");

        for junk in ["", "unknown", "dev-build"] {
            let odd = Identity {
                engine_build: Some(junk.to_string()),
                ..Identity::fixture()
            };
            assert!(
                snap.diff(&odd).is_empty(),
                "an unparseable build ({junk:?}) must not manufacture a downgrade"
            );
        }
    }

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
            identity: Identity::fixture(),
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
            identity: Identity::fixture(),
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
