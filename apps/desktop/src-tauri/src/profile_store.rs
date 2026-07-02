//! Local profile store (rusqlite / bundled SQLite).
//!
//! The desktop agent keeps an offline-first copy of every profile so it can launch
//! engines without the cloud. Columns mirror `@lobster/shared-types` `Profile`; the
//! JSON-shaped fields (fingerprint overrides, proxy, tags) are stored as TEXT blobs
//! and (de)serialized at the boundary.
//!
//! LATER: cookie/localStorage/IndexedDB blobs are encrypted at rest with a per-install
//! AES key (Day 6), and rows sync to the backend for team sharing (Day 7). None of that
//! exists yet — this is the schema + connection bootstrap only.

use std::path::Path;

use anyhow::Result;
use rusqlite::Connection;

/// SQLite schema for the local profile catalog. `IF NOT EXISTS` keeps `init` idempotent.
pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS profiles (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    engine                 TEXT NOT NULL,          -- shared-types EngineKind
    os                     TEXT NOT NULL,          -- shared-types OsFamily
    fingerprint_seed       TEXT NOT NULL,          -- lowercase hex seed
    fingerprint_overrides  TEXT,                   -- JSON: FingerprintOverrides
    proxy                  TEXT,                   -- JSON: ProxyConfig
    tags                   TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
    folder                 TEXT,
    notes                  TEXT,
    status                 TEXT NOT NULL DEFAULT 'idle', -- shared-types ProfileStatus
    created_at             TEXT NOT NULL,          -- ISO-8601
    updated_at             TEXT NOT NULL           -- ISO-8601
);
";

/// Open (creating if needed) the SQLite database at `db_path` and apply the schema.
/// Returns the live connection for callers to run queries against.
pub fn init<P: AsRef<Path>>(db_path: P) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    // Concurrent reads while the agent writes; recommended for a long-lived local store.
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}
