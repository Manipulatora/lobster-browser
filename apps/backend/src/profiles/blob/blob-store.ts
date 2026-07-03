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
  /**
   * Optimistic-concurrency precondition. When set, the store atomically requires the currently
   * stored version to equal this value before writing (checked and applied without an intervening
   * await, so two racing puts at the same base can never both win); a mismatch throws
   * {@link BlobVersionConflictError}. `0` means "expected to not exist yet". Omit to write
   * unconditionally.
   */
  expectedVersion?: number;
}

/**
 * Thrown by {@link BlobStore.put} when its `expectedVersion` precondition does not match the
 * currently-stored version — a lost-update / optimistic-concurrency conflict. Kept framework-free
 * so the store stays decoupled from HTTP concerns; callers map it to a 409.
 */
export class BlobVersionConflictError extends Error {
  constructor(
    readonly key: string,
    readonly expectedVersion: number,
    readonly actualVersion: number,
  ) {
    super(`blob version conflict for ${key}: expected ${expectedVersion}, found ${actualVersion}`);
    this.name = 'BlobVersionConflictError';
  }
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
  /**
   * Store `bytes` under `key`, bumping its version by one; returns the new version. When
   * `meta.expectedVersion` is set, the version check + write happen atomically inside the store,
   * throwing {@link BlobVersionConflictError} when the precondition fails (compare-and-set).
   */
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
