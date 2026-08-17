/**
 * @lobster/crypto — client-side profile-blob encryption (SEC-1).
 *
 * Normative wire format from `docs/OPERATIONS.md` §1.3:
 *
 * ```
 * magic="LBv1" (4B) | key_id (16B) | alg (1B: 0x01=A256GCM) | nonce (12B) | ciphertext (…) | tag (16B)
 * ```
 *
 * The desktop agent encrypts before any cloud push; the server stores opaque bytes and never
 * sees plaintext cookies/storage/seeds. Callers supply a raw 32-byte Profile Content Key (PCK);
 * see `./keys.js` for SEC-2 hierarchy helpers (UMK/UKWK/TDK → PCK).
 */

export {
  ARGON2ID_HASH_LEN,
  ARGON2ID_ITERATIONS,
  ARGON2ID_MEMORY_KIB,
  ARGON2ID_PARALLELISM,
  ARGON2ID_SALT_LEN,
  bootstrapTeamKeys,
  deriveKeyId,
  deriveProfileContentKey,
  deriveRecoveryKey,
  deriveUserMasterKey,
  generatePasswordSalt,
  generateRecoveryCode,
  generateSymmetricKey,
  HKDF_INFO_KEY_ID,
  HKDF_INFO_PCK,
  KeyHierarchyError,
  keyFingerprint,
  normalizeRecoveryCode,
  RECOVERY_CODE_BITS,
  RECOVERY_CODE_GROUP_LEN,
  RECOVERY_CODE_GROUPS,
  unlockTeamKeys,
  unwrapKey,
  wrapKey,
  wrapTeamDataKeyForMember,
  type DeriveUmkOptions,
  type TeamKeyMaterial,
} from './keys.js';

import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';

/** Envelope magic — ASCII `LBv1`. */
export const LB_V1_MAGIC = Buffer.from('LBv1', 'ascii');
/** AES-256-GCM algorithm id in the envelope header. */
export const LB_V1_ALG_A256GCM = 0x01;
/** Fixed header length before ciphertext+tag. */
export const LB_V1_HEADER_LEN = 4 + 16 + 1 + 12; // magic | key_id | alg | nonce
/** AES-GCM auth tag length. */
export const LB_V1_TAG_LEN = 16;
/** AES-256 key length. */
export const LB_V1_KEY_LEN = 32;
/** key_id length (identifies which PCK/TDK version decrypts the blob). */
export const LB_V1_KEY_ID_LEN = 16;
/** AES-GCM nonce length. */
export const LB_V1_NONCE_LEN = 12;

export class BlobCryptoError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BlobCryptoError';
  }
}

/** Options for {@link encryptBlob}. */
export interface EncryptBlobOptions {
  /** 32-byte Profile Content Key (PCK). */
  key: Uint8Array | Buffer;
  /**
   * 16-byte key identifier stored in the clear header so rotated keys can still decrypt old
   * versions. Defaults to 16 zero bytes when omitted (single-key installs).
   */
  keyId?: Uint8Array | Buffer;
  /** Optional 12-byte nonce; a fresh CSPRNG nonce is used when omitted. */
  nonce?: Uint8Array | Buffer;
}

/** Result of a successful decrypt. */
export interface DecryptBlobResult {
  plaintext: Buffer;
  keyId: Buffer;
  alg: number;
}

function asBuffer(bytes: Uint8Array | Buffer, label: string, expectedLen: number): Buffer {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length !== expectedLen) {
    throw new BlobCryptoError(`${label} must be ${expectedLen} bytes (got ${buf.length})`);
  }
  return buf;
}

/** True when `bytes` starts with the LBv1 magic. */
export function isLBv1Envelope(bytes: Uint8Array | Buffer): boolean {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (buf.length < LB_V1_MAGIC.length) return false;
  return timingSafeEqual(buf.subarray(0, LB_V1_MAGIC.length), LB_V1_MAGIC);
}

/**
 * Encrypt `plaintext` into an LBv1 envelope. Ciphertext never contains the cleartext bytes;
 * a fresh random nonce is used per call unless `nonce` is supplied (tests only).
 */
export function encryptBlob(plaintext: Uint8Array | Buffer, options: EncryptBlobOptions): Buffer {
  const key = asBuffer(options.key, 'key', LB_V1_KEY_LEN);
  const keyId = options.keyId
    ? asBuffer(options.keyId, 'keyId', LB_V1_KEY_ID_LEN)
    : Buffer.alloc(LB_V1_KEY_ID_LEN, 0);
  const nonce = options.nonce
    ? asBuffer(options.nonce, 'nonce', LB_V1_NONCE_LEN)
    : randomBytes(LB_V1_NONCE_LEN);

  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  const body = Buffer.isBuffer(plaintext) ? plaintext : Buffer.from(plaintext);
  const ciphertext = Buffer.concat([cipher.update(body), cipher.final()]);
  const tag = cipher.getAuthTag();

  const envelope = Buffer.allocUnsafe(LB_V1_HEADER_LEN + ciphertext.length + LB_V1_TAG_LEN);
  let offset = 0;
  LB_V1_MAGIC.copy(envelope, offset);
  offset += LB_V1_MAGIC.length;
  keyId.copy(envelope, offset);
  offset += LB_V1_KEY_ID_LEN;
  envelope[offset++] = LB_V1_ALG_A256GCM;
  nonce.copy(envelope, offset);
  offset += LB_V1_NONCE_LEN;
  ciphertext.copy(envelope, offset);
  offset += ciphertext.length;
  tag.copy(envelope, offset);
  return envelope;
}

/**
 * Decrypt an LBv1 envelope. Throws {@link BlobCryptoError} on bad magic, unsupported alg,
 * truncated input, wrong key, or tampered ciphertext/tag.
 */
export function decryptBlob(
  envelope: Uint8Array | Buffer,
  key: Uint8Array | Buffer,
): DecryptBlobResult {
  const buf = Buffer.isBuffer(envelope) ? envelope : Buffer.from(envelope);
  const keyBuf = asBuffer(key, 'key', LB_V1_KEY_LEN);

  if (buf.length < LB_V1_HEADER_LEN + LB_V1_TAG_LEN) {
    throw new BlobCryptoError('envelope too short for LBv1 header + tag');
  }
  if (!isLBv1Envelope(buf)) {
    throw new BlobCryptoError('envelope magic is not LBv1');
  }

  let offset = LB_V1_MAGIC.length;
  const keyId = Buffer.from(buf.subarray(offset, offset + LB_V1_KEY_ID_LEN));
  offset += LB_V1_KEY_ID_LEN;
  const alg = buf[offset++]!;
  if (alg !== LB_V1_ALG_A256GCM) {
    throw new BlobCryptoError(`unsupported LBv1 alg id 0x${alg.toString(16)}`);
  }
  const nonce = Buffer.from(buf.subarray(offset, offset + LB_V1_NONCE_LEN));
  offset += LB_V1_NONCE_LEN;
  const ciphertext = buf.subarray(offset, buf.length - LB_V1_TAG_LEN);
  const tag = buf.subarray(buf.length - LB_V1_TAG_LEN);

  try {
    const decipher = createDecipheriv('aes-256-gcm', keyBuf, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
    return { plaintext, keyId, alg };
  } catch {
    throw new BlobCryptoError('AES-GCM authentication failed (wrong key or tampered envelope)');
  }
}

/** Convenience: encrypt a UTF-8 / JSON string payload. */
export function encryptBlobUtf8(plaintext: string, options: EncryptBlobOptions): Buffer {
  return encryptBlob(Buffer.from(plaintext, 'utf8'), options);
}

/** Convenience: decrypt and return UTF-8 text. */
export function decryptBlobUtf8(envelope: Uint8Array | Buffer, key: Uint8Array | Buffer): string {
  return decryptBlob(envelope, key).plaintext.toString('utf8');
}

/**
 * Canonical JSON profile-blob payload the desktop agent encrypts before cloud sync.
 * Extra fields are allowed so the format can grow without breaking decryptors.
 */
export interface ProfileBlobPayload {
  /** Payload schema version (not the LBv1 wire magic). */
  v: 1;
  profileId: string;
  /** ISO-8601 export timestamp. */
  exportedAt: string;
  /** Fingerprint seed — identity material; must never appear in cleartext on the wire. */
  fingerprintSeed?: string;
  /** Cookie jar (Netscape/JSON import shape or CDP cookie list). */
  cookies?: unknown;
  /** localStorage / sessionStorage / IndexedDB snapshot (opaque to the server). */
  storage?: unknown;
  /** Optional base64 user-data-dir snapshot chunk. */
  userDataSnapshotB64?: string;
}

/** Encrypt a {@link ProfileBlobPayload} as UTF-8 JSON inside an LBv1 envelope. */
export function encryptProfileBlob(
  payload: ProfileBlobPayload,
  options: EncryptBlobOptions,
): Buffer {
  return encryptBlobUtf8(JSON.stringify(payload), options);
}

/** Decrypt an LBv1 envelope and parse it as a {@link ProfileBlobPayload}. */
export function decryptProfileBlob(
  envelope: Uint8Array | Buffer,
  key: Uint8Array | Buffer,
): ProfileBlobPayload {
  const text = decryptBlobUtf8(envelope, key);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BlobCryptoError('decrypted blob is not valid JSON');
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    (parsed as ProfileBlobPayload).v !== 1 ||
    typeof (parsed as ProfileBlobPayload).profileId !== 'string' ||
    typeof (parsed as ProfileBlobPayload).exportedAt !== 'string'
  ) {
    throw new BlobCryptoError('decrypted blob is not a ProfileBlobPayload v1');
  }
  return parsed as ProfileBlobPayload;
}

/** Generate a fresh random 32-byte Profile Content Key. */
export function generateProfileContentKey(): Buffer {
  return randomBytes(LB_V1_KEY_LEN);
}

/** Generate a fresh random 16-byte key id. */
export function generateKeyId(): Buffer {
  return randomBytes(LB_V1_KEY_ID_LEN);
}
