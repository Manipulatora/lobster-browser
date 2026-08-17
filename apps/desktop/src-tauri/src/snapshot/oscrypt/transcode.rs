//! The portable database transcoder: the bridge between the OSCrypt codec and the three key-bearing
//! SQLite stores (`Cookies`, `Login Data`, `Web Data`).
//!
//! ## Why a verbatim database PLUS a plaintext sidecar
//!
//! We cannot defer decryption to restore time: a Windows-sealed cookie value's key lives in that
//! machine's DPAPI and is never present on a Linux or macOS target, so the only host that can read it
//! is the one that made it. Decryption therefore happens at CAPTURE, and the plaintext travels inside
//! our own sealed artifact.
//!
//! We also cannot rebuild these databases from structured rows: `Login Data` and `Web Data` are
//! dozens of Chromium-authored tables with their own migrations, and reconstructing them by hand is a
//! fragile way to lose the unencrypted columns. So the transport is the VERBATIM `VACUUM INTO` output
//! — every table, index and unencrypted column exactly as Chromium wrote it, with the encrypted cells
//! still holding their SOURCE-key ciphertext — PLUS a sidecar mapping `rowid → decrypted plaintext`
//! for those cells. On restore we write the verbatim database, then UPDATE each encrypted cell to
//! ciphertext under the TARGET key. Between the two the cell holds source-key ciphertext, never
//! plaintext; the only plaintext on disk is the intentional, Chromium-supported cookie `value`
//! fallback, which the design chooses explicitly and surfaces as `atRest:"plaintext"`.
//!
//! ## The failure modes this is built around (from the fork)
//!
//! * A cookie the target cannot decrypt is not one lost row — Chromium's `LoadCookiesForDomains`
//!   `DELETE`s the entire eTLD+1 group from disk. So we NEVER write a ciphertext we have not verified
//!   loadable, and the read-back below is load-bearing, not belt-and-braces.
//! * A password decrypt failure counts the row as undecryptable; a wrong-key AUTOFILL value fails
//!   OPEN to an empty string with the row intact — silent blanking that reports success. Neither has a
//!   plaintext fallback, so when the target key is unreachable we DO NOT write these stores at all
//!   (leaving the target's own intact), rather than write values that would blank or purge.

use std::path::{Path, PathBuf};

use anyhow::{bail, Context, Result};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use crate::snapshot::manifest::PortableKind;

use super::{
    decrypt_cookie_value, decrypt_value, encrypt_cookie_value, encrypt_value, OsCryptKeyring,
};

/// The autofill columns that hold OSCrypt ciphertext, from the fork. `(table, column)`; the id is
/// always the table's `rowid` (none of these are `WITHOUT ROWID`, verified on real `Web Data`). The
/// plain `autofill` form-history table is NOT here — it is unencrypted and rides verbatim. A column
/// absent from a given database is skipped, so this list is a superset and schema drift degrades to
/// "nothing to transcode" rather than an error.
const AUTOFILL_ENCRYPTED_COLUMNS: &[(&str, &str)] = &[
    ("credit_cards", "card_number_encrypted"),
    ("local_ibans", "value_encrypted"),
    ("local_stored_cvc", "value_encrypted"),
    ("server_stored_cvc", "value_encrypted"),
    ("generic_payment_instruments", "serialized_value_encrypted"),
];

/// One file's worth of verbatim database bytes, keyed by its user-data-dir-relative path.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableFile {
    pub rel: String,
    pub bytes: Vec<u8>,
}

/// A decrypted cell awaiting re-encryption on the target. `plaintext` carries NO domain-hash prefix —
/// for cookies the prefix is recomputed from `host_key` at re-encrypt time.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableCell {
    pub rowid: i64,
    /// Cookies only: the row's `host_key`, needed for the `SHA256(host_key)` prefix and the oracle.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub host_key: Option<String>,
    pub table: String,
    pub column: String,
    pub plaintext: Vec<u8>,
}

/// The decrypted cells for one database file.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableDb {
    pub rel: String,
    pub cells: Vec<PortableCell>,
}

/// The full portable payload for one artifact: the verbatim databases, the store kind, the source
/// scheme, and the decrypted sidecar. This is what the vault seals under LBv1 — the plaintext in
/// `dbs` exists in memory and inside that sealed blob, never as an unsealed file on disk.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct PortableArtifact {
    pub kind: PortableKind,
    /// `v10-aes128cbc` / `v10-aes256gcm` — the scheme the sidecar values were decrypted FROM.
    pub scheme: String,
    pub files: Vec<PortableFile>,
    pub dbs: Vec<PortableDb>,
}

impl PortableArtifact {
    pub fn encode(&self) -> Result<Vec<u8>> {
        let mut out = Vec::new();
        ciborium::into_writer(self, &mut out).context("encoding portable artifact")?;
        Ok(out)
    }

    pub fn decode(bytes: &[u8]) -> Result<Self> {
        ciborium::from_reader(bytes).context("decoding portable artifact")
    }
}

/// Where a restored value ended up living, surfaced in the report and (for cookies) the UI.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum AtRest {
    /// Re-sealed under the target OSCrypt key. The normal outcome.
    Encrypted,
    /// Cookies only: the target key was unreachable, so values were written to the plaintext `value`
    /// column (Chromium's supported empty-`encrypted_value` state). Loadable, and honestly labelled.
    Plaintext,
    /// Passwords/autofill only: the target key was unreachable and there is no safe degraded write, so
    /// the store was NOT restored — the target keeps whatever it already had.
    Unavailable,
}

/// What `restore_cells` decided to do with a database, and the counts behind it.
pub struct CellOutcome {
    pub at_rest: AtRest,
    /// Cells re-sealed under the target key (or written as plaintext for the cookie fallback).
    pub applied: u64,
    /// True when the caller must NOT swap this artifact in — the honest "not restored" for a
    /// password/autofill store whose target key is unreachable.
    pub skip_artifact: bool,
    #[allow(dead_code)]
    pub reason: Option<String>,
}

// --- Capture -------------------------------------------------------------------------------------

/// Read the verbatim database at each `(rel, path)` and decrypt its encrypted cells under the host
/// keyring, producing the portable payload. Plaintext is held only in the returned value (which the
/// caller seals immediately); nothing here writes plaintext to disk.
pub fn capture(
    staged: &[(String, PathBuf)],
    kind: PortableKind,
    keyring: &dyn OsCryptKeyring,
) -> Result<PortableArtifact> {
    let scheme = keyring
        .keys_for_decrypt()
        .first()
        .map(|(_, key)| key.scheme().to_string())
        .ok_or_else(|| anyhow::anyhow!("host keyring offered no key to record a source scheme"))?;

    let mut files = Vec::new();
    let mut dbs = Vec::new();
    for (rel, path) in staged {
        files.push(PortableFile {
            rel: rel.clone(),
            bytes: std::fs::read(path).with_context(|| format!("reading {}", path.display()))?,
        });
        let cells = capture_cells(path, kind, keyring)
            .with_context(|| format!("decrypting {rel} under the host OSCrypt key"))?;
        dbs.push(PortableDb {
            rel: rel.clone(),
            cells,
        });
    }
    Ok(PortableArtifact {
        kind,
        scheme,
        files,
        dbs,
    })
}

fn open_ro(path: &Path) -> Result<Connection> {
    Connection::open_with_flags(
        path,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY | rusqlite::OpenFlags::SQLITE_OPEN_URI,
    )
    .with_context(|| format!("opening {} read-only", path.display()))
}

fn capture_cells(
    path: &Path,
    kind: PortableKind,
    keyring: &dyn OsCryptKeyring,
) -> Result<Vec<PortableCell>> {
    let conn = open_ro(path)?;
    match kind {
        PortableKind::Cookies => capture_cookie_cells(&conn, keyring),
        PortableKind::Logins => {
            // `Login Data For Account` and any non-standard login DB may lack the column; a store
            // without `password_value` simply has nothing key-bound to make portable.
            if table_has_column(&conn, "logins", "password_value")? {
                capture_column_cells(&conn, keyring, "logins", "password_value")
            } else {
                Ok(Vec::new())
            }
        }
        PortableKind::Autofill => {
            let mut cells = Vec::new();
            for (table, column) in AUTOFILL_ENCRYPTED_COLUMNS {
                if table_has_column(&conn, table, column)? {
                    cells.extend(capture_column_cells(&conn, keyring, table, column)?);
                }
            }
            Ok(cells)
        }
    }
}

/// Cookies: only rows whose `encrypted_value` is non-empty are transcoded. A row already in the
/// plaintext-`value` state (empty `encrypted_value`) rides in the verbatim database untouched — its
/// value is not key-bound, so it is already cross-OS-loadable, and leaving it alone is why a jar of
/// plaintext cookies restores with no key at all.
fn capture_cookie_cells(
    conn: &Connection,
    keyring: &dyn OsCryptKeyring,
) -> Result<Vec<PortableCell>> {
    let mut stmt = conn.prepare(
        "SELECT rowid, host_key, encrypted_value FROM cookies WHERE length(encrypted_value) > 0",
    )?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, i64>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, Vec<u8>>(2)?,
        ))
    })?;
    let mut cells = Vec::new();
    for row in rows {
        let (rowid, host_key, encrypted_value) = row?;
        let plaintext = decrypt_cookie_value(keyring, &host_key, &encrypted_value)
            .with_context(|| format!("cookie rowid {rowid} (host `{host_key}`)"))?;
        cells.push(PortableCell {
            rowid,
            host_key: Some(host_key),
            table: "cookies".to_string(),
            column: "encrypted_value".to_string(),
            plaintext,
        });
    }
    Ok(cells)
}

fn capture_column_cells(
    conn: &Connection,
    keyring: &dyn OsCryptKeyring,
    table: &str,
    column: &str,
) -> Result<Vec<PortableCell>> {
    assert_safe_identifier(table)?;
    assert_safe_identifier(column)?;
    let sql = format!("SELECT rowid, {column} FROM {table} WHERE length({column}) > 0");
    let mut stmt = conn.prepare(&sql)?;
    let rows = stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Vec<u8>>(1)?)))?;
    let mut cells = Vec::new();
    for row in rows {
        let (rowid, ciphertext) = row?;
        let plaintext = decrypt_value(keyring, &ciphertext)
            .with_context(|| format!("{table}.{column} rowid {rowid}"))?;
        cells.push(PortableCell {
            rowid,
            host_key: None,
            table: table.to_string(),
            column: column.to_string(),
            plaintext,
        });
    }
    Ok(cells)
}

// --- Restore -------------------------------------------------------------------------------------

/// Re-seal `db`'s cells into the database already staged at `path`, under the target keyring. Cookies
/// fall back to the plaintext `value` column when the key is unreachable; passwords and autofill have
/// no safe fallback and return `skip_artifact = true` so the caller leaves the target's store intact.
pub fn restore_cells(
    path: &Path,
    kind: PortableKind,
    db: &PortableDb,
    keyring: &dyn OsCryptKeyring,
) -> Result<CellOutcome> {
    let encrypt_key = keyring.key_for_encrypt();

    // Nothing key-bound to rewrite (e.g. a jar of only plaintext-value cookies, or logins with empty
    // password_value): the verbatim database is already correct on any target, so no key is needed and
    // there is no skip.
    if db.cells.is_empty() {
        return Ok(CellOutcome {
            at_rest: AtRest::Encrypted,
            applied: 0,
            skip_artifact: false,
            reason: None,
        });
    }

    // Passwords/autofill with an unreachable target key: do not write. Writing the verbatim
    // source-key ciphertext into a different-OS target is exactly the silent-blank / undecryptable
    // hazard, and there is no plaintext column for these. The honest outcome is "not restored".
    if encrypt_key.is_err() && kind != PortableKind::Cookies {
        return Ok(CellOutcome {
            at_rest: AtRest::Unavailable,
            applied: 0,
            skip_artifact: true,
            reason: Some(format!(
                "the target OSCrypt key is unreachable and {} has no plaintext fallback; the store \
                 was left as-is rather than written with values that would blank or fail to decrypt",
                kind_label(kind)
            )),
        });
    }

    let mut conn = Connection::open(path)
        .with_context(|| format!("opening staged {} read-write", path.display()))?;
    // The design pins cookies at journal_mode=DELETE (rollback), matching what the engine expects for
    // these three files (they are rollback-journal, never WAL, on real disk).
    conn.pragma_update(None, "journal_mode", "DELETE")?;

    let tx = conn.transaction()?;
    let mut applied = 0u64;
    let at_rest = match &encrypt_key {
        Ok(key) => {
            for cell in &db.cells {
                let sealed = match kind {
                    PortableKind::Cookies => {
                        let host = cell.host_key.as_deref().ok_or_else(|| {
                            anyhow::anyhow!("cookie cell rowid {} has no host_key", cell.rowid)
                        })?;
                        encrypt_cookie_value(key, host, &cell.plaintext)?
                    }
                    _ => encrypt_value(key, &cell.plaintext)?,
                };
                update_encrypted_cell(&tx, &cell.table, &cell.column, cell.rowid, &sealed)?;
                applied += 1;
            }
            AtRest::Encrypted
        }
        Err(_) => {
            // Cookies-only branch (the guard above returned for the other kinds).
            for cell in &db.cells {
                update_cookie_plaintext(&tx, cell.rowid, &cell.plaintext)?;
                applied += 1;
            }
            AtRest::Plaintext
        }
    };
    tx.commit()?;
    Ok(CellOutcome {
        at_rest,
        applied,
        skip_artifact: false,
        reason: None,
    })
}

/// Read every re-sealed cell back through the DECRYPT path and compare it to the captured plaintext.
///
/// This is the only defence against the silent-blank autofill failure and against a mis-sealed cookie
/// that would delete its eTLD group on load. It runs against the staged file BEFORE the swap, so a
/// mismatch aborts the restore with the live profile untouched. Byte comparison is in memory; on
/// mismatch the error carries digests and lengths, never the plaintext.
pub fn verify_cells(
    path: &Path,
    kind: PortableKind,
    db: &PortableDb,
    keyring: &dyn OsCryptKeyring,
    at_rest: AtRest,
) -> Result<()> {
    let conn = Connection::open(path)
        .with_context(|| format!("re-opening staged {} to verify", path.display()))?;
    for cell in &db.cells {
        let recovered = match at_rest {
            AtRest::Plaintext => read_cell_bytes(&conn, "cookies", "value", cell.rowid)?,
            AtRest::Encrypted => {
                let stored = read_cell_bytes(&conn, &cell.table, &cell.column, cell.rowid)?;
                match kind {
                    PortableKind::Cookies => {
                        let host = cell.host_key.as_deref().unwrap_or_default();
                        decrypt_cookie_value(keyring, host, &stored)?
                    }
                    _ => decrypt_value(keyring, &stored)?,
                }
            }
            AtRest::Unavailable => return Ok(()),
        };
        if recovered != cell.plaintext {
            bail!(
                "PORTABLE_READBACK_MISMATCH: {}.{} rowid {} read back to a {}-byte value (blake3 \
                 {}) but the capture held {} bytes (blake3 {}) — refusing to swap in a store whose \
                 values did not survive re-encryption",
                cell.table,
                cell.column,
                cell.rowid,
                recovered.len(),
                short_digest(&recovered),
                cell.plaintext.len(),
                short_digest(&cell.plaintext),
            );
        }
    }
    Ok(())
}

fn update_encrypted_cell(
    conn: &Connection,
    table: &str,
    column: &str,
    rowid: i64,
    sealed: &[u8],
) -> Result<()> {
    assert_safe_identifier(table)?;
    assert_safe_identifier(column)?;
    // For cookies, moving the value into `encrypted_value` means the plaintext `value` must be
    // cleared, or a row with both populated is dropped by Chromium (kValuesExistInBothEncryptedAndPlaintext).
    let sql = if table == "cookies" {
        format!("UPDATE {table} SET {column} = ?1, value = '' WHERE rowid = ?2")
    } else {
        format!("UPDATE {table} SET {column} = ?1 WHERE rowid = ?2")
    };
    let changed = conn
        .execute(&sql, rusqlite::params![sealed, rowid])
        .with_context(|| format!("updating {table}.{column} rowid {rowid}"))?;
    if changed != 1 {
        bail!("expected to update exactly one {table} row at rowid {rowid}, changed {changed}");
    }
    Ok(())
}

/// The cookie plaintext-`value` fallback: empty `encrypted_value` (never NULL — the column is NOT
/// NULL), plaintext in `value`. Verified loadable in the fork (`OverridePlaintextValue`).
fn update_cookie_plaintext(conn: &Connection, rowid: i64, plaintext: &[u8]) -> Result<()> {
    let value = value_param(plaintext);
    let changed = conn
        .execute(
            "UPDATE cookies SET encrypted_value = x'', value = ?1 WHERE rowid = ?2",
            rusqlite::params![value, rowid],
        )
        .with_context(|| format!("writing plaintext cookie value at rowid {rowid}"))?;
    if changed != 1 {
        bail!("expected to update exactly one cookie row at rowid {rowid}, changed {changed}");
    }
    Ok(())
}

/// Read a cell's bytes regardless of its SQLite storage class. The encrypted columns are BLOBs, but
/// the plaintext-fallback `value` is TEXT, and `get::<Vec<u8>>` refuses a Text column — so read the
/// generic `Value` and coerce, which is what makes the cookie plaintext read-back work.
fn read_cell_bytes(conn: &Connection, table: &str, column: &str, rowid: i64) -> Result<Vec<u8>> {
    assert_safe_identifier(table)?;
    assert_safe_identifier(column)?;
    let sql = format!("SELECT {column} FROM {table} WHERE rowid = ?1");
    let value: rusqlite::types::Value = conn
        .query_row(&sql, [rowid], |r| r.get(0))
        .with_context(|| format!("reading back {table}.{column} rowid {rowid}"))?;
    Ok(match value {
        rusqlite::types::Value::Text(s) => s.into_bytes(),
        rusqlite::types::Value::Blob(b) => b,
        rusqlite::types::Value::Null => Vec::new(),
        other => bail!("{table}.{column} rowid {rowid} is {other:?}, expected text or blob"),
    })
}

/// Bind a cookie value to the TEXT `value` column. Cookie values are ASCII in practice; when the
/// bytes are valid UTF-8 we bind text (the storage class Chromium's `ColumnString` expects), else we
/// bind a blob, which `sqlite3_column_text` still returns verbatim.
fn value_param(plaintext: &[u8]) -> rusqlite::types::Value {
    match std::str::from_utf8(plaintext) {
        Ok(s) => rusqlite::types::Value::Text(s.to_string()),
        Err(_) => rusqlite::types::Value::Blob(plaintext.to_vec()),
    }
}

fn table_has_column(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    assert_safe_identifier(table)?;
    let exists: bool = conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [table],
        |r| r.get(0),
    )?;
    if !exists {
        return Ok(false);
    }
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut has = false;
    let names = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for name in names {
        if name? == column {
            has = true;
            break;
        }
    }
    Ok(has)
}

/// Every table/column that reaches a `format!`-built SQL string comes from the compile-time constant
/// lists in this file, never from a manifest or a user. This gate makes that an enforced invariant
/// rather than a convention, so a future caller cannot turn identifier interpolation into injection.
fn assert_safe_identifier(ident: &str) -> Result<()> {
    if ident.is_empty()
        || ident.len() > 64
        || !ident
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_')
    {
        bail!("unsafe SQL identifier `{ident}`");
    }
    Ok(())
}

fn kind_label(kind: PortableKind) -> &'static str {
    match kind {
        PortableKind::Cookies => "cookies",
        PortableKind::Logins => "passwords",
        PortableKind::Autofill => "autofill",
    }
}

fn short_digest(bytes: &[u8]) -> String {
    blake3::hash(bytes).to_hex()[..16].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::snapshot::oscrypt::{linux::LINUX_V10_KEY, InjectedKeyring, OsKey, TAG_V10};

    fn cbc() -> OsKey {
        OsKey::Aes128Cbc(LINUX_V10_KEY)
    }
    fn gcm() -> OsKey {
        OsKey::Aes256Gcm([0x33u8; 32])
    }

    /// Build a minimal cookie jar with ONE encrypted row sealed under `seal_key`, plus one plaintext
    /// row, at `path`. Returns the temp file path.
    fn cookie_jar(path: &Path, seal_key: &OsKey, host: &str, value: &[u8]) {
        let conn = Connection::open(path).unwrap();
        conn.execute_batch(
            "CREATE TABLE cookies(host_key TEXT NOT NULL, name TEXT NOT NULL, value TEXT NOT NULL,\
             encrypted_value BLOB NOT NULL);",
        )
        .unwrap();
        let sealed = encrypt_cookie_value(seal_key, host, value).unwrap();
        conn.execute(
            "INSERT INTO cookies VALUES(?1,'auth','',?2)",
            rusqlite::params![host, sealed],
        )
        .unwrap();
        // A plaintext-value row: empty encrypted_value, value populated. Must ride through untouched.
        conn.execute(
            "INSERT INTO cookies VALUES('plain.example','pt','carry-me',x'')",
            [],
        )
        .unwrap();
    }

    fn only_cell(a: &PortableArtifact) -> &PortableDb {
        assert_eq!(a.dbs.len(), 1);
        &a.dbs[0]
    }

    /// Capture under key A (CBC), restore under key B (GCM): the encrypted value survives, and the
    /// plaintext-value row is carried by the verbatim database untouched.
    #[test]
    fn cookie_portable_round_trip_cross_key() {
        let dir = std::env::temp_dir().join(format!("tc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("Cookies");
        cookie_jar(&src, &cbc(), "site.example", b"the-session");

        // Capture under A.
        let a = InjectedKeyring::single(cbc());
        let art = capture(
            &[("Default/Cookies".into(), src.clone())],
            PortableKind::Cookies,
            &a,
        )
        .unwrap();
        assert_eq!(art.scheme, "v10-aes128cbc");
        assert_eq!(
            only_cell(&art).cells.len(),
            1,
            "only the encrypted row is a cell"
        );

        // Restore under B: write the verbatim bytes, transcode, verify.
        let staged = dir.join("staged-Cookies");
        std::fs::write(&staged, &art.files[0].bytes).unwrap();
        let b = InjectedKeyring::single(gcm());
        let outcome = restore_cells(&staged, PortableKind::Cookies, only_cell(&art), &b).unwrap();
        assert_eq!(outcome.at_rest, AtRest::Encrypted);
        assert!(!outcome.skip_artifact);
        verify_cells(
            &staged,
            PortableKind::Cookies,
            only_cell(&art),
            &b,
            AtRest::Encrypted,
        )
        .unwrap();

        // Prove it end to end: the value decrypts under B, and the plaintext row is intact.
        let conn = Connection::open(&staged).unwrap();
        let ev: Vec<u8> = conn
            .query_row(
                "SELECT encrypted_value FROM cookies WHERE name='auth'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(
            decrypt_cookie_value(&b, "site.example", &ev).unwrap(),
            b"the-session"
        );
        let carried: String = conn
            .query_row("SELECT value FROM cookies WHERE name='pt'", [], |r| {
                r.get(0)
            })
            .unwrap();
        assert_eq!(carried, "carry-me");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// The unreachable-key fallback: cookies land in the plaintext `value` column, atRest=plaintext,
    /// and the value is loadable.
    #[test]
    fn cookie_unreachable_key_falls_back_to_plaintext() {
        let dir = std::env::temp_dir().join(format!("tc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("Cookies");
        cookie_jar(&src, &cbc(), "site.example", b"sess-xyz");
        let a = InjectedKeyring::single(cbc());
        let art = capture(
            &[("Default/Cookies".into(), src)],
            PortableKind::Cookies,
            &a,
        )
        .unwrap();

        let staged = dir.join("staged");
        std::fs::write(&staged, &art.files[0].bytes).unwrap();
        // A keyring that can decrypt but has NO encrypt key — the denied-Keychain shape.
        let unreachable = InjectedKeyring::decrypt_only(vec![(TAG_V10, cbc())]);
        let outcome = restore_cells(
            &staged,
            PortableKind::Cookies,
            only_cell(&art),
            &unreachable,
        )
        .unwrap();
        assert_eq!(outcome.at_rest, AtRest::Plaintext);
        assert!(!outcome.skip_artifact);
        verify_cells(
            &staged,
            PortableKind::Cookies,
            only_cell(&art),
            &unreachable,
            AtRest::Plaintext,
        )
        .unwrap();

        let conn = Connection::open(&staged).unwrap();
        let (value, enc_len): (String, i64) = conn
            .query_row(
                "SELECT value, length(encrypted_value) FROM cookies WHERE name='auth'",
                [],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        assert_eq!(value, "sess-xyz");
        assert_eq!(
            enc_len, 0,
            "encrypted_value must be empty for the plaintext fallback"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Passwords with an unreachable target key are NOT written — the store is skipped, not degraded.
    #[test]
    fn passwords_unreachable_key_skips_the_store() {
        let dir = std::env::temp_dir().join(format!("tc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("Login Data");
        let conn = Connection::open(&src).unwrap();
        conn.execute_batch(
            "CREATE TABLE logins(origin_url TEXT, password_value BLOB, signon_realm TEXT);",
        )
        .unwrap();
        let sealed = encrypt_value(&cbc(), b"hunter2").unwrap();
        conn.execute("INSERT INTO logins VALUES('https://x','', 'https://x')", [])
            .unwrap();
        conn.execute(
            "UPDATE logins SET password_value=?1",
            rusqlite::params![sealed],
        )
        .unwrap();
        drop(conn);

        let a = InjectedKeyring::single(cbc());
        let art = capture(
            &[("Default/Login Data".into(), src)],
            PortableKind::Logins,
            &a,
        )
        .unwrap();
        assert_eq!(only_cell(&art).cells.len(), 1);

        let staged = dir.join("staged");
        std::fs::write(&staged, &art.files[0].bytes).unwrap();
        let unreachable = InjectedKeyring::decrypt_only(vec![(TAG_V10, cbc())]);
        let outcome =
            restore_cells(&staged, PortableKind::Logins, only_cell(&art), &unreachable).unwrap();
        assert_eq!(outcome.at_rest, AtRest::Unavailable);
        assert!(
            outcome.skip_artifact,
            "passwords must be skipped, never blanked"
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    /// Passwords with a reachable target key round-trip cross-key and read back.
    #[test]
    fn passwords_round_trip_cross_key() {
        let dir = std::env::temp_dir().join(format!("tc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("Login Data");
        let conn = Connection::open(&src).unwrap();
        conn.execute_batch("CREATE TABLE logins(origin_url TEXT, password_value BLOB);")
            .unwrap();
        let sealed = encrypt_value(&cbc(), b"s3cr3t").unwrap();
        conn.execute(
            "INSERT INTO logins VALUES('https://x', ?1)",
            rusqlite::params![sealed],
        )
        .unwrap();
        drop(conn);

        let a = InjectedKeyring::single(cbc());
        let art = capture(
            &[("Default/Login Data".into(), src)],
            PortableKind::Logins,
            &a,
        )
        .unwrap();
        let staged = dir.join("staged");
        std::fs::write(&staged, &art.files[0].bytes).unwrap();
        let b = InjectedKeyring::single(gcm());
        let outcome = restore_cells(&staged, PortableKind::Logins, only_cell(&art), &b).unwrap();
        assert_eq!(outcome.at_rest, AtRest::Encrypted);
        verify_cells(
            &staged,
            PortableKind::Logins,
            only_cell(&art),
            &b,
            AtRest::Encrypted,
        )
        .unwrap();
        let conn = Connection::open(&staged).unwrap();
        let pv: Vec<u8> = conn
            .query_row("SELECT password_value FROM logins", [], |r| r.get(0))
            .unwrap();
        assert_eq!(decrypt_value(&b, &pv).unwrap(), b"s3cr3t");
        std::fs::remove_dir_all(&dir).ok();
    }

    /// A tampered re-encryption is caught by the read-back rather than reaching the profile. Simulated
    /// by verifying with the WRONG key, which is what a silent-blank would look like.
    #[test]
    fn readback_catches_a_wrong_key() {
        let dir = std::env::temp_dir().join(format!("tc-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let src = dir.join("Cookies");
        cookie_jar(&src, &cbc(), "site.example", b"v");
        let a = InjectedKeyring::single(cbc());
        let art = capture(
            &[("Default/Cookies".into(), src)],
            PortableKind::Cookies,
            &a,
        )
        .unwrap();
        let staged = dir.join("staged");
        std::fs::write(&staged, &art.files[0].bytes).unwrap();
        let b = InjectedKeyring::single(gcm());
        restore_cells(&staged, PortableKind::Cookies, only_cell(&art), &b).unwrap();
        // Verify with a DIFFERENT key than we sealed under: the oracle rejects, verify fails.
        let wrong = InjectedKeyring::single(OsKey::Aes256Gcm([0x99u8; 32]));
        assert!(verify_cells(
            &staged,
            PortableKind::Cookies,
            only_cell(&art),
            &wrong,
            AtRest::Encrypted
        )
        .is_err());
        std::fs::remove_dir_all(&dir).ok();
    }
}
