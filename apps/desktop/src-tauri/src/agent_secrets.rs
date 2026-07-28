//! Encrypted provider credentials and per-profile agent-memory keys.

use anyhow::{bail, Result};
use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use rusqlite::{params, Connection, OptionalExtension};

use crate::blob_crypto::BlobCipher;
use crate::secrets::SecretCipher;

const PROVIDERS: &[&str] = &["anthropic", "openai", "google", "xai", "openrouter"];

pub fn init(conn: &Connection) -> Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_secrets (
            scope TEXT NOT NULL,
            name TEXT NOT NULL,
            encrypted_value TEXT NOT NULL,
            updated_at TEXT NOT NULL,
            PRIMARY KEY (scope, name)
        );",
    )?;
    Ok(())
}

pub fn validate_provider(provider: &str) -> Result<()> {
    if !PROVIDERS.contains(&provider) {
        bail!("unsupported LLM provider");
    }
    Ok(())
}

pub fn has_provider_key(conn: &Connection, provider: &str) -> Result<bool> {
    validate_provider(provider)?;
    Ok(conn.query_row(
        "SELECT EXISTS(SELECT 1 FROM agent_secrets WHERE scope='provider' AND name=?1)",
        [provider],
        |row| row.get(0),
    )?)
}

pub fn set_provider_key(
    conn: &Connection,
    cipher: &SecretCipher,
    provider: &str,
    api_key: Option<&str>,
) -> Result<bool> {
    validate_provider(provider)?;
    match api_key.map(str::trim).filter(|value| !value.is_empty()) {
        Some(value) => {
            if value.len() > 20_000 {
                bail!("API key is too long");
            }
            put(conn, "provider", provider, &cipher.encrypt_str(value)?)?;
            Ok(true)
        }
        None => {
            conn.execute(
                "DELETE FROM agent_secrets WHERE scope='provider' AND name=?1",
                [provider],
            )?;
            Ok(false)
        }
    }
}

pub fn provider_key(
    conn: &Connection,
    cipher: &SecretCipher,
    provider: &str,
) -> Result<Option<String>> {
    validate_provider(provider)?;
    let stored: Option<String> = conn
        .query_row(
            "SELECT encrypted_value FROM agent_secrets WHERE scope='provider' AND name=?1",
            [provider],
            |row| row.get(0),
        )
        .optional()?;
    stored
        .map(|value| cipher.decrypt_strict(&value))
        .transpose()
}

pub fn memory_key(conn: &Connection, cipher: &SecretCipher, profile_id: &str) -> Result<String> {
    let stored: Option<String> = conn
        .query_row(
            "SELECT encrypted_value FROM agent_secrets WHERE scope='memory' AND name=?1",
            [profile_id],
            |row| row.get(0),
        )
        .optional()?;
    if let Some(stored) = stored {
        let encoded = cipher.decrypt_strict(&stored)?;
        let bytes = BASE64.decode(&encoded)?;
        if bytes.len() != 32 {
            bail!("stored agent memory key has an invalid length");
        }
        return Ok(encoded);
    }
    let encoded = BASE64.encode(BlobCipher::generate_key());
    put(conn, "memory", profile_id, &cipher.encrypt_str(&encoded)?)?;
    Ok(encoded)
}

fn put(conn: &Connection, scope: &str, name: &str, encrypted_value: &str) -> Result<()> {
    conn.execute(
        "INSERT INTO agent_secrets(scope,name,encrypted_value,updated_at)
         VALUES(?1,?2,?3,?4)
         ON CONFLICT(scope,name) DO UPDATE SET encrypted_value=excluded.encrypted_value, updated_at=excluded.updated_at",
        params![scope, name, encrypted_value, chrono::Utc::now().to_rfc3339()],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_and_memory_secrets_are_encrypted_and_stable() {
        let conn = Connection::open_in_memory().unwrap();
        init(&conn).unwrap();
        let cipher = SecretCipher::new(&[4u8; 32]);
        assert!(!has_provider_key(&conn, "anthropic").unwrap());
        set_provider_key(&conn, &cipher, "anthropic", Some("sk-test-secret")).unwrap();
        assert_eq!(
            provider_key(&conn, &cipher, "anthropic")
                .unwrap()
                .as_deref(),
            Some("sk-test-secret")
        );
        let stored: String = conn
            .query_row(
                "SELECT encrypted_value FROM agent_secrets WHERE scope='provider'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(SecretCipher::is_encrypted(&stored));
        assert!(!stored.contains("sk-test-secret"));
        let first = memory_key(&conn, &cipher, "prf_1").unwrap();
        assert_eq!(first, memory_key(&conn, &cipher, "prf_1").unwrap());
        assert_eq!(BASE64.decode(first).unwrap().len(), 32);
    }
}
