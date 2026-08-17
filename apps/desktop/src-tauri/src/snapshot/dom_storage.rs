//! DOM storage: probe the backend, then move exact bytes.
//!
//! ## The trap
//!
//! Lobium 152 stores localStorage and sessionStorage as WAL-mode SQLite FILES at
//! `Default/LocalStorage` and `Default/SessionStorage`. The well-known Chromium layout
//! (`Default/Local Storage/leveldb/`) exists in NONE of the nine real profiles on this machine. Code
//! written against the documented path transfers zero bytes and does not error — the path simply is
//! not there — which is the exact failure class this module exists to prevent.
//!
//! ## Why probe instead of pinning a backend
//!
//! `kDomStorageSqlite`, `kDomStorageSqliteInMemory` and `kDomStorageSqliteNewDatabases` are all
//! `FEATURE_DISABLED_BY_DEFAULT` (`dom_storage/features.cc`). What selects SQLite today is the
//! rollout stage `kUseSqliteForNewDatabases`, and `ShouldUseSqlite(stage, leveldb_exists)` returns
//! `!leveldb_exists` — evaluated PER PROFILE DIRECTORY. So the two backends will coexist in the
//! field, and forcing `--enable-features=DomStorageSqlite` would make an existing LevelDB store
//! invisible with no migration path (`kUseSqliteOnly` returns true unconditionally). Probe, never
//! pin; and a restore that would cross backends is refused out loud rather than transferring
//! nothing quietly.
//!
//! ## Why raw blobs
//!
//! `map_entries.key` and `.value` are BLOBs whose first byte is a Blink `StorageFormat` tag, and
//! `value_compression_type` names the codec of the rest. We copy all three verbatim and never decode
//! UTF-16/Latin-1 and never decompress. That buys byte-exact round-trip, immunity to a future third
//! `StorageFormat` or fourth compression type, and no zstd/snappy on the restore path at all.
//! `storage_key` is a serialized `blink::StorageKey` that may be partitioned (a real profile holds
//! `https://a2857433013137.cdn.optimizely.com/^0https://payoneer.com`); it is opaque bytes here and
//! is never parsed.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

use super::sqlite_copy;

/// DOM-storage schema version we know how to read and write, from `local_storage_sqlite.cc`
/// (`kCurrentSchemaVersion = 1`) and confirmed on disk in 9/9 profiles.
const DOM_SCHEMA_VERSION: &str = "1";

/// Which store, and therefore which of the two on-disk shapes applies.
///
/// The shapes are NOT interchangeable, and this is the correction the design's single capture query
/// needs: `LocalStorage` has `maps` + `map_entries` + `meta`, while `SessionStorage` has
/// `session_metadata` + `map_entries` + `meta` and **no `maps` table at all** (verified in
/// `session_storage_sqlite.cc::CreateSchema` and in every real profile). One shared `FROM maps` query
/// throws `no such table: maps` on every sessionStorage file in the field.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DomStore {
    Local,
    Session,
}

impl DomStore {
    pub fn from_artifact_id(id: &str) -> Option<Self> {
        match id {
            "localstorage" => Some(Self::Local),
            "sessionstorage" => Some(Self::Session),
            _ => None,
        }
    }

    /// `GetSqlitePath` in `dom_storage_database.cc`.
    fn sqlite_rel(self) -> &'static str {
        match self {
            Self::Local => "Default/LocalStorage",
            Self::Session => "Default/SessionStorage",
        }
    }

    /// `GetLevelDbPath` in `dom_storage_database.cc`.
    fn leveldb_rel(self) -> &'static str {
        match self {
            Self::Local => "Default/Local Storage/leveldb",
            Self::Session => "Default/Session Storage",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum DomBackend {
    Sqlite,
    LevelDb,
    /// Neither exists. A profile that has never had a DOM-storage write.
    Empty,
    /// Both exist. We refuse rather than guess, because guessing wrong is a silent logout.
    Ambiguous,
}

impl DomBackend {
    pub fn label(self) -> &'static str {
        match self {
            Self::Sqlite => "sqlite",
            Self::LevelDb => "leveldb",
            Self::Empty => "empty",
            Self::Ambiguous => "ambiguous",
        }
    }
}

/// Classify a profile directory's DOM-storage backend.
///
/// An EMPTY `Local Storage/leveldb/` directory counts as absent, matching
/// `CheckOnDiskLevelDbState`: "A missing directory yields an error and an empty directory yields an
/// empty list. Both mean there is no database on disk." Without that rule a leftover empty directory
/// beside a live SQLite file would classify as `Ambiguous` and refuse a capture Chromium itself
/// would consider unambiguous.
pub fn detect_backend(udd: &Path, store: DomStore) -> DomBackend {
    let sqlite = sqlite_path(udd, store);
    let leveldb = leveldb_dir(udd, store);
    let has_sqlite = sqlite.is_file();
    let has_leveldb = leveldb
        .read_dir()
        .map(|mut entries| entries.next().is_some())
        .unwrap_or(false);
    match (has_sqlite, has_leveldb) {
        (true, true) => DomBackend::Ambiguous,
        (true, false) => DomBackend::Sqlite,
        (false, true) => DomBackend::LevelDb,
        (false, false) => DomBackend::Empty,
    }
}

pub fn sqlite_path(udd: &Path, store: DomStore) -> PathBuf {
    let mut out = udd.to_path_buf();
    for part in store.sqlite_rel().split('/') {
        out.push(part);
    }
    out
}

pub fn leveldb_dir(udd: &Path, store: DomStore) -> PathBuf {
    let mut out = udd.to_path_buf();
    for part in store.leveldb_rel().split('/') {
        out.push(part);
    }
    out
}

/// One `map_entries` row, byte-for-byte.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomEntry {
    /// Exact BLOB, leading `StorageFormat` byte intact.
    pub key: Vec<u8>,
    pub value: Vec<u8>,
    /// `value_compression_type` verbatim. Never interpreted.
    pub compression: i64,
}

/// The entries of one map. Kept keyed by `map_id` rather than flattened into its areas because
/// sessionStorage namespaces SHARE maps — that is how a cloned tab's storage works — and flattening
/// would both duplicate the bytes and lose the sharing on restore.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomMap {
    pub map_id: i64,
    pub entries: Vec<DomEntry>,
}

/// A storage area: one `maps` row (localStorage) or one `session_metadata` row (sessionStorage).
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomArea {
    pub map_id: i64,
    /// Serialized `blink::StorageKey`. Opaque.
    pub storage_key: Vec<u8>,
    /// sessionStorage only: the SNSS namespace id.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub session_id: Option<String>,
    /// localStorage only.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_accessed: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_modified: Option<i64>,
}

/// The SQLite-backend payload. `total_size` is deliberately absent: it is nullable, quota-only, and
/// recomputed by `StorageAreaImpl`, so carrying a stale value would be worse than carrying none.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DomRecords {
    pub store: DomStore,
    /// `meta` rows verbatim, sorted by key.
    pub meta: Vec<(String, String)>,
    /// Sorted by `map_id`; entries within each map sorted by key bytes.
    pub maps: Vec<DomMap>,
    /// Sorted by (`session_id`, `storage_key`).
    pub areas: Vec<DomArea>,
}

impl DomRecords {
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::into_writer(self, &mut out).context("encoding DOM storage records")?;
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ciborium::from_reader(bytes).context("decoding DOM storage records")
    }

    pub fn key_count(&self) -> u64 {
        self.maps.iter().map(|m| m.entries.len() as u64).sum()
    }

    pub fn area_count(&self) -> u64 {
        self.areas.len() as u64
    }
}

/// Read a DOM-storage database into records. `src` is the LIVE file; it is `VACUUM INTO`'d to
/// `scratch` first so the `-wal` is accounted for and nothing reads a torn page set.
pub fn capture(src: &Path, scratch: &Path, store: DomStore) -> Result<DomRecords> {
    sqlite_copy::vacuum_into(src, scratch)?;
    read_records(scratch, store)
}

/// Read records out of an already-clean (vacuumed or freshly built) database.
pub fn read_records(path: &Path, store: DomStore) -> Result<DomRecords> {
    let conn = Connection::open(path)
        .with_context(|| format!("opening DOM storage database {}", path.display()))?;
    let tables = table_names(&conn)?;
    if !tables.iter().any(|t| t == "meta") {
        // A DOM-storage file with no `meta` table has never been initialised. Emitting an empty
        // record set (rather than failing) is what keeps a fresh profile capturable.
        return Ok(DomRecords {
            store,
            meta: Vec::new(),
            maps: Vec::new(),
            areas: Vec::new(),
        });
    }

    let mut meta: Vec<(String, String)> = conn
        .prepare("SELECT key, value FROM meta")?
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<rusqlite::Result<_>>()?;
    meta.sort();
    if let Some((_, version)) = meta.iter().find(|(k, _)| k == "version") {
        if version != DOM_SCHEMA_VERSION {
            bail!(
                "DOM storage schema version {version} is not the {DOM_SCHEMA_VERSION} this build \
                 knows how to rebuild; refusing to capture bytes we could not restore"
            );
        }
    }

    let areas = match store {
        DomStore::Local => {
            if !tables.iter().any(|t| t == "maps") {
                bail!(
                    "{} has a meta table but no `maps` table — this is the sessionStorage shape in a \
                     localStorage slot",
                    path.display()
                );
            }
            let mut areas: Vec<DomArea> = conn
                .prepare(
                    "SELECT row_id, storage_key, last_accessed, last_modified FROM maps \
                     ORDER BY storage_key",
                )?
                .query_map([], |row| {
                    Ok(DomArea {
                        map_id: row.get(0)?,
                        storage_key: row.get(1)?,
                        session_id: None,
                        last_accessed: row.get(2)?,
                        last_modified: row.get(3)?,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            areas.sort_by(|a, b| a.storage_key.cmp(&b.storage_key));
            areas
        }
        DomStore::Session => {
            if !tables.iter().any(|t| t == "session_metadata") {
                bail!(
                    "{} has a meta table but no `session_metadata` table",
                    path.display()
                );
            }
            let mut areas: Vec<DomArea> = conn
                .prepare("SELECT session_id, storage_key, map_id FROM session_metadata")?
                .query_map([], |row| {
                    Ok(DomArea {
                        map_id: row.get(2)?,
                        storage_key: row.get(1)?,
                        session_id: Some(row.get(0)?),
                        last_accessed: None,
                        last_modified: None,
                    })
                })?
                .collect::<rusqlite::Result<_>>()?;
            areas.sort_by(|a, b| {
                (&a.session_id, &a.storage_key).cmp(&(&b.session_id, &b.storage_key))
            });
            areas
        }
    };

    let mut maps: Vec<DomMap> = Vec::new();
    let mut stmt = conn.prepare(
        "SELECT map_id, key, value, value_compression_type FROM map_entries ORDER BY map_id, key",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((
            row.get::<_, i64>(0)?,
            DomEntry {
                key: row.get(1)?,
                value: row.get(2)?,
                compression: row.get(3)?,
            },
        ))
    })?;
    for row in rows {
        let (map_id, entry) = row?;
        match maps.last_mut() {
            Some(last) if last.map_id == map_id => last.entries.push(entry),
            _ => maps.push(DomMap {
                map_id,
                entries: vec![entry],
            }),
        }
    }

    Ok(DomRecords {
        store,
        meta,
        maps,
        areas,
    })
}

/// Build a fresh DOM-storage database at `dst` from `records`, using the DDL verified against
/// `local_storage_sqlite.cc`, `session_storage_sqlite.cc`, `map_entries_table.cc` and
/// `sql/meta_table.cc`. `dst` must not exist.
pub fn write_records(dst: &Path, records: &DomRecords) -> Result<()> {
    if dst.exists() {
        bail!("DOM storage target {} already exists", dst.display());
    }
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let conn = Connection::open(dst)?;
    // WAL, because that is what `GetDatabaseOptions()` opens with. Not load-bearing — `sql::Database`
    // executes `PRAGMA journal_mode=WAL` itself at open (`sql/database.cc:2340`) — but a database we
    // hand Chromium should differ from one it made only in its contents.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(
        "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
         CREATE TABLE map_entries(\
             map_id INTEGER NOT NULL,\
             value_compression_type INTEGER NOT NULL,\
             key BLOB NOT NULL,\
             value BLOB NOT NULL,\
             PRIMARY KEY(map_id, key)\
         ) WITHOUT ROWID;",
    )?;
    match records.store {
        DomStore::Local => conn.execute_batch(
            "CREATE TABLE maps(\
                 row_id INTEGER PRIMARY KEY AUTOINCREMENT,\
                 storage_key BLOB NOT NULL,\
                 last_accessed INTEGER,\
                 last_modified INTEGER,\
                 total_size INTEGER\
             );
             CREATE UNIQUE INDEX maps_by_storage_key ON maps(storage_key);",
        )?,
        DomStore::Session => conn.execute_batch(
            "CREATE TABLE session_metadata(\
                 session_id TEXT NOT NULL,\
                 storage_key BLOB NOT NULL,\
                 map_id INTEGER NOT NULL,\
                 PRIMARY KEY(session_id, storage_key)\
             ) WITHOUT ROWID;",
        )?,
    }

    // The three rows `MetaTable::Init` writes for a new database, in its own order and values
    // (`mmap_status = kMmapSuccess = -1`). Captured rows win when present so a future extra key
    // survives a round trip.
    let mut meta = records.meta.clone();
    if meta.is_empty() {
        meta = vec![
            ("mmap_status".into(), "-1".into()),
            ("version".into(), DOM_SCHEMA_VERSION.into()),
            ("last_compatible_version".into(), DOM_SCHEMA_VERSION.into()),
        ];
        meta.sort();
    }
    for (key, value) in &meta {
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?1, ?2)",
            params![key, value],
        )?;
    }

    for area in &records.areas {
        match records.store {
            // Explicit `row_id` so `map_entries.map_id` still resolves; AUTOINCREMENT's
            // `sqlite_sequence` follows the highest inserted id on its own.
            DomStore::Local => conn.execute(
                "INSERT INTO maps(row_id, storage_key, last_accessed, last_modified, total_size) \
                 VALUES(?1, ?2, ?3, ?4, NULL)",
                params![
                    area.map_id,
                    area.storage_key,
                    area.last_accessed,
                    area.last_modified
                ],
            )?,
            DomStore::Session => conn.execute(
                "INSERT INTO session_metadata(session_id, storage_key, map_id) VALUES(?1, ?2, ?3)",
                params![
                    area.session_id.as_deref().unwrap_or_default(),
                    area.storage_key,
                    area.map_id
                ],
            )?,
        };
    }
    for map in &records.maps {
        for entry in &map.entries {
            conn.execute(
                "INSERT INTO map_entries(map_id, value_compression_type, key, value) \
                 VALUES(?1, ?2, ?3, ?4)",
                params![map.map_id, entry.compression, entry.key, entry.value],
            )?;
        }
    }
    // Fold the WAL back into the main file so the artifact is a single self-contained file; leaving a
    // `-wal` beside it would recreate the very trap this module exists to close. `query_row`, because
    // `wal_checkpoint` returns a row and is not a settable pragma.
    conn.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |_| Ok(()))?;
    conn.close().map_err(|(_, e)| e)?;
    let wal = dst.with_file_name(format!(
        "{}-wal",
        dst.file_name().unwrap_or_default().to_string_lossy()
    ));
    let shm = dst.with_file_name(format!(
        "{}-shm",
        dst.file_name().unwrap_or_default().to_string_lossy()
    ));
    let _ = std::fs::remove_file(wal);
    let _ = std::fs::remove_file(shm);
    Ok(())
}

/// Refuse a restore that would put one backend's payload where the other backend lives.
///
/// Chromium has no migration between the two stores (`TODO crbug.com/377242771`), so the outcomes of
/// getting this wrong are: a SQLite payload written beside a live LevelDB store, which the profile
/// keeps ignoring — a zero-byte transfer that reports success — or a LevelDB directory dropped next
/// to a SQLite file, same result. Naming it is the entire fix.
pub fn assert_backend_match(
    captured: DomBackend,
    target: DomBackend,
    store: DomStore,
) -> Result<()> {
    if target == DomBackend::Ambiguous {
        bail!(
            "DOM_BACKEND_AMBIGUOUS: the target profile has BOTH a {} file and a non-empty {} \
             directory; refusing to restore {:?} storage into a profile whose backend cannot be \
             determined",
            store.sqlite_rel(),
            store.leveldb_rel(),
            store
        );
    }
    // An empty target takes either backend: nothing is there to be shadowed.
    if target == DomBackend::Empty || captured == target {
        return Ok(());
    }
    bail!(
        "DOM_BACKEND_MISMATCH: snapshot holds {:?} storage in the `{}` backend but the target \
         profile uses `{}`. Chromium has no migration between them, so restoring would transfer \
         nothing while reporting success. Restore into a profile on the same backend, or clear the \
         target's DOM storage first.",
        store,
        captured.label(),
        target.label()
    )
}

fn table_names(conn: &Connection) -> Result<Vec<String>> {
    Ok(conn
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")?
        .query_map([], |row| row.get(0))?
        .collect::<rusqlite::Result<_>>()?)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(tag: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("lobster-dom-{tag}-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    /// The real localStorage shape, including the leading `\x01` StorageFormat byte on both key and
    /// value that a real profile shows (`\x011procard_device_session_v1` ->
    /// `\x018c091afb-6da4-…`), and a partitioned storage key of the form observed on disk.
    fn seed_local_storage(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.pragma_update(None, "wal_autocheckpoint", 0).unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
             INSERT INTO meta VALUES('mmap_status','-1'),('version','1'),('last_compatible_version','1');
             CREATE TABLE maps(row_id INTEGER PRIMARY KEY AUTOINCREMENT, storage_key BLOB NOT NULL,\
                 last_accessed INTEGER, last_modified INTEGER, total_size INTEGER);
             CREATE UNIQUE INDEX maps_by_storage_key ON maps(storage_key);
             CREATE TABLE map_entries(map_id INTEGER NOT NULL, value_compression_type INTEGER NOT NULL,\
                 key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(map_id, key)) WITHOUT ROWID;",
        )
        .unwrap();
        conn.execute(
            "INSERT INTO maps(row_id, storage_key, last_accessed, last_modified, total_size) \
             VALUES(1, ?1, 13429403387583785, 13429403387583785, 99)",
            params![b"https://1procard.com/".to_vec()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO maps(row_id, storage_key, last_accessed, last_modified, total_size) \
             VALUES(2, ?1, NULL, NULL, NULL)",
            params![b"https://a2857433013137.cdn.optimizely.com/^0https://payoneer.com".to_vec()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO map_entries VALUES(1, 0, ?1, ?2)",
            params![
                b"\x011procard_device_session_v1".to_vec(),
                b"\x018c091afb-6da4-4743-a124-e70ee5efaf70".to_vec()
            ],
        )
        .unwrap();
        // A compressed value with a non-zero codec id and non-UTF-8 bytes: proof that nothing on the
        // path decodes or re-encodes anything.
        conn.execute(
            "INSERT INTO map_entries VALUES(2, 2, ?1, ?2)",
            params![
                b"\x00r\x00c\x00:\x00:\x00a".to_vec(),
                vec![0x00u8, 0xff, 0xfe, 0x01, 0x80, 0x7f]
            ],
        )
        .unwrap();
        drop(conn);
    }

    fn seed_session_storage(path: &Path) {
        let conn = Connection::open(path).unwrap();
        conn.pragma_update(None, "journal_mode", "WAL").unwrap();
        conn.execute_batch(
            "CREATE TABLE meta(key LONGVARCHAR NOT NULL UNIQUE PRIMARY KEY, value LONGVARCHAR);
             INSERT INTO meta VALUES('mmap_status','-1'),('version','1'),('last_compatible_version','1');
             CREATE TABLE session_metadata(session_id TEXT NOT NULL, storage_key BLOB NOT NULL,\
                 map_id INTEGER NOT NULL, PRIMARY KEY(session_id, storage_key)) WITHOUT ROWID;
             CREATE TABLE map_entries(map_id INTEGER NOT NULL, value_compression_type INTEGER NOT NULL,\
                 key BLOB NOT NULL, value BLOB NOT NULL, PRIMARY KEY(map_id, key)) WITHOUT ROWID;",
        )
        .unwrap();
        // Two namespaces sharing ONE map — a cloned tab. Flattening by area would duplicate the
        // bytes and lose the sharing.
        conn.execute(
            "INSERT INTO session_metadata VALUES('ns-1', ?1, 7)",
            params![b"https://example.test/".to_vec()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO session_metadata VALUES('ns-2', ?1, 7)",
            params![b"https://example.test/".to_vec()],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO map_entries VALUES(7, 0, ?1, ?2)",
            params![b"\x01tab-token".to_vec(), b"\x01abc123".to_vec()],
        )
        .unwrap();
        drop(conn);
    }

    #[test]
    fn probe_classifies_both_backends_and_refuses_an_ambiguous_profile() {
        let udd = temp_dir("probe");
        std::fs::create_dir_all(udd.join("Default")).unwrap();
        assert_eq!(detect_backend(&udd, DomStore::Local), DomBackend::Empty);

        seed_local_storage(&udd.join("Default").join("LocalStorage"));
        assert_eq!(detect_backend(&udd, DomStore::Local), DomBackend::Sqlite);

        // An EMPTY leveldb dir is "no database on disk" to Chromium, so it must not make us refuse.
        let leveldb = udd.join("Default").join("Local Storage").join("leveldb");
        std::fs::create_dir_all(&leveldb).unwrap();
        assert_eq!(detect_backend(&udd, DomStore::Local), DomBackend::Sqlite);

        std::fs::write(leveldb.join("CURRENT"), b"MANIFEST-000001\n").unwrap();
        assert_eq!(detect_backend(&udd, DomStore::Local), DomBackend::Ambiguous);

        std::fs::remove_file(udd.join("Default").join("LocalStorage")).unwrap();
        assert_eq!(detect_backend(&udd, DomStore::Local), DomBackend::LevelDb);
        std::fs::remove_dir_all(udd).unwrap();
    }

    #[test]
    fn local_storage_round_trips_byte_for_byte_including_partitioned_keys() {
        let dir = temp_dir("local");
        let src = dir.join("LocalStorage");
        seed_local_storage(&src);

        let captured = capture(&src, &dir.join("scratch.db"), DomStore::Local).unwrap();
        assert_eq!(captured.area_count(), 2);
        assert_eq!(captured.key_count(), 2);
        assert!(captured
            .areas
            .iter()
            .any(|a| a.storage_key.ends_with(b"^0https://payoneer.com")));

        let rebuilt = dir.join("rebuilt");
        write_records(&rebuilt, &captured).unwrap();
        sqlite_copy::integrity_check(&rebuilt).unwrap();
        assert!(
            !dir.join("rebuilt-wal").exists(),
            "a rebuilt store must be one self-contained file"
        );
        let reread = read_records(&rebuilt, DomStore::Local).unwrap();
        assert_eq!(reread, captured, "read-back must be identical");

        // The exact bytes, including the StorageFormat tag and the untouched compression id.
        let entry = &reread.maps.iter().find(|m| m.map_id == 2).unwrap().entries[0];
        assert_eq!(entry.compression, 2);
        assert_eq!(entry.value, vec![0x00, 0xff, 0xfe, 0x01, 0x80, 0x7f]);
        let session = &reread.maps.iter().find(|m| m.map_id == 1).unwrap().entries[0];
        assert_eq!(session.key, b"\x011procard_device_session_v1".to_vec());

        // `total_size` is intentionally dropped, not carried stale.
        let conn = Connection::open(&rebuilt).unwrap();
        let sizes: Vec<Option<i64>> = conn
            .prepare("SELECT total_size FROM maps ORDER BY row_id")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert!(sizes.iter().all(Option::is_none));
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// The design's single capture query reads `FROM maps`, which does not exist in a sessionStorage
    /// file. This is the test that pins the two-shape handling.
    #[test]
    fn session_storage_has_no_maps_table_and_preserves_shared_namespaces() {
        let dir = temp_dir("session");
        let src = dir.join("SessionStorage");
        seed_session_storage(&src);

        let conn = Connection::open(&src).unwrap();
        let tables = table_names(&conn).unwrap();
        drop(conn);
        assert!(
            !tables.iter().any(|t| t == "maps"),
            "the sessionStorage shape must not have a maps table: {tables:?}"
        );

        let captured = capture(&src, &dir.join("scratch.db"), DomStore::Session).unwrap();
        assert_eq!(captured.areas.len(), 2, "two namespaces");
        assert_eq!(captured.maps.len(), 1, "sharing one map");
        assert!(captured.areas.iter().all(|a| a.map_id == 7));

        let rebuilt = dir.join("rebuilt");
        write_records(&rebuilt, &captured).unwrap();
        let reread = read_records(&rebuilt, DomStore::Session).unwrap();
        assert_eq!(reread, captured);
        // Reading a sessionStorage file as localStorage must fail loudly, not return empty.
        assert!(read_records(&rebuilt, DomStore::Local).is_err());
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn cross_backend_restore_is_refused_with_a_named_error() {
        let err = assert_backend_match(DomBackend::Sqlite, DomBackend::LevelDb, DomStore::Local)
            .unwrap_err()
            .to_string();
        assert!(err.contains("DOM_BACKEND_MISMATCH"), "{err}");
        let err = assert_backend_match(DomBackend::LevelDb, DomBackend::Sqlite, DomStore::Session)
            .unwrap_err()
            .to_string();
        assert!(err.contains("DOM_BACKEND_MISMATCH"), "{err}");
        let err = assert_backend_match(DomBackend::Sqlite, DomBackend::Ambiguous, DomStore::Local)
            .unwrap_err()
            .to_string();
        assert!(err.contains("DOM_BACKEND_AMBIGUOUS"), "{err}");
        // Matching backends, and a target with nothing to shadow, both proceed.
        assert_backend_match(DomBackend::Sqlite, DomBackend::Sqlite, DomStore::Local).unwrap();
        assert_backend_match(DomBackend::LevelDb, DomBackend::Empty, DomStore::Local).unwrap();
    }

    #[test]
    fn a_schema_version_we_cannot_rebuild_is_refused_at_capture() {
        let dir = temp_dir("schema");
        let src = dir.join("LocalStorage");
        seed_local_storage(&src);
        let conn = Connection::open(&src).unwrap();
        conn.execute("UPDATE meta SET value='2' WHERE key='version'", [])
            .unwrap();
        drop(conn);
        let err = capture(&src, &dir.join("scratch.db"), DomStore::Local)
            .unwrap_err()
            .to_string();
        assert!(err.contains("schema version 2"), "{err}");
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn an_uninitialised_store_captures_as_empty_rather_than_failing() {
        let dir = temp_dir("fresh");
        let src = dir.join("LocalStorage");
        // What `prf_6d04dd17` looks like without its -wal: a database with no tables at all.
        Connection::open(&src).unwrap();
        let captured = capture(&src, &dir.join("scratch.db"), DomStore::Local).unwrap();
        assert_eq!(captured.key_count(), 0);
        assert!(captured.meta.is_empty());
        let rebuilt = dir.join("rebuilt");
        write_records(&rebuilt, &captured).unwrap();
        // With no captured meta we write the three rows MetaTable::Init would, so the file Chromium
        // opens is a valid v1 store rather than a headless one.
        let reread = read_records(&rebuilt, DomStore::Local).unwrap();
        assert_eq!(
            reread.meta,
            vec![
                ("last_compatible_version".to_string(), "1".to_string()),
                ("mmap_status".to_string(), "-1".to_string()),
                ("version".to_string(), "1".to_string()),
            ]
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn records_encoding_is_deterministic() {
        let dir = temp_dir("cbor");
        let src = dir.join("LocalStorage");
        seed_local_storage(&src);
        let a = capture(&src, &dir.join("s1.db"), DomStore::Local).unwrap();
        let b = capture(&src, &dir.join("s2.db"), DomStore::Local).unwrap();
        assert_eq!(a.encode().unwrap(), b.encode().unwrap());
        assert_eq!(DomRecords::decode(&a.encode().unwrap()).unwrap(), a);
        std::fs::remove_dir_all(dir).unwrap();
    }
}
