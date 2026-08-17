//! Whole-directory capture for the artifacts that have no readable record format.
//!
//! LevelDB stores (`Local Extension Settings/<id>`, `Extension State`, `Extension Rules`,
//! `Extension Scripts`) and the two SNSS session directories are opaque to us. There is no LevelDB
//! equivalent of `VACUUM INTO`, so these are captured only when the browser is provably stopped: a
//! live copy can interleave a compaction and produce a set of files that belong to no single point in
//! time, and Chromium RAZES a LevelDB store it decides is corrupt and recreates it empty. Losing a
//! store outright is worse than carrying yesterday's copy forward, which is why
//! [`super::manifest::ArtifactSpec::quiesced_only`] exists.
//!
//! For these artifacts "verified" means byte-identical to what we captured — not internally
//! consistent. That is a genuinely weaker guarantee than cookies and DOM storage get, and the
//! manifest records it as [`super::manifest::Fidelity::Opaque`] so the difference is legible rather
//! than implied.

use std::collections::BTreeSet;
use std::io::Write;
use std::path::{Component, Path, PathBuf};

use anyhow::{bail, Context, Result};

/// Per-directory runtime files that must NOT travel. `LOCK` is a live lock file, `LOG`/`LOG.old` are
/// LevelDB's diagnostic logs — they name absolute host paths and grow forever — and the SQLite
/// sidecars beside a database inside a tarred directory belong to a database we did not copy through
/// `VACUUM INTO`.
const EXCLUDED_NAMES: &[&str] = &["LOCK", "LOG", "LOG.old"];
const EXCLUDED_SUFFIXES: &[&str] = &["-wal", "-shm", "-journal"];

/// Cap on a single directory artifact. `Local Extension Settings` for a chatty extension is normally
/// tens of kilobytes; a hundred megabytes means something unexpected got in (a cache directory moved
/// under an allowlisted parent), and a snapshot that silently grows to gigabytes is how the sync unit
/// stops being a slim identity set.
const MAX_DIR_BYTES: u64 = 128 * 1024 * 1024;

/// A tar.gz of one or more directories, each stored under its own top-level prefix.
///
/// The archive is DETERMINISTIC: entries are emitted in sorted order at every level, and every header
/// carries a fixed mtime, uid and gid and a normalised mode. Three things depend on that.
///
/// 1. The read-back verification compares the re-tarred staged tree against the manifest digest. Real
///    mtimes make that comparison fail for a reason that has nothing to do with the data, because a
///    directory recreated during unpack gets today's timestamp.
/// 2. Two captures of an unchanged directory produce the same digest, which is what lets a later
///    version carry an artifact forward instead of re-storing it.
/// 3. uid/gid from the capturing machine are meaningless on the restoring one.
///
/// `tar::Builder::append_dir_all` provides none of this — it neither sorts nor normalises — so a
/// snapshot built with it would appear to change every time the directory was re-read.
pub fn tar_dirs(roots: &[(String, PathBuf)]) -> Result<Vec<u8>> {
    let mut total = 0u64;
    let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
    let mut builder = tar::Builder::new(encoder);
    for (prefix, root) in roots {
        if !root.is_dir() {
            continue;
        }
        append_dir(&mut builder, root, Path::new(prefix), &mut total)?;
    }
    let encoder = builder.into_inner().context("finishing tar")?;
    let bytes = encoder.finish().context("finishing gzip")?;
    Ok(bytes)
}

/// Chromium creates these trees 0600/0700 and nothing in them is executable, so the mode is set
/// rather than copied. Fixed mtime/uid/gid for the determinism reasons above.
fn normalised_header(path: &Path, entry_type: tar::EntryType, size: u64) -> Result<tar::Header> {
    let mut header = tar::Header::new_gnu();
    header.set_entry_type(entry_type);
    header.set_size(size);
    header.set_mode(if entry_type.is_dir() { 0o700 } else { 0o600 });
    header.set_mtime(0);
    header.set_uid(0);
    header.set_gid(0);
    header
        .set_path(path)
        .with_context(|| format!("tar path {}", path.display()))?;
    header.set_cksum();
    Ok(header)
}

fn append_dir<W: Write>(
    builder: &mut tar::Builder<W>,
    dir: &Path,
    prefix: &Path,
    total: &mut u64,
) -> Result<()> {
    let mut names = BTreeSet::new();
    for entry in
        std::fs::read_dir(dir).with_context(|| format!("reading directory {}", dir.display()))?
    {
        names.insert(entry?.file_name());
    }
    builder.append(
        &normalised_header(prefix, tar::EntryType::Directory, 0)?,
        std::io::empty(),
    )?;
    for name in names {
        let from = dir.join(&name);
        let name_str = name.to_string_lossy().to_string();
        if is_excluded(&name_str) {
            continue;
        }
        let to = prefix.join(&name);
        // Symlinks are skipped rather than followed: a LevelDB store has none, and a symlink that
        // did appear would either escape the profile on restore or inflate a hardlinked font pack.
        let meta = std::fs::symlink_metadata(&from)?;
        if meta.file_type().is_symlink() {
            tracing::warn!(path = %from.display(), "skipping symlink inside a captured directory");
            continue;
        }
        if meta.is_dir() {
            append_dir(builder, &from, &to, total)?;
        } else if meta.is_file() {
            *total += meta.len();
            if *total > MAX_DIR_BYTES {
                bail!(
                    "directory artifact exceeded {MAX_DIR_BYTES} bytes at {}; refusing to grow the \
                     snapshot into a full user-data-dir copy",
                    from.display()
                );
            }
            let mut file = std::fs::File::open(&from)
                .with_context(|| format!("opening {}", from.display()))?;
            let header = normalised_header(&to, tar::EntryType::Regular, meta.len())?;
            builder.append(&header, &mut file)?;
        }
    }
    Ok(())
}

fn is_excluded(name: &str) -> bool {
    EXCLUDED_NAMES.contains(&name) || EXCLUDED_SUFFIXES.iter().any(|s| name.ends_with(s))
}

/// Which top-level prefixes a tar contains, without unpacking it. Used to check a staged artifact's
/// shape before anything is moved.
pub fn tar_prefixes(bytes: &[u8]) -> Result<BTreeSet<String>> {
    let mut prefixes = BTreeSet::new();
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    for entry in archive.entries()? {
        let entry = entry?;
        let path = entry.path()?.to_path_buf();
        if let Some(Component::Normal(first)) = path.components().next() {
            prefixes.insert(first.to_string_lossy().to_string());
        }
    }
    Ok(prefixes)
}

/// Count the files in a tar. Reported per artifact so "restored 0 files" is visible in the UI rather
/// than indistinguishable from success.
pub fn tar_file_count(bytes: &[u8]) -> Result<u64> {
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    let mut count = 0;
    for entry in archive.entries()? {
        if entry?.header().entry_type().is_file() {
            count += 1;
        }
    }
    Ok(count)
}

/// Unpack into `dest`, refusing any entry that would escape it.
///
/// `tar::Archive::unpack` already refuses `..`, but it is a soft refusal (it skips) and we want a
/// hard one: an artifact carrying a traversal entry is not a partially-good artifact, it is a
/// tampered one, and it must fail the restore rather than land a subset.
pub fn untar_into(bytes: &[u8], dest: &Path) -> Result<u64> {
    std::fs::create_dir_all(dest)?;
    let canonical_dest = std::fs::canonicalize(dest)?;
    let decoder = flate2::read::GzDecoder::new(bytes);
    let mut archive = tar::Archive::new(decoder);
    // The archive's mtimes are the fixed sentinel from `normalised_header`, so preserving them would
    // date every restored file to 1970. The digest comparison re-tars through `tar_dirs`, which
    // normalises again, so nothing depends on the on-disk timestamps.
    archive.set_preserve_mtime(false);
    let mut files = 0u64;
    for entry in archive.entries()? {
        let mut entry = entry?;
        let path = entry.path()?.to_path_buf();
        for component in path.components() {
            match component {
                Component::Normal(_) | Component::CurDir => {}
                _ => bail!(
                    "archive entry `{}` contains a path component that escapes the destination",
                    path.display()
                ),
            }
        }
        let entry_type = entry.header().entry_type();
        if !(entry_type.is_file() || entry_type.is_dir()) {
            bail!(
                "archive entry `{}` is neither a file nor a directory ({entry_type:?})",
                path.display()
            );
        }
        let target = canonical_dest.join(&path);
        if entry_type.is_dir() {
            std::fs::create_dir_all(&target)?;
            continue;
        }
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent)?;
        }
        entry
            .unpack(&target)
            .with_context(|| format!("unpacking {}", path.display()))?;
        files += 1;
    }
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lobster-tar-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The real `Local Extension Settings/<id>` shape, from a profile on this machine: a `.log`, a
    /// `CURRENT`, a `MANIFEST-000001`, plus the runtime files that must not travel.
    fn seed_leveldb_dir(dir: &Path) {
        std::fs::create_dir_all(dir).unwrap();
        std::fs::write(dir.join("000003.log"), b"leveldb records").unwrap();
        std::fs::write(dir.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        std::fs::write(dir.join("MANIFEST-000001"), b"manifest").unwrap();
        std::fs::write(dir.join("LOCK"), b"").unwrap();
        std::fs::write(dir.join("LOG"), b"absolute /home/... paths").unwrap();
        std::fs::write(dir.join("LOG.old"), b"older").unwrap();
    }

    #[test]
    fn tar_excludes_runtime_files_and_is_byte_stable() {
        let root = temp_dir("stable");
        let src = root.join("Local Extension Settings");
        seed_leveldb_dir(&src.join("dilfmeocbnifnkedfcioghohbppbkkje"));
        seed_leveldb_dir(&src.join("opbicdcjjlpehmibpmkmkconpnnkijel"));

        let roots = vec![("Local Extension Settings".to_string(), src.clone())];
        let first = tar_dirs(&roots).unwrap();
        let second = tar_dirs(&roots).unwrap();
        assert_eq!(first, second, "the same tree must tar to the same bytes");

        let dest = root.join("out");
        let files = untar_into(&first, &dest).unwrap();
        let unpacked = dest.join("Local Extension Settings");
        assert!(unpacked
            .join("dilfmeocbnifnkedfcioghohbppbkkje")
            .join("000003.log")
            .exists());
        assert!(unpacked
            .join("opbicdcjjlpehmibpmkmkconpnnkijel")
            .join("CURRENT")
            .exists());
        for excluded in ["LOCK", "LOG", "LOG.old"] {
            assert!(
                !unpacked
                    .join("dilfmeocbnifnkedfcioghohbppbkkje")
                    .join(excluded)
                    .exists(),
                "{excluded} must not travel"
            );
        }
        assert_eq!(files, 6, "three real files per extension id");
        assert_eq!(tar_file_count(&first).unwrap(), 6);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// The `sessions` artifact carries two directories in one archive; both prefixes must be present
    /// or the restore is a half session.
    #[test]
    fn multiple_roots_are_kept_under_separate_prefixes() {
        let root = temp_dir("multi");
        let sessions = root.join("Sessions");
        let encrypted = root.join("Sessions_Encrypted");
        std::fs::create_dir_all(&sessions).unwrap();
        std::fs::create_dir_all(&encrypted).unwrap();
        std::fs::write(sessions.join("Session_13430898126032860"), b"snss").unwrap();
        std::fs::write(encrypted.join("Session_13430898126033555"), b"snss-enc").unwrap();

        let bytes = tar_dirs(&[
            ("Sessions".to_string(), sessions),
            ("Sessions_Encrypted".to_string(), encrypted),
        ])
        .unwrap();
        let prefixes = tar_prefixes(&bytes).unwrap();
        assert!(prefixes.contains("Sessions"));
        assert!(prefixes.contains("Sessions_Encrypted"));

        let dest = root.join("out");
        untar_into(&bytes, &dest).unwrap();
        assert_eq!(
            std::fs::read(
                dest.join("Sessions_Encrypted")
                    .join("Session_13430898126033555")
            )
            .unwrap(),
            b"snss-enc"
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_absent_directory_produces_an_archive_rather_than_an_error() {
        let root = temp_dir("absent");
        let bytes = tar_dirs(&[("Extension Rules".to_string(), root.join("nope"))]).unwrap();
        assert!(tar_prefixes(&bytes).unwrap().is_empty());
        assert_eq!(tar_file_count(&bytes).unwrap(), 0);
        std::fs::remove_dir_all(root).unwrap();
    }

    /// A tampered archive must fail the restore outright rather than land the entries that happened to
    /// be safe. `tar::Header::set_path` refuses to WRITE a `..` path, so the name field is filled
    /// directly — which is exactly how a hostile archive would arrive.
    #[test]
    fn a_traversal_entry_fails_the_restore_instead_of_landing_a_subset() {
        let root = temp_dir("traversal");
        let encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::default());
        let mut builder = tar::Builder::new(encoder);
        let payload = b"pwned";
        let mut header = tar::Header::new_gnu();
        header.set_entry_type(tar::EntryType::Regular);
        header.set_size(payload.len() as u64);
        header.set_mode(0o600);
        header.set_mtime(0);
        let name = b"../escaped";
        header.as_gnu_mut().unwrap().name[..name.len()].copy_from_slice(name);
        header.set_cksum();
        builder.append(&header, &payload[..]).unwrap();
        let bytes = builder.into_inner().unwrap().finish().unwrap();
        assert!(
            tar_prefixes(&bytes).is_ok(),
            "the fixture must be a readable archive, just a hostile one"
        );

        let dest = root.join("out");
        let err = untar_into(&bytes, &dest).unwrap_err().to_string();
        assert!(err.contains("escapes the destination"), "{err}");
        assert!(!root.join("escaped").exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn symlinks_are_skipped_rather_than_followed() {
        let root = temp_dir("symlink");
        let src = root.join("Extension State");
        std::fs::create_dir_all(&src).unwrap();
        std::fs::write(src.join("CURRENT"), b"x").unwrap();
        std::fs::write(root.join("outside-secret"), b"secret").unwrap();
        std::os::unix::fs::symlink(root.join("outside-secret"), src.join("link")).unwrap();

        let bytes = tar_dirs(&[("Extension State".to_string(), src)]).unwrap();
        let dest = root.join("out");
        untar_into(&bytes, &dest).unwrap();
        assert!(dest.join("Extension State").join("CURRENT").exists());
        assert!(
            !dest.join("Extension State").join("link").exists(),
            "a symlink must not be captured or recreated"
        );
        std::fs::remove_dir_all(root).unwrap();
    }
}
