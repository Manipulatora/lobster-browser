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
use argon2::Argon2;
use password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

/// SQLite schema for the local profile catalog. `IF NOT EXISTS` keeps `init` idempotent.
pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS profiles (
    id                     TEXT PRIMARY KEY,
    name                   TEXT NOT NULL,
    engine                 TEXT NOT NULL,          -- shared-types EngineKind
    os                     TEXT NOT NULL,          -- shared-types OsFamily
    os_version             TEXT,
    fingerprint_seed       TEXT NOT NULL,          -- lowercase hex seed
    fingerprint_overrides  TEXT,                   -- JSON: FingerprintOverrides
    proxy                  TEXT,                   -- JSON: ProxyConfig
    proxy_id               TEXT,
    template_id            TEXT,
    cookies_import         TEXT,                   -- JSON: CookieImportDraft
    extensions             TEXT,                   -- JSON: BrowserExtensionRef[]
    tags                   TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
    folder                 TEXT,
    notes                  TEXT,
    status                 TEXT NOT NULL DEFAULT 'idle', -- shared-types ProfileStatus
    password_hash          TEXT,
    trashed_at             TEXT,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub fingerprint_seed: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub template_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookies_import: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<serde_json::Value>,
    pub tags: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub folder: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub notes: Option<String>,
    pub status: String,
    pub password_protected: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub trashed_at: Option<String>,
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
    pub os_version: Option<String>,
    #[serde(default)]
    pub fingerprint_seed: Option<String>,
    #[serde(default)]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(default)]
    pub proxy: Option<serde_json::Value>,
    #[serde(default)]
    pub proxy_id: Option<String>,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub cookies_import: Option<serde_json::Value>,
    #[serde(default)]
    pub extensions: Option<serde_json::Value>,
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
    pub os_version: Option<String>,
    #[serde(default)]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(default)]
    pub proxy: Option<serde_json::Value>,
    #[serde(default)]
    pub proxy_id: Option<String>,
    #[serde(default)]
    pub template_id: Option<String>,
    #[serde(default)]
    pub cookies_import: Option<serde_json::Value>,
    #[serde(default)]
    pub extensions: Option<serde_json::Value>,
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
    migrate(&conn)?;
    Ok(conn)
}

fn ensure_column(conn: &Connection, column: &str, ddl: &str) -> Result<()> {
    let mut stmt = conn.prepare("PRAGMA table_info(profiles)")?;
    let columns = stmt.query_map([], |row| row.get::<_, String>(1))?;
    for existing in columns {
        if existing? == column {
            return Ok(());
        }
    }
    conn.execute(ddl, [])?;
    Ok(())
}

fn migrate(conn: &Connection) -> Result<()> {
    ensure_column(
        conn,
        "os_version",
        "ALTER TABLE profiles ADD COLUMN os_version TEXT",
    )?;
    ensure_column(
        conn,
        "proxy_id",
        "ALTER TABLE profiles ADD COLUMN proxy_id TEXT",
    )?;
    ensure_column(
        conn,
        "template_id",
        "ALTER TABLE profiles ADD COLUMN template_id TEXT",
    )?;
    ensure_column(
        conn,
        "cookies_import",
        "ALTER TABLE profiles ADD COLUMN cookies_import TEXT",
    )?;
    ensure_column(
        conn,
        "extensions",
        "ALTER TABLE profiles ADD COLUMN extensions TEXT",
    )?;
    ensure_column(
        conn,
        "trashed_at",
        "ALTER TABLE profiles ADD COLUMN trashed_at TEXT",
    )?;
    ensure_column(
        conn,
        "password_hash",
        "ALTER TABLE profiles ADD COLUMN password_hash TEXT",
    )?;
    Ok(())
}

fn row_to_profile(row: &Row) -> rusqlite::Result<Profile> {
    let overrides_json: Option<String> = row.get("fingerprint_overrides")?;
    let proxy_json: Option<String> = row.get("proxy")?;
    let cookies_json: Option<String> = row.get("cookies_import")?;
    let extensions_json: Option<String> = row.get("extensions")?;
    let tags_json: String = row.get("tags")?;
    let password_hash: Option<String> = row.get("password_hash")?;
    Ok(Profile {
        id: row.get("id")?,
        name: row.get("name")?,
        engine: row.get("engine")?,
        os: row.get("os")?,
        os_version: row.get("os_version")?,
        fingerprint_seed: row.get("fingerprint_seed")?,
        fingerprint_overrides: overrides_json.and_then(|s| serde_json::from_str(&s).ok()),
        proxy: proxy_json.and_then(|s| serde_json::from_str(&s).ok()),
        proxy_id: row.get("proxy_id")?,
        template_id: row.get("template_id")?,
        cookies_import: cookies_json.and_then(|s| serde_json::from_str(&s).ok()),
        extensions: extensions_json.and_then(|s| serde_json::from_str(&s).ok()),
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        folder: row.get("folder")?,
        notes: row.get("notes")?,
        status: row.get("status")?,
        password_protected: password_hash.is_some(),
        trashed_at: row.get("trashed_at")?,
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
    let mut stmt =
        conn.prepare("SELECT * FROM profiles WHERE trashed_at IS NULL ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], row_to_profile)?;
    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row?);
    }
    Ok(profiles)
}

pub fn list_trashed(conn: &Connection) -> Result<Vec<Profile>> {
    let mut stmt = conn
        .prepare("SELECT * FROM profiles WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC")?;
    let rows = stmt.query_map([], row_to_profile)?;
    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(row?);
    }
    Ok(profiles)
}

pub fn get(conn: &Connection, id: &str) -> Result<Option<Profile>> {
    let mut stmt = conn.prepare("SELECT * FROM profiles WHERE id = ?1 AND trashed_at IS NULL")?;
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
         (id, name, engine, os, os_version, fingerprint_seed, fingerprint_overrides, proxy, proxy_id, template_id, cookies_import, extensions, tags, folder, notes, status, trashed_at, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            id,
            input.name,
            input.engine,
            input.os,
            input.os_version,
            seed,
            to_text(&input.fingerprint_overrides),
            to_text(&input.proxy),
            input.proxy_id,
            input.template_id,
            to_text(&input.cookies_import),
            to_text(&input.extensions),
            serde_json::to_string(&tags)?,
            input.folder,
            input.notes,
            "idle",
            Option::<String>::None,
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
    let os_version = if patch.os_version.is_some() {
        patch.os_version
    } else {
        existing.os_version
    };
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
    let proxy_id = if patch.proxy_id.is_some() {
        patch.proxy_id
    } else {
        existing.proxy_id
    };
    let template_id = if patch.template_id.is_some() {
        patch.template_id
    } else {
        existing.template_id
    };
    let cookies_import = if patch.cookies_import.is_some() {
        patch.cookies_import
    } else {
        existing.cookies_import
    };
    let extensions = if patch.extensions.is_some() {
        patch.extensions
    } else {
        existing.extensions
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
        "UPDATE profiles SET name = ?2, engine = ?3, os = ?4, os_version = ?5, fingerprint_overrides = ?6, \
         proxy = ?7, proxy_id = ?8, template_id = ?9, cookies_import = ?10, extensions = ?11, \
         tags = ?12, folder = ?13, notes = ?14, updated_at = ?15 WHERE id = ?1",
        params![
            id,
            name,
            engine,
            os,
            os_version,
            to_text(&overrides),
            to_text(&proxy),
            proxy_id,
            template_id,
            to_text(&cookies_import),
            to_text(&extensions),
            serde_json::to_string(&tags)?,
            folder,
            notes,
            now,
        ],
    )?;

    get(conn, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<bool> {
    let now = chrono::Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE profiles SET trashed_at = ?2, updated_at = ?2 WHERE id = ?1 AND trashed_at IS NULL",
        params![id, now],
    )?;
    Ok(affected > 0)
}

pub fn set_password(conn: &Connection, id: &str, password: Option<String>) -> Result<bool> {
    let hash = match password {
        Some(password) if !password.is_empty() => {
            let salt = SaltString::encode_b64(uuid::Uuid::new_v4().as_bytes())
                .map_err(|e| anyhow::anyhow!(e.to_string()))?;
            Some(
                Argon2::default()
                    .hash_password(password.as_bytes(), &salt)
                    .map_err(|e| anyhow::anyhow!(e.to_string()))?
                    .to_string(),
            )
        }
        _ => None,
    };
    let now = chrono::Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE profiles SET password_hash = ?2, updated_at = ?3 WHERE id = ?1 AND trashed_at IS NULL",
        params![id, hash, now],
    )?;
    Ok(affected > 0)
}

pub fn verify_password(conn: &Connection, id: &str, password: Option<&str>) -> Result<bool> {
    let mut stmt =
        conn.prepare("SELECT password_hash FROM profiles WHERE id = ?1 AND trashed_at IS NULL")?;
    let mut rows = stmt.query([id])?;
    let Some(row) = rows.next()? else {
        return Ok(false);
    };
    let stored_hash: Option<String> = row.get(0)?;
    let Some(stored_hash) = stored_hash else {
        return Ok(true);
    };
    let Some(password) = password else {
        return Ok(false);
    };
    let parsed_hash =
        PasswordHash::new(&stored_hash).map_err(|e| anyhow::anyhow!(e.to_string()))?;
    Ok(Argon2::default()
        .verify_password(password.as_bytes(), &parsed_hash)
        .is_ok())
}

pub fn restore(conn: &Connection, id: &str) -> Result<bool> {
    let now = chrono::Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE profiles SET trashed_at = NULL, updated_at = ?2 WHERE id = ?1 AND trashed_at IS NOT NULL",
        params![id, now],
    )?;
    Ok(affected > 0)
}

pub fn purge(conn: &Connection, id: &str) -> Result<bool> {
    let affected = conn.execute(
        "DELETE FROM profiles WHERE id = ?1 AND trashed_at IS NOT NULL",
        params![id],
    )?;
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
            os_version: None,
            fingerprint_seed: None,
            fingerprint_overrides: None,
            proxy: None,
            proxy_id: None,
            template_id: None,
            cookies_import: None,
            extensions: None,
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
            engine: Some("lobium".to_string()),
            os: Some("macos".to_string()),
            os_version: Some("macOS 14 Sonoma".to_string()),
            fingerprint_overrides: Some(
                serde_json::json!({ "locale": { "timezone": "Europe/Berlin" } }),
            ),
            proxy: None,
            proxy_id: Some("px_1".to_string()),
            template_id: Some("tpl_1".to_string()),
            cookies_import: Some(serde_json::json!({ "mode": "merge", "parsedCount": 2 })),
            extensions: Some(serde_json::json!([
                { "source": "chrome_web_store", "enabled": true, "url": "https://example.test/ext" }
            ])),
            tags: None,
            folder: None,
            notes: None,
        };
        let updated = update(&conn, &created.id, patch).unwrap().unwrap();
        assert_eq!(updated.engine, "lobium");
        assert_eq!(updated.os, "macos");
        assert_eq!(updated.os_version.as_deref(), Some("macOS 14 Sonoma"));
        assert_eq!(updated.proxy_id.as_deref(), Some("px_1"));
        assert_eq!(updated.template_id.as_deref(), Some("tpl_1"));
        assert!(updated.cookies_import.is_some());
        assert!(updated.extensions.is_some());
        assert!(updated.fingerprint_overrides.is_some());
        assert_eq!(
            updated.fingerprint_seed, created.fingerprint_seed,
            "seed is immutable"
        );
    }

    #[test]
    fn delete_moves_the_row_to_trash() {
        let conn = mem();
        let created = create(&conn, input("D")).unwrap();
        assert!(delete(&conn, &created.id).unwrap());
        assert!(get(&conn, &created.id).unwrap().is_none());
        assert_eq!(list(&conn).unwrap().len(), 0);
        let trashed = list_trashed(&conn).unwrap();
        assert_eq!(trashed.len(), 1);
        assert_eq!(trashed[0].id, created.id);
        assert!(trashed[0].trashed_at.is_some());
        let trashed_at: Option<String> = conn
            .query_row(
                "SELECT trashed_at FROM profiles WHERE id = ?1",
                params![created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert!(trashed_at.is_some());
        assert!(!delete(&conn, "missing").unwrap());
    }

    #[test]
    fn set_password_hashes_and_removes_profile_password() {
        let conn = mem();
        let created = create(&conn, input("P")).unwrap();
        assert!(!created.password_protected);
        assert!(set_password(&conn, &created.id, Some("secret".to_string())).unwrap());
        let protected = get(&conn, &created.id).unwrap().unwrap();
        assert!(protected.password_protected);
        let stored_hash: Option<String> = conn
            .query_row(
                "SELECT password_hash FROM profiles WHERE id = ?1",
                params![created.id],
                |row| row.get(0),
            )
            .unwrap();
        let stored_hash = stored_hash.expect("hash is stored");
        assert_ne!(stored_hash, "secret");
        assert!(stored_hash.starts_with("$argon2"));
        assert!(set_password(&conn, &protected.id, None).unwrap());
        assert!(
            !get(&conn, &protected.id)
                .unwrap()
                .unwrap()
                .password_protected
        );
    }

    #[test]
    fn verify_password_blocks_wrong_or_missing_password() {
        let conn = mem();
        let created = create(&conn, input("Locked")).unwrap();
        assert!(verify_password(&conn, &created.id, None).unwrap());
        assert!(set_password(&conn, &created.id, Some("secret".to_string())).unwrap());
        assert!(!verify_password(&conn, &created.id, None).unwrap());
        assert!(!verify_password(&conn, &created.id, Some("wrong")).unwrap());
        assert!(verify_password(&conn, &created.id, Some("secret")).unwrap());
        assert!(!verify_password(&conn, "missing", Some("secret")).unwrap());
    }

    #[test]
    fn restore_returns_a_profile_to_active_lists() {
        let conn = mem();
        let created = create(&conn, input("E")).unwrap();
        assert!(delete(&conn, &created.id).unwrap());
        assert!(restore(&conn, &created.id).unwrap());
        assert!(list_trashed(&conn).unwrap().is_empty());
        assert!(get(&conn, &created.id).unwrap().is_some());
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert!(!restore(&conn, &created.id).unwrap());
    }

    #[test]
    fn purge_permanently_removes_only_trashed_profiles() {
        let conn = mem();
        let active = create(&conn, input("F")).unwrap();
        let trashed = create(&conn, input("G")).unwrap();
        assert!(!purge(&conn, &active.id).unwrap());
        assert!(delete(&conn, &trashed.id).unwrap());
        assert!(purge(&conn, &trashed.id).unwrap());
        assert_eq!(list(&conn).unwrap().len(), 1);
        assert_eq!(list(&conn).unwrap()[0].id, active.id);
        assert!(list_trashed(&conn).unwrap().is_empty());
    }
}
