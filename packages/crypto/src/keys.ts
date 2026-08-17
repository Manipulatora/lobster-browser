/**
 * SEC-2 key hierarchy helpers (docs/OPERATIONS.md).
 *
 * UMK (Argon2id) → wraps UKWK → unwraps TDK → HKDF → PCK → LBv1 blob encrypt.
 * Local Store Key (LSK) is handled on the desktop Rust side (OS keychain).
 */

import {
  createCipheriv,
  createDecipheriv,
  createHash,
  hkdfSync,
  randomBytes,
  timingSafeEqual,
} from 'node:crypto';

/** Symmetric key / nonce sizes (match LBv1 / AES-256-GCM). */
const KEY_LEN = 32;
const KEY_ID_LEN = 16;
const NONCE_LEN = 12;

/** Argon2id parameters (normative target from security.md). */
export const ARGON2ID_MEMORY_KIB = 64 * 1024; // 64 MiB
export const ARGON2ID_ITERATIONS = 3;
export const ARGON2ID_PARALLELISM = 1;
export const ARGON2ID_SALT_LEN = 16;
export const ARGON2ID_HASH_LEN = 32;

/**
 * Recovery-code shape: 128 bits, Crockford base32, in six groups of five.
 *
 * 128 bits because this key is the ONLY thing between a user who forgot their password and the
 * permanent loss of every synced session — it has to be strong enough that guessing is not a threat
 * model, so it is generated rather than chosen. Crockford base32 because a recovery code gets written
 * on paper and typed back: it has no `I`, `L`, `O` or `U`, so the classic transcription confusions
 * cannot produce a different valid code, and {@link normalizeRecoveryCode} folds the ones that do get
 * mistyped back to their intended digit.
 */
export const RECOVERY_CODE_BITS = 128;
export const RECOVERY_CODE_GROUPS = 6;
export const RECOVERY_CODE_GROUP_LEN = 5;

/** Crockford base32, excluding I, L, O, U by construction. */
const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';

/** HKDF info labels (stable; changing them rotates all derived keys). */
export const HKDF_INFO_PCK = 'lobster/pck/v1';
export const HKDF_INFO_KEY_ID = 'lobster/pck-key-id/v1';

/** Key-wrap envelope: magic | nonce(12) | ct+tag */
const KW_MAGIC = Buffer.from('LKw1', 'ascii');
const KW_HEADER_LEN = 4 + NONCE_LEN;

export class KeyHierarchyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'KeyHierarchyError';
  }
}

function asKey(bytes: Uint8Array | Buffer, label: string): Buffer {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length !== KEY_LEN) {
    throw new KeyHierarchyError(`${label} must be ${KEY_LEN} bytes (got ${buf.length})`);
  }
  return buf;
}

/** Random 32-byte key (UKWK / TDK / LSK / standalone PCK). */
export function generateSymmetricKey(): Buffer {
  return randomBytes(KEY_LEN);
}

/** Random 16-byte Argon2 salt. */
export function generatePasswordSalt(): Buffer {
  return randomBytes(ARGON2ID_SALT_LEN);
}

/** Optional Argon2id overrides — production callers must omit these. */
export interface DeriveUmkOptions {
  memoryKiB?: number;
  iterations?: number;
  parallelism?: number;
}

/**
 * Derive the User Master Key from a password via Argon2id.
 *
 * Uses a pure-JS Argon2id implementation so `@lobster/crypto` stays free of native addons.
 * Default parameters match security.md (m=64MiB, t=3, p=1) — intentionally slow.
 * Tests may pass reduced `memoryKiB` / `iterations` via {@link DeriveUmkOptions}.
 */
export async function deriveUserMasterKey(
  password: string,
  salt: Uint8Array | Buffer,
  options: DeriveUmkOptions = {},
): Promise<Buffer> {
  const saltBuf = Buffer.isBuffer(salt) ? salt : Buffer.from(salt);
  if (saltBuf.length !== ARGON2ID_SALT_LEN) {
    throw new KeyHierarchyError(`salt must be ${ARGON2ID_SALT_LEN} bytes`);
  }
  if (!password) {
    throw new KeyHierarchyError('password must be non-empty');
  }

  // Dynamic import keeps the sync surface of the package light for SEC-1-only callers.
  const { argon2id } = await import('@noble/hashes/argon2.js');
  const hash = argon2id(password, saltBuf, {
    m: options.memoryKiB ?? ARGON2ID_MEMORY_KIB,
    t: options.iterations ?? ARGON2ID_ITERATIONS,
    p: options.parallelism ?? ARGON2ID_PARALLELISM,
    dkLen: ARGON2ID_HASH_LEN,
  });
  return Buffer.from(hash);
}

/**
 * AES-256-GCM key wrap: encrypts a 32-byte key under a wrapping key.
 * Format: `LKw1` | nonce(12) | ciphertext+tag.
 */
export function wrapKey(
  plaintextKey: Uint8Array | Buffer,
  wrappingKey: Uint8Array | Buffer,
): Buffer {
  const pt = asKey(plaintextKey, 'plaintextKey');
  const wk = asKey(wrappingKey, 'wrappingKey');
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv('aes-256-gcm', wk, nonce);
  const body = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([KW_MAGIC, nonce, body, tag]);
}

/** Unwrap a key produced by {@link wrapKey}. Fails closed on wrong wrapping key / tamper. */
export function unwrapKey(wrapped: Uint8Array | Buffer, wrappingKey: Uint8Array | Buffer): Buffer {
  const buf = Buffer.isBuffer(wrapped) ? wrapped : Buffer.from(wrapped);
  const wk = asKey(wrappingKey, 'wrappingKey');
  if (buf.length < KW_HEADER_LEN + KEY_LEN + 16) {
    throw new KeyHierarchyError('wrapped key too short');
  }
  if (!timingSafeEqual(buf.subarray(0, 4), KW_MAGIC)) {
    throw new KeyHierarchyError('wrapped key magic is not LKw1');
  }
  const nonce = buf.subarray(4, 4 + NONCE_LEN);
  const sealed = buf.subarray(4 + NONCE_LEN);
  const ciphertext = sealed.subarray(0, sealed.length - 16);
  const tag = sealed.subarray(sealed.length - 16);
  try {
    const decipher = createDecipheriv('aes-256-gcm', wk, nonce);
    decipher.setAuthTag(tag);
    const pt = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return asKey(pt, 'unwrappedKey');
  } catch {
    throw new KeyHierarchyError('key unwrap failed (wrong wrapping key or tampered wrap)');
  }
}

/**
 * Derive a stable Profile Content Key from the Team Data Key + profile id (HKDF-SHA256).
 * Prefer this over random PCKs when the team shares one TDK (no per-profile wrap row needed).
 */
export function deriveProfileContentKey(
  teamDataKey: Uint8Array | Buffer,
  profileId: string,
): Buffer {
  const tdk = asKey(teamDataKey, 'teamDataKey');
  if (!profileId) {
    throw new KeyHierarchyError('profileId must be non-empty');
  }
  const okm = hkdfSync(
    'sha256',
    tdk,
    Buffer.alloc(0),
    Buffer.from(`${HKDF_INFO_PCK}:${profileId}`, 'utf8'),
    KEY_LEN,
  );
  return Buffer.from(okm);
}

/** Derive a stable 16-byte key_id for LBv1 headers from TDK + profileId. */
export function deriveKeyId(teamDataKey: Uint8Array | Buffer, profileId: string): Buffer {
  const tdk = asKey(teamDataKey, 'teamDataKey');
  const okm = hkdfSync(
    'sha256',
    tdk,
    Buffer.alloc(0),
    Buffer.from(`${HKDF_INFO_KEY_ID}:${profileId}`, 'utf8'),
    KEY_ID_LEN,
  );
  return Buffer.from(okm);
}

/**
 * Full signup-shaped bootstrap for a single-user / single-team install:
 * password → UMK → wrap UKWK; UKWK wraps TDK; PCK = HKDF(TDK, profileId).
 */
export interface TeamKeyMaterial {
  passwordSalt: Buffer;
  /** Wrapped UKWK under UMK — persist this; never persist UMK. */
  wrappedUserKeyWrappingKey: Buffer;
  /** Wrapped TDK under UKWK — one copy per membership. */
  wrappedTeamDataKey: Buffer;
  /** Clear UKWK — session only; caller must zeroize when done. */
  userKeyWrappingKey: Buffer;
  /** Clear TDK — session only. */
  teamDataKey: Buffer;
}

export async function bootstrapTeamKeys(
  password: string,
  options: DeriveUmkOptions = {},
): Promise<TeamKeyMaterial> {
  const passwordSalt = generatePasswordSalt();
  const umk = await deriveUserMasterKey(password, passwordSalt, options);
  const userKeyWrappingKey = generateSymmetricKey();
  const teamDataKey = generateSymmetricKey();
  const wrappedUserKeyWrappingKey = wrapKey(userKeyWrappingKey, umk);
  const wrappedTeamDataKey = wrapKey(teamDataKey, userKeyWrappingKey);
  umk.fill(0);
  return {
    passwordSalt,
    wrappedUserKeyWrappingKey,
    wrappedTeamDataKey,
    userKeyWrappingKey,
    teamDataKey,
  };
}

/** Unlock persisted wraps with the user password; returns session UKWK + TDK. */
export async function unlockTeamKeys(
  password: string,
  passwordSalt: Uint8Array | Buffer,
  wrappedUserKeyWrappingKey: Uint8Array | Buffer,
  wrappedTeamDataKey: Uint8Array | Buffer,
  options: DeriveUmkOptions = {},
): Promise<{ userKeyWrappingKey: Buffer; teamDataKey: Buffer }> {
  const umk = await deriveUserMasterKey(password, passwordSalt, options);
  try {
    const userKeyWrappingKey = unwrapKey(wrappedUserKeyWrappingKey, umk);
    const teamDataKey = unwrapKey(wrappedTeamDataKey, userKeyWrappingKey);
    return { userKeyWrappingKey, teamDataKey };
  } finally {
    umk.fill(0);
  }
}

/**
 * Re-wrap a TDK to a new member's UKWK (join team). Member-removal forward secrecy is:
 * generate a fresh TDK, re-wrap to remaining members, and encrypt future blobs under it.
 */
export function wrapTeamDataKeyForMember(
  teamDataKey: Uint8Array | Buffer,
  memberUserKeyWrappingKey: Uint8Array | Buffer,
): Buffer {
  return wrapKey(teamDataKey, memberUserKeyWrappingKey);
}

/** Fingerprint a key for logs/UI without leaking material (SHA-256 truncated). */
/**
 * A fresh recovery code, e.g. `A1B2C-3D4E5-...`.
 *
 * The 128 bits are read from a CSPRNG and encoded five bits at a time, so every character carries
 * exactly one symbol's worth of entropy and there is no modulo bias to reason about. 26 symbols hold
 * 130 bits, so the last symbol's low two bits are zero-padded — stated because a reader checking the
 * arithmetic will otherwise wonder where the missing bits went.
 */
export function generateRecoveryCode(): string {
  const bytes = randomBytes(RECOVERY_CODE_BITS / 8);
  const symbols = RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LEN;
  let bits = 0;
  let acc = 0;
  let out = '';
  for (let i = 0; out.length < symbols; ) {
    if (bits < 5) {
      acc = (acc << 8) | (i < bytes.length ? bytes[i]! : 0);
      bits += 8;
      i += 1;
    }
    bits -= 5;
    out += CROCKFORD[(acc >> bits) & 0x1f];
  }
  const groups: string[] = [];
  for (let i = 0; i < symbols; i += RECOVERY_CODE_GROUP_LEN) {
    groups.push(out.slice(i, i + RECOVERY_CODE_GROUP_LEN));
  }
  return groups.join('-');
}

/**
 * Fold a typed recovery code back to its canonical symbols.
 *
 * Accepts the separators and case a human will actually produce, and applies Crockford's substitutions
 * (`I`/`L` → `1`, `O` → `0`) so a transcription slip is corrected rather than rejected. `U` is NOT
 * substituted — it is excluded from the alphabet specifically so it cannot be confused with `V`, and
 * silently mapping it would accept a code that was never issued.
 */
export function normalizeRecoveryCode(code: string): string {
  const folded = code
    .toUpperCase()
    .replace(/[\s-]+/g, '')
    .replace(/[IL]/g, '1')
    .replace(/O/g, '0');
  const expected = RECOVERY_CODE_GROUPS * RECOVERY_CODE_GROUP_LEN;
  if (folded.length !== expected) {
    throw new KeyHierarchyError(
      `recovery code must be ${expected} symbols (got ${folded.length} after normalising)`,
    );
  }
  for (const ch of folded) {
    if (!CROCKFORD.includes(ch)) {
      throw new KeyHierarchyError(`recovery code contains '${ch}', which is not in the alphabet`);
    }
  }
  return folded;
}

/**
 * Derive a wrapping key from a recovery code, using the same Argon2id cost as a password.
 *
 * Deliberately as slow as the password path even though the code has far more entropy: the cost is
 * paid once, during a recovery someone is already anxious about, and matching the parameters means
 * there is only one KDF configuration in the system to get right or to migrate.
 *
 * The salt is SEPARATE from the password salt. Sharing one would mean the two wraps of the same key
 * were derived from related material, and rotating a password would silently invalidate the recovery
 * code.
 */
export async function deriveRecoveryKey(
  code: string,
  salt: Uint8Array | Buffer,
  options: DeriveUmkOptions = {},
): Promise<Buffer> {
  return deriveUserMasterKey(normalizeRecoveryCode(code), salt, options);
}

export function keyFingerprint(key: Uint8Array | Buffer): string {
  const buf = Buffer.isBuffer(key) ? key : Buffer.from(key);
  return createHash('sha256').update(buf).digest('hex').slice(0, 16);
}
