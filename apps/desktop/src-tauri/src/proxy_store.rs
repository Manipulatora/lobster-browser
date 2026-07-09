//! Local proxy catalog persisted in SQLite.
//!
//! SEC-12: proxy credentials (`username`/`password` inside the `config` JSON) are encrypted with
//! AES-256-GCM before they are written and decrypted on read — the on-disk DB never holds a
//! cleartext proxy password. Legacy plaintext rows (pre-SEC-12) still read fine; see
//! `crate::secrets`.

use anyhow::Result;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::secrets::{SecretCipher, PROXY_SECRET_FIELDS};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS proxies (
    id               TEXT PRIMARY KEY,
    source           TEXT NOT NULL,
    label            TEXT NOT NULL,
    config           TEXT NOT NULL,
    location         TEXT,
    timezone         TEXT,
    latency_ms       INTEGER,
    status           TEXT NOT NULL,
    rotate_url       TEXT,
    last_checked_at  TEXT,
    last_error       TEXT,
    created_at       TEXT NOT NULL,
    updated_at       TEXT NOT NULL
);
";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredProxy {
    pub id: String,
    pub source: String,
    pub label: String,
    pub config: serde_json::Value,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub location: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub timezone: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub latency_ms: Option<i64>,
    pub status: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub rotate_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_checked_at: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub last_error: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateStoredProxyInput {
    pub source: String,
    pub label: String,
    pub config: serde_json::Value,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub rotate_url: Option<String>,
}

fn row_to_proxy(row: &Row) -> rusqlite::Result<StoredProxy> {
    let config_json: String = row.get("config")?;
    Ok(StoredProxy {
        id: row.get("id")?,
        source: row.get("source")?,
        label: row.get("label")?,
        config: serde_json::from_str(&config_json).unwrap_or(serde_json::Value::Null),
        location: row.get("location")?,
        timezone: row.get("timezone")?,
        latency_ms: row.get("latency_ms")?,
        status: row.get("status")?,
        rotate_url: row.get("rotate_url")?,
        last_checked_at: row.get("last_checked_at")?,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn list(
    conn: &Connection,
    cipher: &SecretCipher,
    source: Option<&str>,
) -> Result<Vec<StoredProxy>> {
    let mut proxies = Vec::new();
    if let Some(source) = source {
        let mut stmt =
            conn.prepare("SELECT * FROM proxies WHERE source = ?1 ORDER BY created_at DESC")?;
        let rows = stmt.query_map([source], row_to_proxy)?;
        for row in rows {
            proxies.push(row?);
        }
    } else {
        let mut stmt = conn.prepare("SELECT * FROM proxies ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], row_to_proxy)?;
        for row in rows {
            proxies.push(row?);
        }
    }
    for proxy in &mut proxies {
        cipher.decrypt_json_fields(&mut proxy.config, PROXY_SECRET_FIELDS);
    }
    Ok(proxies)
}

pub fn create(
    conn: &Connection,
    cipher: &SecretCipher,
    input: CreateStoredProxyInput,
) -> Result<StoredProxy> {
    let id = input
        .config
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("px_{}", uuid::Uuid::new_v4().simple()));
    // SEC-12: never write cleartext proxy credentials to disk.
    let mut config = input.config;
    cipher.encrypt_json_fields(&mut config, PROXY_SECRET_FIELDS)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO proxies \
         (id, source, label, config, location, timezone, latency_ms, status, rotate_url, last_checked_at, last_error, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'warning', ?7, NULL, NULL, ?8, ?8)",
        params![
            id,
            input.source,
            input.label,
            config.to_string(),
            input.location,
            input.timezone,
            input.rotate_url,
            now,
        ],
    )?;
    Ok(list(conn, cipher, None)?
        .into_iter()
        .find(|proxy| proxy.id == id)
        .expect("row was just inserted"))
}

pub fn update_test_result(
    conn: &Connection,
    id: &str,
    ok: bool,
    latency_ms: Option<i64>,
    location: Option<String>,
    timezone: Option<String>,
    error: Option<String>,
) -> Result<bool> {
    let now = chrono::Utc::now().to_rfc3339();
    let status = if ok { "ready" } else { "error" };
    let affected = conn.execute(
        "UPDATE proxies SET status = ?2, latency_ms = ?3, location = COALESCE(?4, location), \
         timezone = COALESCE(?5, timezone), last_error = ?6, last_checked_at = ?7, updated_at = ?7 \
         WHERE id = ?1",
        params![id, status, latency_ms, location, timezone, error, now],
    )?;
    Ok(affected > 0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        conn
    }

    fn test_cipher() -> SecretCipher {
        SecretCipher::new(&[42u8; 32])
    }

    #[test]
    fn create_and_list_proxies_by_source() {
        let conn = mem();
        let cipher = test_cipher();
        let input = CreateStoredProxyInput {
            source: "mine".to_string(),
            label: "US".to_string(),
            config: serde_json::json!({ "id": "px_1", "type": "http", "host": "h", "port": 80 }),
            location: Some("United States".to_string()),
            timezone: Some("America/New_York".to_string()),
            rotate_url: None,
        };
        let created = create(&conn, &cipher, input).unwrap();
        assert_eq!(created.id, "px_1");
        assert_eq!(list(&conn, &cipher, Some("mine")).unwrap().len(), 1);
        assert_eq!(list(&conn, &cipher, Some("hive")).unwrap().len(), 0);
    }

    /// SEC-12 acceptance: the raw SQLite cell must not contain the cleartext proxy password,
    /// and reading through the store must round-trip the original credentials.
    #[test]
    fn proxy_credentials_are_encrypted_at_rest_and_round_trip() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(
            &conn,
            &cipher,
            CreateStoredProxyInput {
                source: "mine".to_string(),
                label: "Secret".to_string(),
                config: serde_json::json!({
                    "id": "px_sec", "type": "socks5", "host": "proxy.example", "port": 1080,
                    "username": "alice-user", "password": "hunter2-topsecret"
                }),
                location: None,
                timezone: None,
                rotate_url: None,
            },
        )
        .unwrap();

        // Raw cell inspection: no cleartext secrets on disk, ciphertext marker present.
        let raw_config: String = conn
            .query_row(
                "SELECT config FROM proxies WHERE id = 'px_sec'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(
            !raw_config
                .as_bytes()
                .windows(b"hunter2-topsecret".len())
                .any(|w| w == b"hunter2-topsecret"),
            "stored bytes must not contain the plaintext password"
        );
        assert!(!raw_config.contains("alice-user"));
        assert!(
            raw_config.contains("lbsec1:"),
            "credentials should be marked as ciphertext"
        );
        // Non-secret connection metadata stays queryable/readable.
        assert!(raw_config.contains("proxy.example"));

        // Round trip: both the value returned by create() and a fresh list() decrypt correctly.
        assert_eq!(created.config["password"], "hunter2-topsecret");
        let listed = list(&conn, &cipher, None).unwrap().remove(0);
        assert_eq!(listed.config["username"], "alice-user");
        assert_eq!(listed.config["password"], "hunter2-topsecret");
    }

    /// Migration/compat path: pre-SEC-12 rows with plaintext credentials must still read fine.
    #[test]
    fn legacy_plaintext_rows_are_still_readable() {
        let conn = mem();
        let cipher = test_cipher();
        conn.execute(
            "INSERT INTO proxies \
             (id, source, label, config, status, created_at, updated_at) \
             VALUES ('px_legacy', 'mine', 'Old', ?1, 'ready', '2025-01-01T00:00:00Z', '2025-01-01T00:00:00Z')",
            params![r#"{"id":"px_legacy","type":"http","host":"h","port":80,"username":"olduser","password":"oldpass"}"#],
        )
        .unwrap();
        let listed = list(&conn, &cipher, None).unwrap().remove(0);
        assert_eq!(listed.config["username"], "olduser");
        assert_eq!(listed.config["password"], "oldpass");
    }
}
