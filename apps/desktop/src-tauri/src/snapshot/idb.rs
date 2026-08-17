//! IndexedDB: per-file SQLite, explicitly NOT a LevelDB path.
//!
//! In Lobium 152 an IndexedDB backing store is a WAL-mode SQLite file, one per database, at
//! `Default/IndexedDB/<origin>/<Base32>` with `-wal`/`-shm` sidecars. Verified two ways: the fork
//! ships `content/browser/indexed_db/instance/sqlite/backing_store_impl.cc`, and on this machine
//! `find` over every real `IndexedDB/` directory for `CURRENT`, `MANIFEST-*` or `*.ldb` returns
//! nothing while every Base32-named file is `SQLite 3.x` with WAL header bytes `0202`.
//!
//! A LevelDB filename allowlist — the obvious implementation, and what two of the three source
//! designs specified — matches NONE of those names, so it captures zero bytes without erroring. And a
//! tar of main+`-wal`+`-shm` would be non-atomic, which is worse than zero: Chromium razes a corrupt
//! IDB backing store and recreates it EMPTY, so a torn copy destroys the data it was meant to save.
//! Hence `VACUUM INTO` per file.
//!
//! `*.indexeddb.blob/` directories hold out-of-line Blob/File values referenced by rows inside those
//! databases, so they travel in the same artifact — tarred, since they are opaque content-addressed
//! files with no schema. None of the nine real profiles has one, which is exactly why it needs a test
//! rather than a field report.

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::{dir_tar, sqlite_copy};

/// Guard against an origin directory that has grown into something else. A real IndexedDB file on
/// this machine is 73728 bytes; the largest observed profile total is under a megabyte.
const MAX_IDB_BYTES: u64 = 256 * 1024 * 1024;

/// One captured database file or blob directory. `rel` is relative to `Default/IndexedDB`, so the
/// origin directory names (`https_www.payoneer.com_0`) survive untouched — they are Chromium's own
/// origin encoding and we never parse or rebuild them.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdbEntry {
    pub rel: String,
    pub kind: IdbEntryKind,
    pub bytes: Vec<u8>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum IdbEntryKind {
    /// A `VACUUM INTO` copy: one clean file, no sidecars.
    Sqlite,
    /// A tar.gz of a `*.indexeddb.blob/` directory.
    BlobDir,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct IdbRecords {
    /// Sorted by `rel` so the encoding — and therefore the digest — is stable.
    pub entries: Vec<IdbEntry>,
}

impl IdbRecords {
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::into_writer(self, &mut out).context("encoding IndexedDB records")?;
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ciborium::from_reader(bytes).context("decoding IndexedDB records")
    }

    pub fn database_count(&self) -> u64 {
        self.entries
            .iter()
            .filter(|e| e.kind == IdbEntryKind::Sqlite)
            .count() as u64
    }

    pub fn blob_dir_count(&self) -> u64 {
        self.entries
            .iter()
            .filter(|e| e.kind == IdbEntryKind::BlobDir)
            .count() as u64
    }
}

/// Walk `<udd>/Default/IndexedDB`, vacuuming every database file and tarring every blob directory.
///
/// `scratch` receives the vacuum output and is expected to be a caller-owned temp directory.
pub fn capture(idb_root: &Path, scratch: &Path) -> Result<IdbRecords> {
    let mut entries = Vec::new();
    if !idb_root.is_dir() {
        return Ok(IdbRecords { entries });
    }
    let mut total = 0u64;
    std::fs::create_dir_all(scratch)?;
    for origin in sorted_dir_names(idb_root)? {
        let origin_dir = idb_root.join(&origin);
        if !origin_dir.is_dir() {
            // A stray file directly under IndexedDB/ is not a store; skipping it beats guessing.
            continue;
        }
        for name in sorted_dir_names(&origin_dir)? {
            let path = origin_dir.join(&name);
            let rel = format!("{origin}/{name}");
            if name.ends_with(".indexeddb.blob") && path.is_dir() {
                let bytes = dir_tar::tar_dirs(&[(name.clone(), path)])?;
                total += bytes.len() as u64;
                entries.push(IdbEntry {
                    rel,
                    kind: IdbEntryKind::BlobDir,
                    bytes,
                });
                continue;
            }
            if !path.is_file() || is_sidecar(&name) {
                continue;
            }
            // Everything that is left should be a Base32-named SQLite database. Confirm before
            // vacuuming so a future non-SQLite artifact in this directory is a loud skip, not a
            // confusing SQLite error.
            if !is_sqlite_file(&path)? {
                tracing::warn!(
                    path = %path.display(),
                    "IndexedDB entry is not a SQLite database; skipping (a LevelDB-era layout would land here)"
                );
                continue;
            }
            let staged = scratch.join(format!("{}.db", entries.len()));
            sqlite_copy::vacuum_into(&path, &staged)?;
            let bytes = std::fs::read(&staged)?;
            let _ = std::fs::remove_file(&staged);
            total += bytes.len() as u64;
            if total > MAX_IDB_BYTES {
                bail!(
                    "IndexedDB capture exceeded {MAX_IDB_BYTES} bytes at {rel}; refusing to grow the \
                     snapshot beyond the slim identity set"
                );
            }
            entries.push(IdbEntry {
                rel,
                kind: IdbEntryKind::Sqlite,
                bytes,
            });
        }
    }
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(IdbRecords { entries })
}

/// Write the records into a staging directory laid out exactly like `Default/IndexedDB`.
///
/// Every SQLite entry gets an `integrity_check` before it is allowed to count as staged: a truncated
/// backing store is the one input that makes Chromium delete a user's IndexedDB data outright.
pub fn write_records(stage_root: &Path, records: &IdbRecords) -> Result<()> {
    std::fs::create_dir_all(stage_root)?;
    for entry in &records.entries {
        let (origin, name) = entry.rel.split_once('/').ok_or_else(|| {
            anyhow::anyhow!("IndexedDB entry `{}` is not <origin>/<name>", entry.rel)
        })?;
        for part in [origin, name] {
            if part.is_empty() || part == "." || part == ".." || part.contains('\\') {
                bail!(
                    "IndexedDB entry `{}` has an unsafe path component",
                    entry.rel
                );
            }
        }
        let origin_dir = stage_root.join(origin);
        std::fs::create_dir_all(&origin_dir)?;
        match entry.kind {
            IdbEntryKind::Sqlite => {
                let path = origin_dir.join(name);
                std::fs::write(&path, &entry.bytes)?;
                sqlite_copy::integrity_check(&path)?;
            }
            IdbEntryKind::BlobDir => {
                dir_tar::untar_into(&entry.bytes, &origin_dir)?;
            }
        }
    }
    Ok(())
}

/// Read a staged (or restored) `IndexedDB` tree back into records for the digest comparison.
///
/// The SQLite entries are re-read as raw bytes rather than re-vacuumed: they were written by us from
/// a vacuum output and must come back identical. Re-vacuuming would compare a copy of a copy and let
/// a byte-level difference through.
pub fn read_records(root: &Path, expected: &IdbRecords) -> Result<IdbRecords> {
    let mut entries = Vec::new();
    for want in &expected.entries {
        let (origin, name) = want.rel.split_once('/').ok_or_else(|| {
            anyhow::anyhow!("IndexedDB entry `{}` is not <origin>/<name>", want.rel)
        })?;
        let path = root.join(origin).join(name);
        let bytes = match want.kind {
            IdbEntryKind::Sqlite => {
                std::fs::read(&path).with_context(|| format!("reading back {}", path.display()))?
            }
            // A tar is not reproducible from an unpacked tree byte-for-byte (mtimes), so the blob
            // directory is verified by re-tarring its CONTENT with the same deterministic walk the
            // capture used. Equal input trees give equal bytes; see `dir_tar::tar_dirs`.
            IdbEntryKind::BlobDir => dir_tar::tar_dirs(&[(name.to_string(), path)])?,
        };
        entries.push(IdbEntry {
            rel: want.rel.clone(),
            kind: want.kind,
            bytes,
        });
    }
    entries.sort_by(|a, b| a.rel.cmp(&b.rel));
    Ok(IdbRecords { entries })
}

fn sorted_dir_names(dir: &Path) -> Result<Vec<String>> {
    let mut names = BTreeSet::new();
    for entry in
        std::fs::read_dir(dir).with_context(|| format!("reading directory {}", dir.display()))?
    {
        names.insert(entry?.file_name().to_string_lossy().to_string());
    }
    Ok(names.into_iter().collect())
}

fn is_sidecar(name: &str) -> bool {
    sqlite_copy::SQLITE_SIDECARS
        .iter()
        .any(|suffix| name.ends_with(suffix))
}

/// The 16-byte SQLite header magic. Cheaper and more honest than opening the file and catching an
/// error, which would also fire for a database that is merely locked.
fn is_sqlite_file(path: &Path) -> Result<bool> {
    use std::io::Read;
    let mut header = [0u8; 16];
    let mut file = std::fs::File::open(path)?;
    match file.read_exact(&mut header) {
        Ok(()) => Ok(&header == b"SQLite format 3\0"),
        Err(err) if err.kind() == std::io::ErrorKind::UnexpectedEof => Ok(false),
        Err(err) => Err(err.into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::path::PathBuf;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lobster-idb-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The observed real layout: `https_www.payoneer.com_0/ZU2QUWW27DDP5GWUEU2FLLH4Z5EF65VZ…`, WAL
    /// mode, with content left in the `-wal`.
    fn seed_idb(root: &Path, origin: &str, base32: &str, token: &[u8]) {
        let dir = root.join(origin);
        std::fs::create_dir_all(&dir).unwrap();
        let conn = Connection::open(dir.join(base32)).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute_batch(
            "CREATE TABLE object_data(id INTEGER PRIMARY KEY, value BLOB NOT NULL);",
        )
        .unwrap();
        conn.execute("INSERT INTO object_data VALUES(1, ?1)", [token])
            .unwrap();
        drop(conn);
    }

    #[test]
    fn per_file_vacuum_captures_wal_content_and_never_a_leveldb_allowlist() {
        let root = temp_dir("capture");
        let idb = root.join("IndexedDB");
        seed_idb(
            &idb,
            "https_www.payoneer.com_0",
            "ZU2QUWW27DDP5GWUEU2FLLH4Z5EF65VZSSLF3UKXV54PCLPHHRVA",
            b"payoneer-auth",
        );
        seed_idb(
            &idb,
            "https_justcall.io_0",
            "4TZGTXYPZJRX46PODWC4JHB5EUNGFZCWPE6GFGV6X2YMDX7N4KAA",
            b"justcall-auth",
        );
        // A blob directory beside the databases, which no real profile here has.
        let blob = idb
            .join("https_www.payoneer.com_0")
            .join("ZU2QUWW27DDP5GWUEU2FLLH4Z5EF65VZSSLF3UKXV54PCLPHHRVA.indexeddb.blob");
        std::fs::create_dir_all(blob.join("1")).unwrap();
        std::fs::write(blob.join("1").join("00000001"), b"blob-bytes").unwrap();

        let records = capture(&idb, &root.join("scratch")).unwrap();
        assert_eq!(records.database_count(), 2);
        assert_eq!(records.blob_dir_count(), 1);
        // Sidecars must never become entries of their own.
        assert!(records.entries.iter().all(|e| !e.rel.ends_with("-wal")));
        // Every SQLite entry is a vacuum output, so it opens standalone with the WAL content in it.
        let stage = root.join("stage");
        write_records(&stage, &records).unwrap();
        let restored = stage
            .join("https_www.payoneer.com_0")
            .join("ZU2QUWW27DDP5GWUEU2FLLH4Z5EF65VZSSLF3UKXV54PCLPHHRVA");
        let conn = Connection::open(&restored).unwrap();
        let value: Vec<u8> = conn
            .query_row("SELECT value FROM object_data WHERE id=1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(value, b"payoneer-auth".to_vec());
        drop(conn);
        assert!(
            !restored
                .with_extension("")
                .with_file_name(format!(
                    "{}-wal",
                    restored.file_name().unwrap().to_string_lossy()
                ))
                .exists(),
            "a restored backing store must not carry a -wal"
        );
        assert_eq!(
            std::fs::read(
                stage
                    .join("https_www.payoneer.com_0")
                    .join("ZU2QUWW27DDP5GWUEU2FLLH4Z5EF65VZSSLF3UKXV54PCLPHHRVA.indexeddb.blob")
                    .join("1")
                    .join("00000001")
            )
            .unwrap(),
            b"blob-bytes"
        );

        let reread = read_records(&stage, &records).unwrap();
        assert_eq!(reread, records, "read-back must be byte-identical");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn an_absent_indexeddb_directory_is_the_common_case_not_an_error() {
        let root = temp_dir("absent");
        let records = capture(&root.join("IndexedDB"), &root.join("scratch")).unwrap();
        assert!(records.entries.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    /// If a future engine writes a LevelDB-shaped store here, we must skip it loudly rather than
    /// hand a non-SQLite file to `VACUUM INTO`.
    #[test]
    fn a_non_sqlite_entry_is_skipped_rather_than_vacuumed() {
        let root = temp_dir("leveldb");
        let idb = root.join("IndexedDB");
        let origin = idb.join("https_example.test_0");
        std::fs::create_dir_all(&origin).unwrap();
        std::fs::write(origin.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        std::fs::write(origin.join("000005.ldb"), b"not sqlite").unwrap();
        let records = capture(&idb, &root.join("scratch")).unwrap();
        assert!(records.entries.is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn a_staged_entry_with_a_traversal_path_is_refused() {
        let root = temp_dir("traversal");
        let records = IdbRecords {
            entries: vec![IdbEntry {
                rel: "../../escaped/db".into(),
                kind: IdbEntryKind::Sqlite,
                bytes: b"x".to_vec(),
            }],
        };
        assert!(write_records(&root.join("stage"), &records).is_err());
        assert!(!root.join("escaped").exists());
        std::fs::remove_dir_all(root).unwrap();
    }
}
