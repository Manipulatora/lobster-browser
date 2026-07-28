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
    let cookies_import = cookies_json
        .and_then(|s| serde_json::from_str::<serde_json::Value>(&s).ok())
        .map(|mut value| {
            if let Some(object) = value.as_object_mut() {
                object.remove("rawText");
            }
            value
        });
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
        cookies_import,
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
    // Legacy templates must not retain cookie payloads. Keep only non-secret import metadata.
    let mut stmt = conn.prepare(
        "SELECT id, cookies_import FROM profile_templates WHERE cookies_import IS NOT NULL",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut sanitized = Vec::new();
    for row in rows {
        let (id, raw) = row?;
        if let Ok(mut value) = serde_json::from_str::<serde_json::Value>(&raw) {
            if value
                .as_object_mut()
                .and_then(|object| object.remove("rawText"))
                .is_some()
            {
                sanitized.push((id, value.to_string()));
            }
        }
    }
    drop(stmt);
    for (id, value) in sanitized {
        conn.execute(
            "UPDATE profile_templates SET cookies_import = ?2 WHERE id = ?1",
            params![id, value],
        )?;
    }
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
    const PROFILE_OS_TARGETS: &[&str] = &[
        "windows",
        "macos",
        "macos_intel",
        "macos_arm",
        "linux",
        "android",
    ];
    if !PROFILE_OS_TARGETS.contains(&input.os.as_str()) {
        anyhow::bail!(
            "desktop templates cannot use OS target `{}`; allowed: {}",
            input.os,
            PROFILE_OS_TARGETS.join(", ")
        );
    }
    if input
        .cookies_import
        .as_ref()
        .and_then(|value| value.get("rawText"))
        .is_some()
    {
        anyhow::bail!("cookie rawText is forbidden in profile templates");
    }
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
                engine: "lobium".to_string(),
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

    #[test]
    fn template_cookie_raw_text_is_forbidden_and_legacy_rows_are_scrubbed() {
        let conn = mem();
        let rejected = create(
            &conn,
            CreateProfileTemplateInput {
                name: "Secret template".to_string(),
                engine: "lobium".to_string(),
                os: "linux".to_string(),
                os_version: None,
                preset_parameters: None,
                proxy_id: None,
                proxy_label: None,
                proxy_detail: None,
                fingerprint_overrides: None,
                cookies_import: Some(serde_json::json!({
                    "mode": "merge", "rawText": "session=secret"
                })),
                extensions: None,
                tags: None,
            },
        );
        assert!(rejected.is_err());

        conn.execute(
            "INSERT INTO profile_templates \
             (id, name, engine, os, preset_parameters, cookies_import, tags, created_at, updated_at) \
             VALUES ('legacy', 'Legacy', 'lobium', 'linux', '[]', ?1, '[]', 'now', 'now')",
            [r#"{"mode":"merge","rawText":"secret-cookie","parsedCount":1}"#],
        )
        .unwrap();
        init(&conn).unwrap();
        let raw: String = conn
            .query_row(
                "SELECT cookies_import FROM profile_templates WHERE id = 'legacy'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!raw.contains("secret-cookie"));
        assert_eq!(
            list(&conn).unwrap()[0].cookies_import.as_ref().unwrap()["parsedCount"],
            1
        );
    }
}
