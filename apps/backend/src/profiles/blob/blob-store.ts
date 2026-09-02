/**
 * Storage boundary for CLIENT-encrypted profile blobs.
 *
 * The server is a dumb, zero-knowledge broker: it stores opaque bytes (the desktop agent encrypts
 * with AES before upload and decrypts after download) plus a monotonically-increasing version per
 * logical `key`. It NEVER decrypts. `key` identifies a blob stream (one per profile), not a single
 * version — the store owns version assignment, so callers push new bytes and read back the version.
 *
 * Implementations:
 *   - InMemoryBlobStore    — a Map; the default provider for dev/tests (no object store needed).
 *   - FilesystemBlobStore  — durable versions on the server's own disk (selected by BLOB_STORE_PATH).
 *   - S3BlobStore          — persistence via S3/MinIO (selected when S3_BUCKET is set).
 */

/** Non-secret metadata recorded alongside a blob (for future S3 tagging / auditing). */
export interface BlobPutMeta {
  /**
   * Team the blob belongs to — and the unit of storage accounting. Every key of one team shares
   * the `<teamId>/` prefix (the service's key layout), which is how a store finds a team's blobs
   * without keeping an index.
   */
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
  /**
   * Storage quota for `teamId`, in bytes. When set, the put is refused with
   * {@link BlobQuotaExceededError} — BEFORE anything is written — if the team's LIVE bytes after
   * this write would exceed it. Live bytes are the latest version of every key the team has; the
   * older versions a store retains are its own recovery buffer, bounded by `BLOB_RETAIN_VERSIONS`,
   * and never count. A user can act on live data (delete a profile, shrink a snapshot); nobody can
   * act on server-side history, so charging it would make the refusal un-actionable. Omit to write
   * without a quota.
   */
  teamQuotaBytes?: number;
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

/**
 * Thrown by {@link BlobStore.put} when `meta.teamQuotaBytes` would be exceeded. `usedBytes` is
 * what the team stores live right now (this key's current version included); `requestedBytes` is
 * the write that was refused. Framework-free like the conflict error; the service turns it into a
 * response whose message says what to do.
 */
export class BlobQuotaExceededError extends Error {
  constructor(
    readonly teamId: string,
    readonly usedBytes: number,
    readonly quotaBytes: number,
    readonly requestedBytes: number,
  ) {
    super(
      `blob quota exceeded for team ${teamId}: ${usedBytes} bytes stored, ` +
        `${requestedBytes} requested, ${quotaBytes} allowed`,
    );
    this.name = 'BlobQuotaExceededError';
  }
}

/**
 * How many versions of one key a durable store keeps after each write, unless
 * `BLOB_RETAIN_VERSIONS` says otherwise. Five is enough for "my session broke, give me
 * yesterday's cookies" against a client that pushes after every stop, and bounds disk: before this
 * every version was kept forever and nothing above the store ever pruned.
 */
export const DEFAULT_BLOB_RETAIN_VERSIONS = 5;

/**
 * Parse `BLOB_RETAIN_VERSIONS`. Unset, empty or not a number means the default. Never below one:
 * the newest version is what the write just published and what every reader is about to ask for,
 * so no configuration may make it a pruning candidate.
 */
export function resolveBlobRetainVersions(raw: string | undefined): number {
  if (raw === undefined || raw === '') return DEFAULT_BLOB_RETAIN_VERSIONS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return DEFAULT_BLOB_RETAIN_VERSIONS;
  return Math.max(1, Math.floor(parsed));
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
   * throwing {@link BlobVersionConflictError} when the precondition fails (compare-and-set). When
   * `meta.teamQuotaBytes` is set, the write is refused with {@link BlobQuotaExceededError} before
   * anything is stored if the team's live bytes would exceed it. Durable stores prune the key's
   * versions beyond the newest `BLOB_RETAIN_VERSIONS` after the write is published.
   */
  put(key: string, bytes: Buffer, meta: BlobPutMeta): Promise<BlobPutResult>;
  /** The latest record for `key`, or null when nothing has ever been stored under it. */
  getLatest(key: string): Promise<BlobRecord | null>;
  /** The current version for `key` without transferring bytes, or null when it does not exist. */
  head(key: string): Promise<BlobHead | null>;
  /**
   * Delete ALL stored versions for `key`. Called when the owning profile is deleted so its encrypted
   * blobs are not orphaned in the object store. Idempotent — deleting a key with nothing stored under
   * it is a no-op.
   */
  deleteAll(key: string): Promise<void>;
}

/**
 * Nest DI token for the active `BlobStore`. Using a token (not a class) lets the module bind the
 * interface to different implementations (in-memory vs S3) without callers caring.
 */
export const BLOB_STORE = Symbol('BlobStore');
