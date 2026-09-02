//! Local profile store (rusqlite / bundled SQLite).
//!
//! The desktop agent keeps an offline-first copy of every profile so it can launch engines
//! without the cloud. Columns mirror `@lobster/shared-types` `Profile`; the JSON-shaped fields
//! (fingerprint overrides, proxy, tags) are stored as TEXT and (de)serialized at the boundary.
//!
//! SEC-12: secret material is encrypted at rest with the per-install AES-256-GCM key
//! (`crate::secrets`): proxy credentials inside the `proxy` JSON, and the whole `cookies_import`
//! payload (imported cookies are live session secrets). SEC-19: a cell that cannot be decrypted
//! fails the read — it is never substituted, because the substitute gets written back.
//! LATER: rows sync to the backend for team sharing. This module owns schema + CRUD.

use std::path::Path;

use anyhow::Result;
use argon2::Argon2;
use password_hash::{PasswordHash, PasswordHasher, PasswordVerifier, SaltString};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};

use crate::secrets::{SecretCipher, PROXY_SECRET_FIELDS};

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
    cookies_import_applied_at TEXT,                -- ISO-8601: import already in the cookie jar
    extensions             TEXT,                   -- JSON: BrowserExtensionRef[]
    tags                   TEXT NOT NULL DEFAULT '[]', -- JSON: string[]
    folder                 TEXT,
    notes                  TEXT,
    status                 TEXT NOT NULL DEFAULT 'idle', -- shared-types ProfileStatus
    password_hash          TEXT,
    trashed_at             TEXT,
    remote_id              TEXT,                   -- the account's id for this profile, once synced
    remote_version         INTEGER NOT NULL DEFAULT 0, -- server blob version this machine last saw
    synced_at              TEXT,                   -- ISO-8601: last successful push or pull
    created_at             TEXT NOT NULL,          -- ISO-8601
    updated_at             TEXT NOT NULL           -- ISO-8601
);
";

// NOTE: idx_profiles_remote_id is deliberately NOT part of SCHEMA. SCHEMA executes as a single
// batch BEFORE `migrate`, and on a profiles.sqlite created before `remote_id` existed the
// CREATE TABLE is a no-op — so an index over that column fails the whole batch with
// "no such column: remote_id" and the app panics at startup. Every existing install hit this on
// upgrade. The index is created in `migrate`, after the ALTER that adds the column.

/// Profile OS targets accepted by the control plane. Android launches through the ADB/APK runner.
const PROFILE_OS_TARGETS: &[&str] = &[
    "windows",
    "macos",
    "macos_intel",
    "macos_arm",
    "linux",
    "android",
];

fn assert_creatable_os(os: &str) -> Result<()> {
    if PROFILE_OS_TARGETS.contains(&os) {
        return Ok(());
    }
    anyhow::bail!(
        "desktop profiles cannot use OS target `{os}`; allowed: {}",
        PROFILE_OS_TARGETS.join(", ")
    )
}

fn assert_updatable_os(_existing_os: &str, next_os: &str) -> Result<()> {
    if PROFILE_OS_TARGETS.contains(&next_os) {
        return Ok(());
    }
    anyhow::bail!(
        "desktop profiles cannot use OS target `{next_os}`; allowed: {}",
        PROFILE_OS_TARGETS.join(", ")
    )
}

fn is_lowercase_hex(seed: &str) -> bool {
    seed.bytes()
        .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

/// Validate an identity seed already persisted by an earlier Lobster release.
///
/// Fresh profiles use the canonical 128-bit form below. Historical releases intentionally accepted
/// shorter hex identities, however, and changing their bytes would change the browser identity. Keep
/// that compatibility bounded so corrupt, non-hex, or attacker-sized values still fail closed.
pub fn validate_fingerprint_seed(seed: &str) -> Result<()> {
    let valid = (8..=256).contains(&seed.len()) && is_lowercase_hex(seed);
    if valid {
        return Ok(());
    }
    anyhow::bail!("invalid fingerprint seed: expected 8 to 256 lowercase hexadecimal characters")
}

/// Validate a seed supplied while creating a new profile. New identities have one canonical wire
/// representation even though bounded legacy identities remain launchable and importable.
fn validate_canonical_fingerprint_seed(seed: &str) -> Result<()> {
    if seed.len() == 32 && is_lowercase_hex(seed) {
        return Ok(());
    }
    anyhow::bail!("invalid fingerprint seed: expected exactly 32 lowercase hexadecimal characters")
}

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
    /// When the pending import was applied to the browser's cookie jar. The payload above is KEPT
    /// once applied — see [`mark_cookie_import_applied`] — so this timestamp, not a NULL cell, is
    /// what stops the next launch re-injecting it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub cookies_import_applied_at: Option<String>,
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
    /// The machine running this profile right now, as the account sees it (see `presence.rs`).
    /// Never stored: merged into the list from the account's lease view.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub presence: Option<crate::presence::ProfilePresence>,
    /// Columns whose stored value could not be decrypted or parsed on this machine.
    ///
    /// DEGRADED, NOT FATAL. A single unreadable cell used to fail the whole row mapping, which fails
    /// the whole `list` — the user gets an empty, unexplained profile list and no route back. The
    /// row is returned instead with the affected field left `None` and named here, so the UI can say
    /// which profile is damaged and in what way. [`update`] then REFUSES to write such a row, which
    /// is what preserves the original point: a cell we could not read must never be overwritten by
    /// the `None` we substituted for it.
    #[serde(skip_serializing_if = "Vec::is_empty", default)]
    pub unreadable_secrets: Vec<String>,
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
        "cookies_import_applied_at",
        "ALTER TABLE profiles ADD COLUMN cookies_import_applied_at TEXT",
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
    ensure_column(
        conn,
        "remote_id",
        "ALTER TABLE profiles ADD COLUMN remote_id TEXT",
    )?;
    ensure_column(
        conn,
        "remote_version",
        "ALTER TABLE profiles ADD COLUMN remote_version INTEGER NOT NULL DEFAULT 0",
    )?;
    ensure_column(
        conn,
        "synced_at",
        "ALTER TABLE profiles ADD COLUMN synced_at TEXT",
    )?;
    // The index cannot live in `SCHEMA` alone: a database created before the column existed runs the
    // ALTERs above and would otherwise never get it, and two local rows pointing at one account row
    // means two machines' sessions overwriting each other under one blob key.
    conn.execute_batch(
        "CREATE UNIQUE INDEX IF NOT EXISTS idx_profiles_remote_id ON profiles(remote_id) \
         WHERE remote_id IS NOT NULL",
    )?;
    Ok(())
}

fn row_to_profile(cipher: &SecretCipher, row: &Row) -> rusqlite::Result<Profile> {
    let overrides_json: Option<String> = row.get("fingerprint_overrides")?;
    let proxy_json: Option<String> = row.get("proxy")?;
    let cookies_json: Option<String> = row.get("cookies_import")?;
    let extensions_json: Option<String> = row.get("extensions")?;
    let tags_json: String = row.get("tags")?;
    let password_hash: Option<String> = row.get("password_hash")?;

    // SEC-12: decrypt at the store boundary — proxy credentials are field-encrypted inside the
    // JSON; the cookies_import cell is encrypted as a whole. SEC-19: an undecryptable or malformed
    // cell must NOT be silently replaced by `None`, because `update()` then persisted that `None` as
    // NULL and destroyed the cell. It is recorded in `unreadable_secrets` and the row is still
    // returned — failing the mapping outright fails the entire `list` and blanks the app.
    let mut unreadable_secrets: Vec<String> = Vec::new();

    let proxy =
        proxy_json.and_then(
            |stored| match serde_json::from_str::<serde_json::Value>(&stored) {
                Ok(mut value) => {
                    match cipher.decrypt_json_fields(&mut value, PROXY_SECRET_FIELDS) {
                        Ok(()) => Some(value),
                        Err(_) => {
                            unreadable_secrets.push("proxy".to_string());
                            None
                        }
                    }
                }
                Err(_) => {
                    unreadable_secrets.push("proxy".to_string());
                    None
                }
            },
        );

    let cookies_import = cookies_json.and_then(|stored| match cipher.decrypt_strict(&stored) {
        Ok(plaintext) => match serde_json::from_str(&plaintext) {
            Ok(value) => Some(value),
            Err(_) => {
                unreadable_secrets.push("cookies_import".to_string());
                None
            }
        },
        Err(_) => {
            unreadable_secrets.push("cookies_import".to_string());
            None
        }
    });

    let fingerprint_overrides = overrides_json.and_then(|stored| {
        serde_json::from_str(&stored).ok().or_else(|| {
            unreadable_secrets.push("fingerprint_overrides".to_string());
            None
        })
    });

    let extensions = extensions_json.and_then(|stored| {
        serde_json::from_str(&stored).ok().or_else(|| {
            unreadable_secrets.push("extensions".to_string());
            None
        })
    });

    Ok(Profile {
        id: row.get("id")?,
        name: row.get("name")?,
        engine: row.get("engine")?,
        os: row.get("os")?,
        os_version: row.get("os_version")?,
        fingerprint_seed: row.get("fingerprint_seed")?,
        fingerprint_overrides,
        proxy,
        proxy_id: row.get("proxy_id")?,
        template_id: row.get("template_id")?,
        cookies_import,
        cookies_import_applied_at: row.get("cookies_import_applied_at")?,
        extensions,
        tags: serde_json::from_str(&tags_json).unwrap_or_default(),
        folder: row.get("folder")?,
        notes: row.get("notes")?,
        status: row.get("status")?,
        password_protected: password_hash.is_some(),
        trashed_at: row.get("trashed_at")?,
        created_at: row.get("created_at")?,
        updated_at: row.get("updated_at")?,
        presence: None,
        unreadable_secrets,
    })
}

fn validate_loaded_profile(profile: Profile) -> Result<Profile> {
    validate_fingerprint_seed(&profile.fingerprint_seed).map_err(|error| {
        anyhow::anyhow!(
            "profile {} has an invalid persisted fingerprint seed: {error}",
            profile.id
        )
    })?;
    Ok(profile)
}

/// A fresh 128-bit lowercase-hex fingerprint seed (32 hex chars).
fn new_seed() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn to_text(value: &Option<serde_json::Value>) -> Option<String> {
    value.as_ref().map(|v| v.to_string())
}

/// SEC-12 write path for the `proxy` column: serialize with credentials field-encrypted.
fn proxy_to_text(
    cipher: &SecretCipher,
    value: &Option<serde_json::Value>,
) -> Result<Option<String>> {
    match value {
        Some(v) => {
            let mut v = v.clone();
            cipher.encrypt_json_fields(&mut v, PROXY_SECRET_FIELDS)?;
            Ok(Some(v.to_string()))
        }
        None => Ok(None),
    }
}

/// SEC-12 write path for the `cookies_import` column: the whole payload is ciphertext on disk.
fn cookies_to_text(
    cipher: &SecretCipher,
    value: &Option<serde_json::Value>,
) -> Result<Option<String>> {
    value
        .as_ref()
        .map(|v| cipher.encrypt_str(&v.to_string()))
        .transpose()
}

pub fn list(conn: &Connection, cipher: &SecretCipher) -> Result<Vec<Profile>> {
    let mut stmt =
        conn.prepare("SELECT * FROM profiles WHERE trashed_at IS NULL ORDER BY created_at DESC")?;
    let rows = stmt.query_map([], |row| row_to_profile(cipher, row))?;
    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(validate_loaded_profile(row?)?);
    }
    Ok(profiles)
}

pub fn list_trashed(conn: &Connection, cipher: &SecretCipher) -> Result<Vec<Profile>> {
    let mut stmt = conn
        .prepare("SELECT * FROM profiles WHERE trashed_at IS NOT NULL ORDER BY trashed_at DESC")?;
    let rows = stmt.query_map([], |row| row_to_profile(cipher, row))?;
    let mut profiles = Vec::new();
    for row in rows {
        profiles.push(validate_loaded_profile(row?)?);
    }
    Ok(profiles)
}

pub fn get(conn: &Connection, cipher: &SecretCipher, id: &str) -> Result<Option<Profile>> {
    let mut stmt = conn.prepare("SELECT * FROM profiles WHERE id = ?1 AND trashed_at IS NULL")?;
    let mut rows = stmt.query_map([id], |row| row_to_profile(cipher, row))?;
    match rows.next() {
        Some(row) => Ok(Some(validate_loaded_profile(row?)?)),
        None => Ok(None),
    }
}

/// Profiles that count against the plan allowance: everything not in the trash.
///
/// Matches the server's own rule (`apps/backend/src/profiles/profiles.service.ts` counts
/// non-tombstoned rows), so the desktop cap and the cloud cap can never disagree about what "3
/// profiles" means.
pub fn count_active(conn: &Connection) -> Result<i64> {
    Ok(conn.query_row(
        "SELECT COUNT(*) FROM profiles WHERE trashed_at IS NULL",
        [],
        |row| row.get(0),
    )?)
}

pub fn create(
    conn: &Connection,
    cipher: &SecretCipher,
    input: CreateProfileInput,
) -> Result<Profile> {
    create_with_seed_validation(conn, cipher, input, validate_canonical_fingerprint_seed)
}

/// Materialise an imported profile without changing a bounded legacy identity seed.
pub(crate) fn create_preserving_fingerprint_seed(
    conn: &Connection,
    cipher: &SecretCipher,
    input: CreateProfileInput,
) -> Result<Profile> {
    create_with_seed_validation(conn, cipher, input, validate_fingerprint_seed)
}

fn create_with_seed_validation(
    conn: &Connection,
    cipher: &SecretCipher,
    input: CreateProfileInput,
    validate_supplied_seed: fn(&str) -> Result<()>,
) -> Result<Profile> {
    assert_creatable_os(&input.os)?;
    let id = format!("prf_{}", uuid::Uuid::new_v4().simple());
    // Every profile gets a UNIQUE seed unless one is explicitly supplied — never a shared constant.
    // A supplied value is identity, not a hint: reject malformed values instead of silently replacing
    // them with a fresh seed and changing the browser the caller meant to persist.
    let seed = match input.fingerprint_seed {
        Some(seed) => {
            validate_supplied_seed(&seed)?;
            seed
        }
        None => new_seed(),
    };
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
            proxy_to_text(
                cipher,
                &if input.proxy_id.as_deref().is_some_and(|id| !id.is_empty()) {
                    None
                } else {
                    input.proxy
                },
            )?,
            input.proxy_id.filter(|id| !id.is_empty()),
            input.template_id,
            cookies_to_text(cipher, &input.cookies_import)?,
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

    Ok(get(conn, cipher, &id)?.expect("row was just inserted"))
}

pub fn update(
    conn: &Connection,
    cipher: &SecretCipher,
    id: &str,
    patch: UpdateProfilePatch,
) -> Result<Option<Profile>> {
    let existing = match get(conn, cipher, id)? {
        Some(profile) => profile,
        None => return Ok(None),
    };

    // The write is refused rather than allowed to clobber. Every field below falls back to
    // `existing.<field>`, and for an unreadable cell that fallback is the `None` substituted during
    // the read — so saving would replace the cell with NULL and destroy the only copy. Refusing is
    // the whole point of SEC-19; the read was made non-fatal so the user can SEE the profile, not so
    // that editing it silently discards a session we merely failed to decrypt.
    if !existing.unreadable_secrets.is_empty() {
        anyhow::bail!(
            "profile {id} has values this machine cannot decrypt ({}); saving would overwrite them. \
             Re-enter the affected values to replace them, or restore this profile's secrets key.",
            existing.unreadable_secrets.join(", ")
        );
    }

    let name = patch.name.unwrap_or(existing.name);
    let engine = patch.engine.unwrap_or(existing.engine);
    let os = patch.os.unwrap_or_else(|| existing.os.clone());
    assert_updatable_os(&existing.os, &os)?;
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
    let proxy_selection_changed = patch.proxy_id.is_some();
    let proxy = if patch.proxy.is_some() {
        patch.proxy
    } else if proxy_selection_changed {
        // Selecting a stored proxy or "none" invalidates any legacy inline snapshot.
        None
    } else {
        existing.proxy
    };
    let proxy_id = if proxy_selection_changed {
        patch.proxy_id.filter(|id| !id.is_empty())
    } else {
        existing.proxy_id
    };
    let template_id = if patch.template_id.is_some() {
        patch.template_id
    } else {
        existing.template_id
    };
    // An applied import is kept, so "already applied" is a timestamp rather than a NULL cell. The
    // edit form round-trips rawText and therefore re-submits the SAME draft on every save; only a
    // genuinely DIFFERENT draft may re-arm the import, or every unrelated profile edit would
    // re-inject a stale session on the next launch.
    let cookies_import_changed = patch
        .cookies_import
        .as_ref()
        .is_some_and(|next| Some(next) != existing.cookies_import.as_ref());
    let cookies_import = if patch.cookies_import.is_some() {
        patch.cookies_import
    } else {
        existing.cookies_import
    };
    let cookies_import_applied_at = if cookies_import_changed {
        None
    } else {
        existing.cookies_import_applied_at
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
         proxy = ?7, proxy_id = ?8, template_id = ?9, cookies_import = ?10, cookies_import_applied_at = ?11, \
         extensions = ?12, tags = ?13, folder = ?14, notes = ?15, updated_at = ?16 WHERE id = ?1",
        params![
            id,
            name,
            engine,
            os,
            os_version,
            to_text(&overrides),
            proxy_to_text(cipher, &proxy)?,
            proxy_id,
            template_id,
            cookies_to_text(cipher, &cookies_import)?,
            cookies_import_applied_at,
            to_text(&extensions),
            serde_json::to_string(&tags)?,
            folder,
            notes,
            now,
        ],
    )?;

    get(conn, cipher, id)
}

pub fn delete(conn: &Connection, id: &str) -> Result<bool> {
    let now = chrono::Utc::now().to_rfc3339();
    let affected = conn.execute(
        "UPDATE profiles SET trashed_at = ?2, updated_at = ?2 WHERE id = ?1 AND trashed_at IS NULL \
         AND status NOT IN ('launching', 'running', 'stopping')",
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

/// Set the stored Argon2 PHC hash directly, without a plaintext password.
///
/// Exists for profile import ([`crate::profile_portable`]): a password-protected profile must arrive
/// still protected, and the exporting machine only ever had the hash — by design, since the whole
/// point of storing a hash is that the plaintext is unrecoverable. [`set_password`] cannot express
/// that, because it takes the plaintext and derives the hash itself.
///
/// The caller is responsible for the value being a real PHC string; it is written verbatim.
pub fn set_password_hash(conn: &Connection, id: &str, hash: Option<&str>) -> Result<bool> {
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
        "DELETE FROM profiles WHERE id = ?1 AND trashed_at IS NOT NULL \
         AND status NOT IN ('launching', 'running', 'stopping')",
        params![id],
    )?;
    Ok(affected > 0)
}

pub fn set_status(conn: &Connection, id: &str, status: &str) -> Result<bool> {
    if !matches!(
        status,
        "idle" | "launching" | "running" | "stopping" | "error"
    ) {
        anyhow::bail!("invalid profile status {status}");
    }
    // `updated_at` is deliberately NOT touched. Status is lifecycle bookkeeping — what this machine's
    // sidecar is doing right now — not an edit to the profile. Bumping it made dirtiness (derived as
    // updated_at > synced_at) true for every running profile, so the 60 s reconcile re-uploaded a
    // launched profile forever, and the 2 s status poll kept re-dirtying it between uploads.
    Ok(conn.execute(
        "UPDATE profiles SET status = ?2 WHERE id = ?1 AND status <> ?2",
        params![id, status],
    )? > 0)
}

/// Stamp a pending import as applied, only after the sidecar confirms CDP application.
///
/// The payload is PRESERVED. Nulling it (what this replaces) destroyed the only durable record of
/// the profile's session on its first successful launch: nothing snapshots the live cookie jar, so
/// afterwards the edit form showed an empty cookie box for a logged-in profile and a backup would
/// have had nothing to send. The launch path skips an import that carries this timestamp.
pub fn mark_cookie_import_applied(conn: &Connection, id: &str) -> Result<bool> {
    let now = chrono::Utc::now().to_rfc3339();
    Ok(conn.execute(
        "UPDATE profiles SET cookies_import_applied_at = ?2, updated_at = ?2 \
         WHERE id = ?1 AND cookies_import IS NOT NULL AND cookies_import_applied_at IS NULL",
        params![id, now],
    )? > 0)
}

/// Where a profile stands against the account.
///
/// `remote_id` is the account's id for it — the identifier both machines agree on, and the one the
/// blob and its content key are keyed by. `remote_version` is the server blob version this machine
/// last saw, which a push sends as `baseVersion`: a stale one is a 409 rather than an overwrite of
/// somebody else's session.
#[derive(Debug, Clone)]
pub struct SyncLink {
    pub remote_id: Option<String>,
    pub remote_version: u64,
    pub synced_at: Option<String>,
    /// The profile changed locally after its last successful sync, so a push would carry something
    /// new. Derived rather than stored: a `dirty` flag has to be set by every write path, and one
    /// path that forgets is a profile that silently stops backing up.
    pub dirty: bool,
}

pub fn sync_link(conn: &Connection, id: &str) -> Result<Option<SyncLink>> {
    let mut stmt = conn.prepare(
        "SELECT remote_id, remote_version, synced_at, updated_at FROM profiles WHERE id = ?1",
    )?;
    let mut rows = stmt.query(params![id])?;
    let Some(row) = rows.next()? else {
        return Ok(None);
    };
    let synced_at: Option<String> = row.get(2)?;
    let updated_at: String = row.get(3)?;
    Ok(Some(SyncLink {
        remote_id: row.get(0)?,
        remote_version: row.get::<_, i64>(1)?.max(0) as u64,
        dirty: synced_at
            .as_deref()
            .is_none_or(|at| updated_at.as_str() > at),
        synced_at,
    }))
}

/// Bind a local profile to the account's row for it.
pub fn set_remote_id(conn: &Connection, id: &str, remote_id: &str) -> Result<bool> {
    // `updated_at` is deliberately NOT touched: binding is bookkeeping, not an edit to the profile,
    // and bumping it would make every freshly-linked profile look dirty forever.
    Ok(conn.execute(
        "UPDATE profiles SET remote_id = ?2 WHERE id = ?1",
        params![id, remote_id],
    )? > 0)
}

/// Record that this machine and the account now agree at `remote_version`.
pub fn mark_synced(conn: &Connection, id: &str, remote_version: u64) -> Result<bool> {
    let now = chrono::Utc::now().to_rfc3339();
    Ok(conn.execute(
        "UPDATE profiles SET remote_version = ?2, synced_at = ?3 WHERE id = ?1",
        params![id, remote_version as i64, now],
    )? > 0)
}

/// The local profile bound to an account row, if this machine has one.
pub fn find_by_remote_id(
    conn: &Connection,
    cipher: &SecretCipher,
    remote_id: &str,
) -> Result<Option<Profile>> {
    let mut stmt = conn.prepare("SELECT * FROM profiles WHERE remote_id = ?1")?;
    let mut rows = stmt.query(params![remote_id])?;
    match rows.next()? {
        Some(row) => Ok(Some(validate_loaded_profile(row_to_profile(cipher, row)?)?)),
        None => Ok(None),
    }
}

/// Make persisted lifecycle state agree with the sidecar's authoritative running set.
pub fn reconcile_statuses(
    conn: &Connection,
    running_ids: &[String],
    error_ids: &[String],
) -> Result<()> {
    // No `updated_at` writes anywhere in here, for the reason given at `set_status`: this runs on
    // every list refresh (a 2 s poll), and a lifecycle stamp that counted as an edit kept every
    // running profile permanently dirty and re-uploaded on each reconcile.
    conn.execute(
        "UPDATE profiles SET status = 'idle' \
         WHERE status IN ('launching', 'running', 'stopping')",
        [],
    )?;
    for id in error_ids {
        conn.execute(
            "UPDATE profiles SET status = 'error' \
             WHERE id = ?1 AND trashed_at IS NULL AND status <> 'error'",
            params![id],
        )?;
    }
    for id in running_ids {
        conn.execute(
            "UPDATE profiles SET status = 'running' \
             WHERE id = ?1 AND trashed_at IS NULL AND status <> 'running'",
            params![id],
        )?;
    }
    Ok(())
}

pub fn get_trashed(conn: &Connection, cipher: &SecretCipher, id: &str) -> Result<Option<Profile>> {
    let mut stmt =
        conn.prepare("SELECT * FROM profiles WHERE id = ?1 AND trashed_at IS NOT NULL")?;
    let mut rows = stmt.query_map([id], |row| row_to_profile(cipher, row))?;
    match rows.next() {
        Some(row) => Ok(Some(validate_loaded_profile(row?)?)),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mem() -> Connection {
        let conn = Connection::open_in_memory().unwrap();
        // SCHEMA *and* migrate, in the same order `init` uses. SCHEMA alone is a shape that never
        // exists on a real machine — it omits everything `migrate` adds, including the
        // idx_profiles_remote_id uniqueness constraint that several tests below assert on.
        conn.execute_batch(SCHEMA).unwrap();
        migrate(&conn).unwrap();
        conn
    }

    fn test_cipher() -> SecretCipher {
        SecretCipher::new(&[42u8; 32])
    }

    fn input(name: &str) -> CreateProfileInput {
        CreateProfileInput {
            name: name.to_string(),
            engine: "lobium".to_string(),
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

    fn patch_with_cookies(cookies_import: Option<serde_json::Value>) -> UpdateProfilePatch {
        UpdateProfilePatch {
            name: None,
            engine: None,
            os: None,
            os_version: None,
            fingerprint_overrides: None,
            proxy: None,
            proxy_id: None,
            template_id: None,
            cookies_import,
            extensions: None,
            tags: None,
            folder: None,
            notes: None,
        }
    }

    #[test]
    fn create_assigns_unique_seeds() {
        let conn = mem();
        let cipher = test_cipher();
        let a = create(&conn, &cipher, input("A")).unwrap();
        let b = create(&conn, &cipher, input("B")).unwrap();
        assert_eq!(a.fingerprint_seed.len(), 32);
        assert_ne!(
            a.fingerprint_seed, b.fingerprint_seed,
            "each profile needs its own seed"
        );
        assert_eq!(list(&conn, &cipher).unwrap().len(), 2);
    }

    #[test]
    fn supplied_seed_must_be_exactly_32_lowercase_hex_characters() {
        let conn = mem();
        let cipher = test_cipher();
        let invalid = [
            "".to_string(),
            "g123456789abcdef0123456789abcdef".to_string(),
            "0123456789ABCDEF0123456789ABCDEF".to_string(),
            "0123456789abcdef0123456789abcde".to_string(),
            "0123456789abcdef0123456789abcdef0".to_string(),
            "a".repeat(1024 * 1024),
        ];

        for (index, seed) in invalid.into_iter().enumerate() {
            let mut candidate = input(&format!("Invalid {index}"));
            candidate.fingerprint_seed = Some(seed);
            let error = create(&conn, &cipher, candidate)
                .expect_err("a malformed supplied seed must be rejected, never regenerated");
            assert!(
                error
                    .to_string()
                    .contains("expected exactly 32 lowercase hexadecimal characters"),
                "unexpected error: {error:#}"
            );
        }
        assert_eq!(
            count_active(&conn).unwrap(),
            0,
            "no invalid row may be written"
        );

        let valid_seed = "0123456789abcdef0123456789abcdef";
        let mut candidate = input("Valid");
        candidate.fingerprint_seed = Some(valid_seed.to_string());
        let created = create(&conn, &cipher, candidate).expect("the canonical seed form is valid");
        assert_eq!(created.fingerprint_seed, valid_seed);
    }

    #[test]
    fn a_legacy_persisted_seed_is_loaded_without_changing_identity() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("Legacy")).unwrap();
        conn.execute(
            "UPDATE profiles SET fingerprint_seed = 'deadbeef' WHERE id = ?1",
            params![created.id],
        )
        .unwrap();

        let loaded = get(&conn, &cipher, &created.id)
            .expect("legacy seed must remain readable")
            .expect("profile exists");
        assert_eq!(loaded.fingerprint_seed, "deadbeef");
    }

    #[test]
    fn persisted_seed_validation_is_bounded_lowercase_hex() {
        assert!(validate_fingerprint_seed("deadbeef").is_ok());
        assert!(validate_fingerprint_seed(&"a".repeat(256)).is_ok());
        for invalid in [
            "".to_string(),
            "abcdefg".to_string(),
            "deadbeeG".to_string(),
            "DEADBEEF".to_string(),
            "a".repeat(257),
            "a".repeat(1024 * 1024),
        ] {
            let error = validate_fingerprint_seed(&invalid)
                .expect_err("malformed persisted identity must fail closed");
            assert!(
                error.to_string().contains("8 to 256 lowercase hexadecimal"),
                "unexpected error: {error:#}"
            );
        }
    }

    #[test]
    fn create_accepts_android_os_target() {
        let conn = mem();
        let cipher = test_cipher();
        let mut android = input("Android");
        android.os = "android".to_string();
        let created = create(&conn, &cipher, android).expect("android create must succeed");
        assert_eq!(created.os, "android");
        assert_eq!(list(&conn, &cipher).unwrap().len(), 1);
    }

    #[test]
    fn update_accepts_switching_desktop_profile_to_android() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("Desktop")).unwrap();
        let updated = update(
            &conn,
            &cipher,
            &created.id,
            UpdateProfilePatch {
                name: None,
                engine: None,
                os: Some("android".to_string()),
                os_version: None,
                fingerprint_overrides: None,
                proxy: None,
                proxy_id: None,
                template_id: None,
                cookies_import: None,
                extensions: None,
                tags: None,
                folder: None,
                notes: None,
            },
        )
        .expect("android switch must succeed")
        .expect("profile exists");
        assert_eq!(updated.os, "android");
    }

    #[test]
    fn update_persists_engine_os_and_overrides() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("C")).unwrap();
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
        let updated = update(&conn, &cipher, &created.id, patch).unwrap().unwrap();
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
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("D")).unwrap();
        assert!(delete(&conn, &created.id).unwrap());
        assert!(get(&conn, &cipher, &created.id).unwrap().is_none());
        assert_eq!(list(&conn, &cipher).unwrap().len(), 0);
        let trashed = list_trashed(&conn, &cipher).unwrap();
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

    /// The whole point of the cap, exercised as `create_profile` composes it: read the cached
    /// allowance, count live profiles, refuse at the boundary. A free account gets three and is
    /// stopped on the fourth.
    #[test]
    fn the_free_allowance_stops_the_fourth_profile() {
        let conn = mem();
        let cipher = test_cipher();
        let dir =
            std::env::temp_dir().join(format!("lobster-cap-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();

        // Nothing cached: an unread account is treated as free, never unlimited.
        let limit = crate::account::cached_profile_limit(&dir);
        assert_eq!(limit, 3);

        for n in 0..3 {
            assert!(
                count_active(&conn).unwrap() < limit,
                "profile {n} must be within the allowance"
            );
            create(&conn, &cipher, input(&format!("p{n}"))).unwrap();
        }
        assert_eq!(
            count_active(&conn).unwrap(),
            limit,
            "the allowance is now exactly consumed"
        );
        assert!(
            count_active(&conn).unwrap() >= limit,
            "the fourth create must be refused"
        );

        // Buying a bigger package lifts it without touching any profile.
        crate::account::cache_entitlement(&dir, "pro", 200);
        assert!(count_active(&conn).unwrap() < crate::account::cached_profile_limit(&dir));

        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn count_active_counts_what_the_plan_cap_counts() {
        // The cap compares against THIS number, so it has to mean the same thing the server means:
        // live profiles only. Counting tombstones would let a user who deleted three profiles be
        // locked out of creating a fourth.
        let conn = mem();
        let cipher = test_cipher();
        assert_eq!(count_active(&conn).unwrap(), 0);

        for name in ["one", "two", "three"] {
            create(&conn, &cipher, input(name)).unwrap();
        }
        assert_eq!(count_active(&conn).unwrap(), 3);

        let listed = list(&conn, &cipher).unwrap();
        let victim = listed.first().expect("a profile to trash");
        delete(&conn, &victim.id).unwrap();
        assert_eq!(
            count_active(&conn).unwrap(),
            2,
            "a trashed profile must free its slot"
        );
    }

    #[test]
    fn set_password_hashes_and_removes_profile_password() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("P")).unwrap();
        assert!(!created.password_protected);
        assert!(set_password(&conn, &created.id, Some("secret".to_string())).unwrap());
        let protected = get(&conn, &cipher, &created.id).unwrap().unwrap();
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
            !get(&conn, &cipher, &protected.id)
                .unwrap()
                .unwrap()
                .password_protected
        );
    }

    #[test]
    fn verify_password_blocks_wrong_or_missing_password() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("Locked")).unwrap();
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
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("E")).unwrap();
        assert!(delete(&conn, &created.id).unwrap());
        assert!(restore(&conn, &created.id).unwrap());
        assert!(list_trashed(&conn, &cipher).unwrap().is_empty());
        assert!(get(&conn, &cipher, &created.id).unwrap().is_some());
        assert_eq!(list(&conn, &cipher).unwrap().len(), 1);
        assert!(!restore(&conn, &created.id).unwrap());
    }

    #[test]
    fn purge_permanently_removes_only_trashed_profiles() {
        let conn = mem();
        let cipher = test_cipher();
        let active = create(&conn, &cipher, input("F")).unwrap();
        let trashed = create(&conn, &cipher, input("G")).unwrap();
        assert!(!purge(&conn, &active.id).unwrap());
        assert!(delete(&conn, &trashed.id).unwrap());
        assert!(purge(&conn, &trashed.id).unwrap());
        assert_eq!(list(&conn, &cipher).unwrap().len(), 1);
        assert_eq!(list(&conn, &cipher).unwrap()[0].id, active.id);
        assert!(list_trashed(&conn, &cipher).unwrap().is_empty());
    }

    /// The `cookies_import_applied_at` migration has to be safe on the profiles.sqlite already on
    /// users' disks. Every other test here builds a fresh DB from the current `SCHEMA`, so the ALTER
    /// chain in `migrate` is otherwise unexercised — one missed column and the profile list fails to
    /// load for every existing install.
    #[test]
    fn init_migrates_a_database_created_before_the_applied_at_column() {
        let dir =
            std::env::temp_dir().join(format!("lobster-migrate-{}", uuid::Uuid::new_v4().simple()));
        std::fs::create_dir_all(&dir).unwrap();
        let db_path = dir.join("profiles.sqlite");
        let cipher = test_cipher();
        {
            // Every column added after the first release, not just one. Filtering a single
            // column left `remote_id` present in the "legacy" database, so the ordering bug that
            // panicked every real upgrade could not reproduce here.
            let legacy_schema = SCHEMA
                .lines()
                .filter(|line| {
                    ![
                        "cookies_import_applied_at",
                        "remote_id",
                        "remote_version",
                        "synced_at",
                    ]
                    .iter()
                    .any(|c| line.contains(c))
                })
                .collect::<Vec<_>>()
                .join("\n");
            let legacy = Connection::open(&db_path).unwrap();
            legacy.execute_batch(&legacy_schema).unwrap();
            legacy
                .execute(
                    "INSERT INTO profiles \
                     (id, name, engine, os, fingerprint_seed, cookies_import, tags, status, created_at, updated_at) \
                     VALUES ('prf_legacy', 'Existing', 'lobium', 'windows', \
                             '0123456789abcdef0123456789abcdef', ?1, '[]', 'idle', ?2, ?2)",
                    params![
                        cipher
                            .encrypt_str(&serde_json::json!({ "mode": "merge" }).to_string())
                            .unwrap(),
                        "2025-01-01T00:00:00Z"
                    ],
                )
                .unwrap();
        }

        let conn = init(&db_path).unwrap();
        let listed = list(&conn, &cipher).unwrap();
        assert_eq!(listed.len(), 1, "existing rows must survive the migration");
        assert!(listed[0].cookies_import.is_some());
        assert!(
            listed[0].cookies_import_applied_at.is_none(),
            "a pre-migration import is still pending, not silently applied"
        );
        assert!(mark_cookie_import_applied(&conn, "prf_legacy").unwrap());
        drop(conn);
        std::fs::remove_dir_all(dir).unwrap();
    }

    /// SEC-12: profile proxy credentials and the cookie-import payload must be ciphertext in the
    /// raw SQLite cells, while the store API round-trips the original plaintext.
    #[test]
    fn profile_proxy_and_cookie_secrets_are_encrypted_at_rest() {
        let conn = mem();
        let cipher = test_cipher();
        let mut new_profile = input("Secret");
        new_profile.proxy = Some(serde_json::json!({
            "type": "http", "host": "proxy.example", "port": 8080,
            "username": "alice-user", "password": "hunter2-topsecret"
        }));
        new_profile.cookies_import = Some(serde_json::json!({
            "mode": "replace",
            "cookies": [{ "name": "session", "value": "super-secret-session-token" }]
        }));
        let created = create(&conn, &cipher, new_profile).unwrap();

        let (raw_proxy, raw_cookies): (String, String) = conn
            .query_row(
                "SELECT proxy, cookies_import FROM profiles WHERE id = ?1",
                params![created.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert!(!raw_proxy.contains("hunter2-topsecret"));
        assert!(!raw_proxy.contains("alice-user"));
        assert!(raw_proxy.contains("lbsec1:"));
        assert!(
            raw_proxy.contains("proxy.example"),
            "non-secret fields stay readable"
        );
        assert!(!raw_cookies.contains("super-secret-session-token"));
        assert!(raw_cookies.starts_with("lbsec1:"));

        let fetched = get(&conn, &cipher, &created.id).unwrap().unwrap();
        let proxy = fetched.proxy.unwrap();
        assert_eq!(proxy["username"], "alice-user");
        assert_eq!(proxy["password"], "hunter2-topsecret");
        assert_eq!(
            fetched.cookies_import.unwrap()["cookies"][0]["value"],
            "super-secret-session-token"
        );
    }

    #[test]
    fn stored_proxy_selection_clears_inline_snapshot_and_pending_cookie_is_consumed_once() {
        let conn = mem();
        let cipher = test_cipher();
        let mut new_profile = input("Lifecycle");
        new_profile.proxy = Some(serde_json::json!({
            "id": "inline", "type": "http", "host": "old.example", "port": 80
        }));
        new_profile.cookies_import = Some(serde_json::json!({
            "mode": "empty"
        }));
        let created = create(&conn, &cipher, new_profile).unwrap();
        let updated = update(
            &conn,
            &cipher,
            &created.id,
            UpdateProfilePatch {
                name: None,
                engine: None,
                os: None,
                os_version: None,
                fingerprint_overrides: None,
                proxy: None,
                proxy_id: Some("px_current".to_string()),
                template_id: None,
                cookies_import: None,
                extensions: None,
                tags: None,
                folder: None,
                notes: None,
            },
        )
        .unwrap()
        .unwrap();
        assert!(updated.proxy.is_none());
        assert_eq!(updated.proxy_id.as_deref(), Some("px_current"));
        assert!(mark_cookie_import_applied(&conn, &created.id).unwrap());
        assert!(!mark_cookie_import_applied(&conn, &created.id).unwrap());
        let applied = get(&conn, &cipher, &created.id).unwrap().unwrap();
        assert!(
            applied.cookies_import.is_some(),
            "an applied import stays on the row as the profile's session record"
        );
        assert!(applied.cookies_import_applied_at.is_some());
    }

    /// Fix for the data loss this replaced: the import survives, and a save that re-submits the SAME
    /// draft (what the edit form does, since it now reads rawText back) must not re-arm it.
    #[test]
    fn applied_cookie_import_survives_and_only_a_different_draft_re_arms_it() {
        let conn = mem();
        let cipher = test_cipher();
        let draft = serde_json::json!({
            "mode": "merge", "source": "plain_text",
            "rawText": "example.test\tFALSE\t/\tFALSE\t0\tsid\tsecret"
        });
        let mut new_profile = input("Session");
        new_profile.cookies_import = Some(draft.clone());
        let created = create(&conn, &cipher, new_profile).unwrap();
        assert!(created.cookies_import_applied_at.is_none());
        assert!(mark_cookie_import_applied(&conn, &created.id).unwrap());

        let resaved = update(&conn, &cipher, &created.id, patch_with_cookies(Some(draft)))
            .unwrap()
            .unwrap();
        assert_eq!(
            resaved.cookies_import.as_ref().unwrap()["rawText"],
            "example.test\tFALSE\t/\tFALSE\t0\tsid\tsecret",
            "rawText must survive both the launch and the re-save"
        );
        assert!(
            resaved.cookies_import_applied_at.is_some(),
            "re-saving the same draft must not re-inject it on the next launch"
        );

        let replaced = update(
            &conn,
            &cipher,
            &created.id,
            patch_with_cookies(Some(serde_json::json!({
                "mode": "replace", "source": "plain_text", "rawText": "other.test\tFALSE\t/\tFALSE\t0\tsid\tfresh"
            }))),
        )
        .unwrap()
        .unwrap();
        assert!(
            replaced.cookies_import_applied_at.is_none(),
            "a genuinely new import has to be applied"
        );
    }

    /// SEC-19: a cell we cannot decrypt must fail the read. The old fallback returned `None`, and
    /// the next `update()` wrote that `None` back — destroying the row's session and overrides.
    #[test]
    fn an_undecryptable_cell_is_reported_and_never_overwritten() {
        let conn = mem();
        let cipher = test_cipher();
        let mut new_profile = input("Foreign key");
        new_profile.cookies_import = Some(serde_json::json!({ "mode": "merge" }));
        let created = create(&conn, &cipher, new_profile).unwrap();
        let stored_cell: String = conn
            .query_row(
                "SELECT cookies_import FROM profiles WHERE id = ?1",
                params![created.id],
                |row| row.get(0),
            )
            .unwrap();

        // Another install's key: the row still LISTS — failing the mapping would fail the whole
        // query and leave the user with an empty app — but the damage is named.
        let stranger = SecretCipher::new(&[7u8; 32]);
        let read = get(&conn, &stranger, &created.id).unwrap().unwrap();
        assert!(read.cookies_import.is_none(), "the cell is not guessed at");
        assert_eq!(read.unreadable_secrets, vec!["cookies_import".to_string()]);
        assert_eq!(list(&conn, &stranger).unwrap().len(), 1, "list still works");

        // ...and the write is refused, which is what actually protects the cell: every field in
        // `update` falls back to the value from the read, and that value is now None.
        let err = update(&conn, &stranger, &created.id, patch_with_cookies(None))
            .expect_err("saving a row with an unreadable cell must be refused");
        assert!(
            err.to_string().contains("cannot decrypt"),
            "the error names the cause: {err}"
        );
        let after: String = conn
            .query_row(
                "SELECT cookies_import FROM profiles WHERE id = ?1",
                params![created.id],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(after, stored_cell, "the ciphertext is byte-for-byte intact");

        // Unencrypted JSON planted directly in the cell is an injection attempt, not legacy data:
        // it has no `lbsec1:` prefix, so it must not be honoured as a cookie import.
        conn.execute(
            "UPDATE profiles SET cookies_import = ?2 WHERE id = ?1",
            params![
                created.id,
                r#"{"mode":"replace","cookies":[{"name":"sid","value":"attacker"}]}"#
            ],
        )
        .unwrap();
        let planted = get(&conn, &cipher, &created.id).unwrap().unwrap();
        assert!(planted.cookies_import.is_none(), "plaintext is not trusted");
        assert_eq!(
            planted.unreadable_secrets,
            vec!["cookies_import".to_string()]
        );

        conn.execute(
            "UPDATE profiles SET cookies_import = NULL, fingerprint_overrides = 'not json' WHERE id = ?1",
            params![created.id],
        )
        .unwrap();
        let broken = get(&conn, &cipher, &created.id).unwrap().unwrap();
        assert!(broken.fingerprint_overrides.is_none());
        assert_eq!(
            broken.unreadable_secrets,
            vec!["fingerprint_overrides".to_string()]
        );
    }

    #[test]
    fn lifecycle_reconciliation_and_live_delete_are_fail_closed() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("Running")).unwrap();
        assert!(set_status(&conn, &created.id, "launching").unwrap());
        assert!(!delete(&conn, &created.id).unwrap());
        reconcile_statuses(&conn, std::slice::from_ref(&created.id), &[]).unwrap();
        assert_eq!(
            get(&conn, &cipher, &created.id).unwrap().unwrap().status,
            "running"
        );
        reconcile_statuses(&conn, &[], &[]).unwrap();
        assert_eq!(
            get(&conn, &cipher, &created.id).unwrap().unwrap().status,
            "idle"
        );
        assert!(delete(&conn, &created.id).unwrap());
    }

    /// The sync link decides direction, so its two facts have to be right: which account row this is,
    /// and whether the profile has changed since it last agreed with that row.
    #[test]
    fn the_sync_link_tracks_the_account_row_and_whether_the_profile_has_moved_on() {
        let conn = mem();
        let cipher = test_cipher();
        let created = create(&conn, &cipher, input("Syncable")).unwrap();

        // Never synced: no link, and dirty — there is nothing on the account to be clean against.
        let link = sync_link(&conn, &created.id).unwrap().unwrap();
        assert!(link.remote_id.is_none());
        assert_eq!(link.remote_version, 0);
        assert!(link.dirty);

        assert!(set_remote_id(&conn, &created.id, "srv-1").unwrap());
        assert!(mark_synced(&conn, &created.id, 4).unwrap());
        let link = sync_link(&conn, &created.id).unwrap().unwrap();
        assert_eq!(link.remote_id.as_deref(), Some("srv-1"));
        assert_eq!(link.remote_version, 4);
        assert!(!link.dirty, "a profile that was just pushed is not dirty");

        // An edit moves it on again, which is the whole trigger for the next push.
        std::thread::sleep(std::time::Duration::from_millis(5));
        update(
            &conn,
            &cipher,
            &created.id,
            UpdateProfilePatch {
                notes: Some("changed here".into()),
                ..patch_with_cookies(None)
            },
        )
        .unwrap();
        assert!(sync_link(&conn, &created.id).unwrap().unwrap().dirty);

        // Binding is not an edit: it must not make a freshly linked profile look changed forever.
        assert!(mark_synced(&conn, &created.id, 5).unwrap());
        assert!(set_remote_id(&conn, &created.id, "srv-1").unwrap());
        assert!(!sync_link(&conn, &created.id).unwrap().unwrap().dirty);

        assert_eq!(
            find_by_remote_id(&conn, &cipher, "srv-1")
                .unwrap()
                .unwrap()
                .id,
            created.id
        );
        assert!(find_by_remote_id(&conn, &cipher, "srv-nothing")
            .unwrap()
            .is_none());
    }

    /// Two local profiles pointing at one account row would fight over a single blob, each push
    /// clobbering the other. The database refuses it rather than the code remembering to.
    #[test]
    fn one_account_row_can_only_be_claimed_by_one_local_profile() {
        let conn = mem();
        let cipher = test_cipher();
        let first = create(&conn, &cipher, input("First")).unwrap();
        let second = create(&conn, &cipher, input("Second")).unwrap();

        assert!(set_remote_id(&conn, &first.id, "srv-shared").unwrap());
        assert!(set_remote_id(&conn, &second.id, "srv-shared").is_err());
        // Unlinked rows are all NULL and must not collide with each other.
        assert!(sync_link(&conn, &second.id)
            .unwrap()
            .unwrap()
            .remote_id
            .is_none());
    }
}
