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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateStoredProxyInput {
    #[serde(default)]
    pub source: Option<String>,
    #[serde(default)]
    pub label: Option<String>,
    #[serde(default)]
    pub config: Option<serde_json::Value>,
    #[serde(default)]
    pub location: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub rotate_url: Option<String>,
}

fn row_to_proxy(cipher: &SecretCipher, row: &Row) -> rusqlite::Result<StoredProxy> {
    let config_json: String = row.get("config")?;
    let mut config = serde_json::from_str(&config_json).unwrap_or(serde_json::Value::Null);
    cipher.decrypt_json_fields(&mut config, PROXY_SECRET_FIELDS);
    let rotate_url: Option<String> = row.get("rotate_url")?;
    Ok(StoredProxy {
        id: row.get("id")?,
        source: row.get("source")?,
        label: row.get("label")?,
        config,
        location: row.get("location")?,
        timezone: row.get("timezone")?,
        latency_ms: row.get("latency_ms")?,
        status: row.get("status")?,
        rotate_url: rotate_url.map(|value| cipher.decrypt_str(&value)),
        last_checked_at: row.get("last_checked_at")?,
        last_error: row.get("last_error")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn validate_config(config: &serde_json::Value) -> Result<()> {
    let object = config
        .as_object()
        .ok_or_else(|| anyhow::anyhow!("proxy config must be an object"))?;
    let kind = object.get("type").and_then(serde_json::Value::as_str);
    if !matches!(kind, Some("http" | "https" | "socks5")) {
        anyhow::bail!("proxy type must be http, https, or socks5");
    }
    let host = object
        .get("host")
        .and_then(serde_json::Value::as_str)
        .unwrap_or("")
        .trim();
    if host.is_empty() || host.chars().any(char::is_whitespace) {
        anyhow::bail!("proxy host is required and must not contain whitespace");
    }
    let port = object
        .get("port")
        .and_then(serde_json::Value::as_u64)
        .unwrap_or(0);
    if !(1..=65_535).contains(&port) {
        anyhow::bail!("proxy port must be in 1-65535");
    }
    if object.get("password").is_some() && object.get("username").is_none() {
        anyhow::bail!("proxy password requires a username");
    }
    Ok(())
}

fn validate_rotate_url(value: Option<&str>) -> Result<Option<String>> {
    let Some(value) = value.map(str::trim).filter(|value| !value.is_empty()) else {
        return Ok(None);
    };
    let url = reqwest::Url::parse(value)
        .map_err(|_| anyhow::anyhow!("proxy rotation URL must be absolute"))?;
    if url.scheme() != "http" && url.scheme() != "https" {
        anyhow::bail!("proxy rotation URL must use HTTP or HTTPS");
    }
    if url.fragment().is_some() {
        anyhow::bail!("proxy rotation URL must not contain a fragment");
    }
    Ok(Some(url.to_string()))
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
        let rows = stmt.query_map([source], |row| row_to_proxy(cipher, row))?;
        for row in rows {
            proxies.push(row?);
        }
    } else {
        let mut stmt = conn.prepare("SELECT * FROM proxies ORDER BY created_at DESC")?;
        let rows = stmt.query_map([], |row| row_to_proxy(cipher, row))?;
        for row in rows {
            proxies.push(row?);
        }
    }
    Ok(proxies)
}

pub fn get(conn: &Connection, cipher: &SecretCipher, id: &str) -> Result<Option<StoredProxy>> {
    let mut stmt = conn.prepare("SELECT * FROM proxies WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], |row| row_to_proxy(cipher, row))?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

pub fn create(
    conn: &Connection,
    cipher: &SecretCipher,
    input: CreateStoredProxyInput,
) -> Result<StoredProxy> {
    validate_config(&input.config)?;
    if !matches!(input.source.as_str(), "mine" | "hive") {
        anyhow::bail!("proxy source must be mine or hive");
    }
    if input.label.trim().is_empty() {
        anyhow::bail!("proxy label is required");
    }
    let id = input
        .config
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("px_{}", uuid::Uuid::new_v4().simple()));
    // SEC-12: never write cleartext proxy credentials to disk.
    let rotate_url = validate_rotate_url(input.rotate_url.as_deref())?
        .map(|value| cipher.encrypt_str(&value))
        .transpose()?;
    let mut config = input.config;
    if let Some(object) = config.as_object_mut() {
        object.insert("id".to_string(), serde_json::Value::String(id.clone()));
    }
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
            rotate_url,
            now,
        ],
    )?;
    Ok(get(conn, cipher, &id)?.expect("row was just inserted"))
}

pub fn update(
    conn: &Connection,
    cipher: &SecretCipher,
    id: &str,
    patch: UpdateStoredProxyInput,
) -> Result<Option<StoredProxy>> {
    let Some(existing) = get(conn, cipher, id)? else {
        return Ok(None);
    };
    let source = patch.source.unwrap_or(existing.source);
    let label = patch.label.unwrap_or(existing.label);
    let mut config = patch.config.unwrap_or(existing.config);
    validate_config(&config)?;
    if let Some(config_id) = config.get("id").and_then(serde_json::Value::as_str) {
        if config_id != id {
            anyhow::bail!("proxy config id must match stored proxy id");
        }
    }
    if let Some(object) = config.as_object_mut() {
        object.insert("id".to_string(), serde_json::Value::String(id.to_string()));
    }
    if !matches!(source.as_str(), "mine" | "hive") {
        anyhow::bail!("proxy source must be mine or hive");
    }
    if label.trim().is_empty() {
        anyhow::bail!("proxy label is required");
    }
    let rotate_plain = patch.rotate_url.or(existing.rotate_url);
    let rotate_url = validate_rotate_url(rotate_plain.as_deref())?
        .map(|value| cipher.encrypt_str(&value))
        .transpose()?;
    cipher.encrypt_json_fields(&mut config, PROXY_SECRET_FIELDS)?;
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "UPDATE proxies SET source = ?2, label = ?3, config = ?4, location = ?5, timezone = ?6, \
         rotate_url = ?7, status = 'warning', last_error = NULL, updated_at = ?8 WHERE id = ?1",
        params![
            id,
            source,
            label,
            config.to_string(),
            patch.location.or(existing.location),
            patch.timezone.or(existing.timezone),
            rotate_url,
            now
        ],
    )?;
    get(conn, cipher, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<bool> {
    let referenced: i64 = conn.query_row(
        "SELECT COUNT(*) FROM profiles WHERE proxy_id = ?1",
        [id],
        |row| row.get(0),
    )?;
    if referenced > 0 {
        anyhow::bail!("proxy {id} is assigned to {referenced} active profile(s)");
    }
    Ok(conn.execute("DELETE FROM proxies WHERE id = ?1", [id])? > 0)
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
        conn.execute_batch(crate::profile_store::SCHEMA).unwrap();
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

    #[test]
    fn crud_and_rotation_urls_are_validated_and_encrypted() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(
            &conn,
            &cipher,
            CreateStoredProxyInput {
                source: "mine".to_string(),
                label: "Rotating".to_string(),
                config: serde_json::json!({
                    "id": "px_rotate", "type": "https", "host": "proxy.example", "port": 443
                }),
                location: None,
                timezone: None,
                rotate_url: Some(
                    "https://provider.example/rotate?token=rotation-secret".to_string(),
                ),
            },
        )
        .unwrap();
        assert!(created
            .rotate_url
            .as_deref()
            .unwrap()
            .contains("rotation-secret"));
        let raw: String = conn
            .query_row(
                "SELECT rotate_url FROM proxies WHERE id = 'px_rotate'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(SecretCipher::is_encrypted(&raw));
        assert!(!raw.contains("rotation-secret"));

        let updated = update(
            &conn,
            &cipher,
            "px_rotate",
            UpdateStoredProxyInput {
                source: None,
                label: Some("Updated".to_string()),
                config: Some(serde_json::json!({
                    "id": "px_rotate", "type": "socks5", "host": "new.example", "port": 1080,
                    "username": "u", "password": "p"
                })),
                location: None,
                timezone: None,
                rotate_url: None,
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.label, "Updated");
        assert_eq!(updated.config["host"], "new.example");
        assert!(delete(&conn, "px_rotate").unwrap());
        assert!(get(&conn, &cipher, "px_rotate").unwrap().is_none());

        let invalid = create(
            &conn,
            &cipher,
            CreateStoredProxyInput {
                source: "mine".to_string(),
                label: "Bad".to_string(),
                config: serde_json::json!({
                    "type": "http", "host": "proxy.example", "port": 80
                }),
                location: None,
                timezone: None,
                rotate_url: Some("file:///tmp/rotate".to_string()),
            },
        );
        assert!(invalid.is_err());
    }
}
