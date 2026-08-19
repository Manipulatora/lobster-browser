import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

/** Marks a wrapped value. A legacy row is 32 raw bytes and cannot begin with this. */
const WRAP_VERSION = 0x01;

const IV_LEN = 12;
const TAG_LEN = 16;
const MASTER_KEY_LEN = 32;

/** Length of an unwrapped data key, and therefore of a row written before wrapping existed. */
const DATA_KEY_LEN = 32;

const logger = new Logger('VaultKeyWrapping');

/**
 * Envelope encryption for the per-account vault key.
 *
 * WHAT THIS DOES AND DOES NOT BUY. The server holds the key that opens a user's profile snapshots —
 * deliberately, so that signing in is all it takes to get your profiles back and a forgotten
 * password costs nothing. That decision stands. What it must not also mean is that a Postgres dump
 * is, by itself, every user's cookies and live sessions: the row and the key that opens it should
 * not travel together. Wrapping the column under a master key held in the process environment
 * separates them, so a leaked backup, replica or dump is inert without the deployment's secret.
 *
 * It is NOT end-to-end encryption and does not pretend to be. An attacker with both the database
 * and the running server's environment still recovers everything, and so does anyone holding a
 * valid token — the key is served to any client that can sign in. See the `VaultKey` model comment.
 *
 * A 32-byte master key, base64, in `VAULT_MASTER_KEY`. Generate one with:
 *   node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
 */
export class VaultKeyWrapper {
  private readonly masterKey: Buffer | null;

  constructor(config: ConfigService) {
    this.masterKey = resolveMasterKey(config);
  }

  /** Wrap a freshly generated data key for storage. A pass-through when no master key is set. */
  wrap(dataKey: Buffer): Buffer {
    if (!this.masterKey) return dataKey;

    const iv = randomBytes(IV_LEN);
    const cipher = createCipheriv('aes-256-gcm', this.masterKey, iv);
    const ciphertext = Buffer.concat([cipher.update(dataKey), cipher.final()]);
    return Buffer.concat([Buffer.from([WRAP_VERSION]), iv, cipher.getAuthTag(), ciphertext]);
  }

  /**
   * Recover a stored value.
   *
   * READS BOTH FORMATS, and has to: rows written before the master key was configured are 32 raw
   * bytes, and refusing them would lock every existing account out of its own profiles. A row is
   * wrapped or it is not, and its own first byte says which — no migration, no flag day.
   */
  unwrap(stored: Buffer): Buffer {
    if (stored.length === DATA_KEY_LEN) return stored;
    if (stored.length <= 1 + IV_LEN + TAG_LEN || stored[0] !== WRAP_VERSION) {
      throw new Error('vault key is neither a raw key nor a recognised wrapped envelope');
    }
    if (!this.masterKey) {
      throw new Error(
        'vault keys in this database are wrapped, but VAULT_MASTER_KEY is not set. Refusing to ' +
          'guess: without it every stored profile snapshot is unreadable.',
      );
    }

    const iv = stored.subarray(1, 1 + IV_LEN);
    const tag = stored.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
    const decipher = createDecipheriv('aes-256-gcm', this.masterKey, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([
      decipher.update(stored.subarray(1 + IV_LEN + TAG_LEN)),
      decipher.final(),
    ]);
  }
}

/**
 * Read and validate the master key.
 *
 * PRODUCTION REFUSES TO START WITHOUT ONE, the same way it refuses to start with the dev JWT secret
 * or an ephemeral blob store — an unset variable must not quietly downgrade the most sensitive
 * column in the database to plaintext. An operator who writes `ALLOW_PLAINTEXT_VAULT_KEYS=1` down
 * can still do it, which keeps the guard from being reached by forgetting rather than by choice.
 */
function resolveMasterKey(config: ConfigService): Buffer | null {
  const raw = config.get<string>('VAULT_MASTER_KEY') ?? '';
  if (raw) {
    const key = Buffer.from(raw, 'base64');
    if (key.length !== MASTER_KEY_LEN) {
      throw new Error(
        `VAULT_MASTER_KEY must be ${MASTER_KEY_LEN} bytes of base64, got ${key.length}.`,
      );
    }
    return key;
  }

  const env = config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development';
  if (env === 'production') {
    if (config.get<string>('ALLOW_PLAINTEXT_VAULT_KEYS') !== '1') {
      throw new Error(
        'VAULT_MASTER_KEY is required in production. Without it the key that opens every profile ' +
          'snapshot is stored in the clear beside the snapshots, so a database dump alone is a ' +
          "full breach. Generate one with `node -e \"console.log(require('node:crypto')" +
          ".randomBytes(32).toString('base64'))\"`, or set ALLOW_PLAINTEXT_VAULT_KEYS=1 to " +
          'acknowledge storing them unwrapped.',
      );
    }
    logger.warn(
      'VAULT KEYS ARE STORED IN THE CLEAR: ALLOW_PLAINTEXT_VAULT_KEYS=1 with no VAULT_MASTER_KEY. ' +
        'A copy of this database is a copy of every profile snapshot.',
    );
  }
  return null;
}
