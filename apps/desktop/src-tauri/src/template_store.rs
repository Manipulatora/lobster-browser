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

/// A save REPLACES the fields a user owns, rather than patching the ones it mentions.
///
/// That is what makes "No proxy" expressible at all: a patch whose absent fields mean "leave alone"
/// can set a proxy but can never unbind one, and the same goes for clearing an OS version or the
/// extension list. The editor always holds the template's full state, so it always sends it.
pub type UpdateProfileTemplateInput = CreateProfileTemplateInput;

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

pub fn get(conn: &Connection, id: &str) -> Result<Option<ProfileTemplate>> {
    let mut stmt = conn.prepare("SELECT * FROM profile_templates WHERE id = ?1")?;
    let mut rows = stmt.query_map([id], row_to_template)?;
    match rows.next() {
        Some(row) => Ok(Some(row?)),
        None => Ok(None),
    }
}

fn validate(input: &CreateProfileTemplateInput) -> Result<()> {
    const PROFILE_OS_TARGETS: &[&str] = &[
        "windows",
        "macos",
        "macos_intel",
        "macos_arm",
        "linux",
        "android",
    ];
    if input.name.trim().is_empty() {
        anyhow::bail!("template name is required");
    }
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
    Ok(())
}

pub fn create(conn: &Connection, input: CreateProfileTemplateInput) -> Result<ProfileTemplate> {
    validate(&input)?;
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

    Ok(get(conn, &id)?.expect("row was just inserted"))
}

pub fn update(
    conn: &Connection,
    id: &str,
    input: UpdateProfileTemplateInput,
) -> Result<Option<ProfileTemplate>> {
    if get(conn, id)?.is_none() {
        return Ok(None);
    }
    validate(&input)?;
    let presets = input.preset_parameters.unwrap_or_default();
    let tags = input.tags.unwrap_or_default();
    let now = chrono::Utc::now().to_rfc3339();

    conn.execute(
        "UPDATE profile_templates SET name = ?2, engine = ?3, os = ?4, os_version = ?5, \
         preset_parameters = ?6, proxy_id = ?7, proxy_label = ?8, proxy_detail = ?9, \
         fingerprint_overrides = ?10, cookies_import = ?11, extensions = ?12, tags = ?13, \
         updated_at = ?14 WHERE id = ?1",
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

    get(conn, id)
}

/// "US Retail" → "US Retail (copy)", and again → "US Retail (copy 2)".
///
/// Two rows with the same name are two rows nobody can tell apart in a list that offers Edit and
/// Delete on each of them.
fn copy_name(conn: &Connection, base: &str) -> Result<String> {
    let mut stmt = conn.prepare("SELECT name FROM profile_templates")?;
    let mut taken: Vec<String> = Vec::new();
    for name in stmt.query_map([], |row| row.get::<_, String>(0))? {
        taken.push(name?);
    }
    let first = format!("{base} (copy)");
    if !taken.contains(&first) {
        return Ok(first);
    }
    let mut suffix = 2;
    loop {
        let candidate = format!("{base} (copy {suffix})");
        if !taken.contains(&candidate) {
            return Ok(candidate);
        }
        suffix += 1;
    }
}

/// Copy a template, in the store rather than in the caller.
///
/// A UI-side duplicate has to enumerate the fields it copies, so every field added to a template
/// afterwards is silently dropped by the copy until someone remembers to extend the list. Here the
/// copy is made from the stored row.
pub fn duplicate(conn: &Connection, id: &str) -> Result<Option<ProfileTemplate>> {
    let Some(source) = get(conn, id)? else {
        return Ok(None);
    };
    let copy = create(
        conn,
        CreateProfileTemplateInput {
            name: copy_name(conn, &source.name)?,
            engine: source.engine,
            os: source.os,
            os_version: source.os_version,
            preset_parameters: Some(source.preset_parameters),
            proxy_id: source.proxy_id,
            proxy_label: source.proxy_label,
            proxy_detail: source.proxy_detail,
            fingerprint_overrides: source.fingerprint_overrides,
            cookies_import: source.cookies_import,
            extensions: source.extensions,
            tags: Some(source.tags),
        },
    )?;
    Ok(Some(copy))
}

/// Profiles made from a template are NOT counted here, unlike the proxy a profile runs through.
/// A template is a starting point: the profiles it minted are complete on their own and go on
/// working after it is gone, so refusing the delete would only strand the row.
pub fn delete(conn: &Connection, id: &str) -> Result<bool> {
    Ok(conn.execute("DELETE FROM profile_templates WHERE id = ?1", [id])? > 0)
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

    fn sample(name: &str) -> CreateProfileTemplateInput {
        CreateProfileTemplateInput {
            name: name.to_string(),
            engine: "lobium".to_string(),
            os: "windows".to_string(),
            os_version: Some("Windows 11 23H2".to_string()),
            preset_parameters: Some(vec!["Proxy".to_string()]),
            proxy_id: Some("px_1".to_string()),
            proxy_label: Some("US proxy".to_string()),
            proxy_detail: Some("example.test:10000".to_string()),
            fingerprint_overrides: None,
            cookies_import: None,
            extensions: Some(serde_json::json!([{ "id": "abcdefghijklmnopabcdefghijklmnop" }])),
            tags: Some(vec!["retail".to_string()]),
        }
    }

    #[test]
    fn a_saved_template_replaces_the_fields_a_user_owns() {
        let conn = mem();
        let created = create(&conn, sample("US Retail")).unwrap();

        let updated = update(
            &conn,
            &created.id,
            CreateProfileTemplateInput {
                name: "EU Retail".to_string(),
                engine: "lobium".to_string(),
                os: "linux".to_string(),
                os_version: None,
                preset_parameters: Some(vec![]),
                // Unbinding the proxy is the case a merge-style patch cannot express at all.
                proxy_id: None,
                proxy_label: None,
                proxy_detail: None,
                fingerprint_overrides: None,
                cookies_import: None,
                extensions: None,
                tags: Some(vec!["eu".to_string()]),
            },
        )
        .unwrap()
        .unwrap();
        assert_eq!(updated.name, "EU Retail");
        assert_eq!(updated.os, "linux");
        assert!(updated.os_version.is_none());
        assert!(updated.proxy_id.is_none());
        assert!(updated.extensions.is_none());
        assert_eq!(updated.tags, vec!["eu"]);
        assert_eq!(updated.created_at, created.created_at);

        let missing = update(&conn, "tpl_missing", sample("Nowhere")).unwrap();
        assert!(missing.is_none());
        assert!(update(&conn, &updated.id, sample("")).is_err());
    }

    #[test]
    fn a_duplicate_carries_every_field_and_takes_a_name_of_its_own() {
        let conn = mem();
        let created = create(&conn, sample("US Retail")).unwrap();

        let copy = duplicate(&conn, &created.id).unwrap().unwrap();
        assert_eq!(copy.name, "US Retail (copy)");
        assert_ne!(copy.id, created.id);
        assert_eq!(copy.engine, created.engine);
        assert_eq!(copy.os_version, created.os_version);
        assert_eq!(copy.proxy_id, created.proxy_id);
        assert_eq!(copy.preset_parameters, created.preset_parameters);
        assert_eq!(copy.extensions, created.extensions);
        assert_eq!(copy.tags, created.tags);

        assert_eq!(
            duplicate(&conn, &created.id).unwrap().unwrap().name,
            "US Retail (copy 2)"
        );
        assert!(duplicate(&conn, "tpl_missing").unwrap().is_none());

        assert!(delete(&conn, &copy.id).unwrap());
        assert!(!delete(&conn, &copy.id).unwrap());
        assert_eq!(list(&conn).unwrap().len(), 2);
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
