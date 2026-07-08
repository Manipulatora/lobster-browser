//! Local proxy catalog persisted in SQLite.

use anyhow::Result;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

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

pub fn list(conn: &Connection, source: Option<&str>) -> Result<Vec<StoredProxy>> {
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
    Ok(proxies)
}

pub fn create(conn: &Connection, input: CreateStoredProxyInput) -> Result<StoredProxy> {
    let id = input
        .config
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(ToString::to_string)
        .unwrap_or_else(|| format!("px_{}", uuid::Uuid::new_v4().simple()));
    let now = chrono::Utc::now().to_rfc3339();
    conn.execute(
        "INSERT INTO proxies \
         (id, source, label, config, location, timezone, latency_ms, status, rotate_url, last_checked_at, last_error, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, 'warning', ?7, NULL, NULL, ?8, ?8)",
        params![
            id,
            input.source,
            input.label,
            input.config.to_string(),
            input.location,
            input.timezone,
            input.rotate_url,
            now,
        ],
    )?;
    Ok(list(conn, None)?
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

    #[test]
    fn create_and_list_proxies_by_source() {
        let conn = mem();
        let input = CreateStoredProxyInput {
            source: "mine".to_string(),
            label: "US".to_string(),
            config: serde_json::json!({ "id": "px_1", "type": "http", "host": "h", "port": 80 }),
            location: Some("United States".to_string()),
            timezone: Some("America/New_York".to_string()),
            rotate_url: None,
        };
        let created = create(&conn, input).unwrap();
        assert_eq!(created.id, "px_1");
        assert_eq!(list(&conn, Some("mine")).unwrap().len(), 1);
        assert_eq!(list(&conn, Some("hive")).unwrap().len(), 0);
    }
}
