//! Local profile-template catalog persisted in SQLite.

use anyhow::Result;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

pub const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS profile_templates (
    id                      TEXT PRIMARY KEY,
    name                    TEXT NOT NULL,
    engine                  TEXT NOT NULL,
    os                      TEXT NOT NULL,
    os_version              TEXT,
    preset_parameters       TEXT NOT NULL DEFAULT '[]',
    proxy_id                TEXT,
    proxy_label             TEXT,
    proxy_detail            TEXT,
    fingerprint_overrides   TEXT,
    cookies_import          TEXT,
    extensions              TEXT,
    tags                    TEXT NOT NULL DEFAULT '[]',
    created_at              TEXT NOT NULL,
    updated_at              TEXT NOT NULL
);
";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProfileTemplate {
    pub id: String,
    pub name: String,
    pub engine: String,
    pub os: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os_version: Option<String>,
    pub preset_parameters: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_label: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub proxy_detail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookies_import: Option<serde_json::Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub extensions: Option<serde_json::Value>,
    pub tags: Vec<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateProfileTemplateInput {
    pub name: String,
    pub engine: String,
    pub os: String,
    #[serde(default)]
    pub os_version: Option<String>,
    #[serde(default)]
    pub preset_parameters: Option<Vec<String>>,
    #[serde(default)]
    pub proxy_id: Option<String>,
    #[serde(default)]
    pub proxy_label: Option<String>,
    #[serde(default)]
    pub proxy_detail: Option<String>,
    #[serde(default)]
    pub fingerprint_overrides: Option<serde_json::Value>,
    #[serde(default)]
    pub cookies_import: Option<serde_json::Value>,
    #[serde(default)]
    pub extensions: Option<serde_json::Value>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
}

fn row_to_template(row: &Row) -> rusqlite::Result<ProfileTemplate> {
    let preset_json: String = row.get("preset_parameters")?;
    let overrides_json: Option<String> = row.get("fingerprint_overrides")?;
    let cookies_json: Option<String> = row.get("cookies_import")?;
    let extensions_json: Option<String> = row.get("extensions")?;
    let tags_json: String = row.get("tags")?;
    Ok(ProfileTemplate {
        id: row.get("id")?,
        name: row.get("name")?,
        engine: row.get("engine")?,
        os: row.get("os")?,
        os_version: row.get("os_version")?,
        preset_parameters: serde_json::from_str(&preset_json).unwrap_or_default(),
        proxy_id: row.get("proxy_id")?,
        proxy_label: row.get("proxy_label")?,
        proxy_detail: row.get("proxy_detail")?,
        fingerprint_overrides: overrides_json.and_then(|s| serde_json::from_str(&s).ok()),
        cookies_import: cookies_json.and_then(|s| serde_json::from_str(&s).ok()),
        extensions: extensions_json.and_then(|s| serde_json::from_str(&s).ok()),
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
    })
}

fn to_text(value: &Option<serde_json::Value>) -> Option<String> {
    value.as_ref().map(|v| v.to_string())
}

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(SCHEMA)?;
    Ok(())
}

pub fn list(conn: &Connection) -> Result<Vec<ProfileTemplate>> {
    let mut stmt = conn.prepare("SELECT * FROM profile_templates ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], row_to_template)?;
    let mut templates = Vec::new();
    for row in rows {
        templates.push(row?);
    }
    Ok(templates)
}

pub fn create(conn: &Connection, input: CreateProfileTemplateInput) -> Result<ProfileTemplate> {
    let id = format!("tpl_{}", uuid::Uuid::new_v4().simple());
    let presets = input.preset_parameters.unwrap_or_default();
    let tags = input.tags.unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "INSERT INTO profile_templates \
         (id, name, engine, os, os_version, preset_parameters, proxy_id, proxy_label, proxy_detail, fingerprint_overrides, cookies_import, extensions, tags, created_at, updated_at) \
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?14)",
        params![
            id,
            input.name,
            input.engine,
            input.os,
            input.os_version,
            serde_json::to_string(&presets)?,
            input.proxy_id,
            input.proxy_label,
            input.proxy_detail,
            to_text(&input.fingerprint_overrides),
            to_text(&input.cookies_import),
            to_text(&input.extensions),
            serde_json::to_string(&tags)?,
            now,
        ],
    )?;

    Ok(list(conn)?
        .into_iter()
        .find(|template| template.id == id)
        .expect("row was just inserted"))
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
    fn create_and_list_templates() {
        let conn = mem();
        let template = create(
            &conn,
            CreateProfileTemplateInput {
                name: "US Retail".to_string(),
                engine: "chromium".to_string(),
                os: "windows".to_string(),
                os_version: Some("Windows 11 23H2".to_string()),
                preset_parameters: Some(vec!["User Agent".to_string(), "Extensions".to_string()]),
                proxy_id: Some("px_1".to_string()),
                proxy_label: Some("US proxy".to_string()),
                proxy_detail: Some("example.test:10000".to_string()),
                fingerprint_overrides: None,
                cookies_import: None,
                extensions: None,
                tags: Some(vec!["retail".to_string()]),
            },
        )
        .unwrap();
        assert_eq!(template.name, "US Retail");
        assert_eq!(template.preset_parameters, vec!["User Agent", "Extensions"]);
        assert_eq!(template.proxy_id.as_deref(), Some("px_1"));
        assert_eq!(list(&conn).unwrap().len(), 1);
    }
}
