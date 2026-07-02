//! Local profile store (rusqlite / bundled SQLite).
//!
//! The desktop agent keeps an offline-first copy of every profile so it can launch engines
//! without the cloud. Columns mirror `@lobster/shared-types` `Profile`; the JSON-shaped fields
//! (fingerprint overrides, proxy, tags) are stored as TEXT and (de)serialized at the boundary.
//!
//! LATER: cookie/localStorage/IndexedDB blobs are encrypted at rest with a per-install AES key,
//! and rows sync to the backend for team sharing. This module owns schema + CRUD.

use std::path::Path;

use anyhow::Result;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

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

/// A profile row, serialized to the UI in the exact shape of `@lobster/shared-types` `Profile`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Profile {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub os: String,
    pub fingerprint_seed: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<serde_json::Value>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub status: String,
    pub created_at: String,
    pub updated_at: String,
}

/// Fields accepted when creating a profile (mirrors shared-types `CreateProfileInput`).
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProfileInput {
    pub name: String,
    pub engine: String,
    pub os: String,
    #[serde(default)]
    pub fingerprint_seed: Option<String>,
    #[serde(default)]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(default)]
    pub proxy: Option<serde_json::Value>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Patchable fields on an existing profile. Identity (`id`, `fingerprint_seed`) and audit fields
/// are immutable here; unknown keys (e.g. a sent `fingerprintSeed`) are ignored by serde.
#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateProfilePatch {
    #[serde(default)]
    pub name: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub os: Option<String>,
    #[serde(default)]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(default)]
    pub proxy: Option<serde_json::Value>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
    #[serde(default)]
    pub folder: Option<String>,
    #[serde(default)]
    pub notes: Option<String>,
}

/// Open (creating if needed) the SQLite database at `db_path` and apply the schema.
pub fn init<P: AsRef<Path>>(db_path: P) -> Result<Connection> {
    let conn = Connection::open(db_path)?;
    conn.pragma_update(None, "journal_mode", "WAL")?;
    conn.execute_batch(SCHEMA)?;
    Ok(conn)
}

fn row_to_profile(row: &Row) -> rusqlite::Result<Profile> {
    let overrides_json: Option<String> = row.get("fingerprint_overrides")?;
    let proxy_json: Option<String> = row.get("proxy")?;
    let tags_json: String = row.get("tags")?;
    Ok(Profile {
        id: row.get("id")?,
        name: row.get("name")?,
        engine: row.get("engine")?,
        os: row.get("os")?,
        fingerprint_seed: row.get("fingerprint_seed")?,
        fingerprint_overrides: overrides_json.and_then(|s| serde_json::from_str(&s).ok()),
        proxy: proxy_json.and_then(|s| serde_json::from_str(&s).ok()),
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        folder: row.get("folder")?,
        notes: row.get("notes")?,
        status: row.get("status")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

/// A fresh 128-bit lowercase-hex fingerprint seed (32 hex chars).
fn new_seed() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn to_text(value: &Option<serde_json::Value>) -> Option<String> {
    value.as_ref().map(|v| v.to_string())
}

pub fn list(conn: &Connection) -> Result<Vec<Profile>> {
    let mut stmt = conn.prepare("SELECT * FROM profiles ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], row_to_profile)?;
    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row?);
    }
    Ok(profiles)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Profile>> {
    let mut stmt = conn.prepare("SELECT * FROM profiles WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], row_to_profile)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn create(conn: &Connection, input: CreateProfileInput) -> Result<Profile> {
    let id = format!("prf_{}", uuid::Uuid::new_v4().simple());
    // Every profile gets a UNIQUE seed unless one is explicitly supplied — never a shared constant.
    let seed = input.fingerprint_seed.unwrap_or_else(new_seed);
    let tags = input.tags.unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO profiles \
         (id, name, engine, os, fingerprint_seed, fingerprint_overrides, proxy, tags, folder, notes, status, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13)",
        params![
            id,
            input.name,
            input.engine,
            input.os,
            seed,
            to_text(&input.fingerprint_overrides),
            to_text(&input.proxy),
            serde_json::to_string(&tags)?,
            input.folder,
            input.notes,
            "idle",
            now,
            now,
        ],
    )?;

    Ok(get(conn, &id)?.expect("row was just inserted"))
}

pub fn update(conn: &Connection, id: &str, patch: UpdateProfilePatch) -> Result<Option<Profile>> {
    let existing = match get(conn, id)? {
        Some(profile) => profile,
        None => return Ok(None),
    };

    let name = patch.name.unwrap_or(existing.name);
    let engine = patch.engine.unwrap_or(existing.engine);
    let os = patch.os.unwrap_or(existing.os);
    let overrides = if patch.fingerprint_overrides.is_some() {
        patch.fingerprint_overrides
    } else {
        existing.fingerprint_overrides
    };
    let proxy = if patch.proxy.is_some() {
        patch.proxy
    } else {
        existing.proxy
    };
    let tags = patch.tags.unwrap_or(existing.tags);
    let folder = if patch.folder.is_some() {
        patch.folder
    } else {
        existing.folder
    };
    let notes = if patch.notes.is_some() {
        patch.notes
    } else {
        existing.notes
    };
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE profiles SET name = ?2, engine = ?3, os = ?4, fingerprint_overrides = ?5, \
         proxy = ?6, tags = ?7, folder = ?8, notes = ?9, updated_at = ?10 WHERE id = ?1",
        params![
            id,
            name,
            engine,
            os,
            to_text(&overrides),
            to_text(&proxy),
            serde_json::to_string(&tags)?,
            folder,
            notes,
            now,
        ],
    )?;

    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<bool> {
    let affected = conn.execute("DELETE FROM profiles WHERE id = ?1", params![id])?;
    Ok(affected > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch(SCHEMA).unwrap();
        conn
    }

    fn input(name: &str) -> CreateProfileInput {
        CreateProfileInput {
            name: name.to_string(),
            engine: "chromium".to_string(),
            os: "windows".to_string(),
            fingerprint_seed: None,
            fingerprint_overrides: None,
            proxy: None,
            tags: Some(vec!["a".to_string()]),
            folder: None,
            notes: None,
        }
    }

    #[test]
    fn create_assigns_unique_seeds() {
        let conn = mem();
        let a = create(&conn, input("A")).unwrap();
        let b = create(&conn, input("B")).unwrap();
        assert_eq!(a.fingerprint_seed.len(), 32);
        assert_ne!(
            a.fingerprint_seed, b.fingerprint_seed,
            "each profile needs its own seed"
        );
        assert_eq!(list(&conn).unwrap().len(), 2);
    }

    #[test]
    fn update_persists_engine_os_and_overrides() {
        let conn = mem();
        let created = create(&conn, input("C")).unwrap();
        let patch = UpdateProfilePatch {
            name: None,
            engine: Some("kernel".to_string()),
            os: Some("macos".to_string()),
            fingerprint_overrides: Some(
                serde_json::json!({ "locale": { "timezone": "Europe/Berlin" } }),
            ),
            proxy: None,
            tags: None,
            folder: None,
            notes: None,
        };
        let updated = update(&conn, &created.id, patch).unwrap().unwrap();
        assert_eq!(updated.engine, "kernel");
        assert_eq!(updated.os, "macos");
        assert!(updated.fingerprint_overrides.is_some());
        assert_eq!(
            updated.fingerprint_seed, created.fingerprint_seed,
            "seed is immutable"
        );
    }

    #[test]
    fn delete_removes_the_row() {
        let conn = mem();
        let created = create(&conn, input("D")).unwrap();
        assert!(delete(&conn, &created.id).unwrap());
        assert!(get(&conn, &created.id).unwrap().is_none());
        assert!(!delete(&conn, "missing").unwrap());
    }
}
