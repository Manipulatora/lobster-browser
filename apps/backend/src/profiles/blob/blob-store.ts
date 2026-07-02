/**
 * Storage boundary for CLIENT-encrypted profile blobs.
 *
 * The server is a dumb, zero-knowledge broker: it stores opaque bytes (the desktop agent encrypts
 * with AES before upload and decrypts after download) plus a monotonically-increasing version per
 * logical `key`. It NEVER decrypts. `key` identifies a blob stream (one per profile), not a single
 * version — the store owns version assignment, so callers push new bytes and read back the version.
 *
 * Implementations:
 *   - InMemoryBlobStore — a Map; the active provider until an object store is provisioned.
 *   - S3BlobStore       — production persistence via S3 (stub until Day 2 wiring lands).
 */

/** Non-secret metadata recorded alongside a blob (for future S3 tagging / auditing). */
export interface BlobPutMeta {
  teamId: string;
  profileId: string;
}

/** Result of a {@link BlobStore.put}: the version just assigned to the stored bytes. */
export interface BlobPutResult {
  version: number;
}

/** The latest bytes for a key plus its version and last-write timestamp. */
export interface BlobRecord {
  bytes: Buffer;
  version: number;
  /** ISO-8601 timestamp of the last write. */
  updatedAt: string;
}

/** Lightweight version probe (no bytes) — used for optimistic-concurrency conflict checks. */
export interface BlobHead {
  version: number;
}

/**
 * Opaque encrypted-blob store. Every method is keyed by a logical `key` (e.g. `<teamId>/<profileId>`).
 * The store never interprets the bytes.
 */
export interface BlobStore {
  /** Store `bytes` under `key`, bumping its version by one; returns the new version. */
  put(key: string, bytes: Buffer, meta: BlobPutMeta): Promise<BlobPutResult>;
  /** The latest record for `key`, or null when nothing has ever been stored under it. */
  getLatest(key: string): Promise<BlobRecord | null>;
  /** The current version for `key` without transferring bytes, or null when it does not exist. */
  head(key: string): Promise<BlobHead | null>;
}

/**
 * Nest DI token for the active `BlobStore`. Using a token (not a class) lets the module bind the
 * interface to different implementations (in-memory vs S3) without callers caring.
 */
export const BLOB_STORE = Symbol('BlobStore');
