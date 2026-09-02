import { Injectable, Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';

import {
  BlobQuotaExceededError,
  BlobVersionConflictError,
  resolveBlobRetainVersions,
  type BlobHead,
  type BlobPutMeta,
  type BlobPutResult,
  type BlobRecord,
  type BlobStore,
} from './blob-store';

/**
 * How many times an UNCONDITIONAL put (no `expectedVersion`) re-reads the current version and
 * retries after losing a conditional-create race before giving up. Conditional puts never retry —
 * losing the race IS the conflict the caller asked us to detect.
 */
const MAX_PUT_ATTEMPTS = 5;

/** DeleteObjects accepts at most this many keys per call. */
const DELETE_BATCH = 1000;

/**
 * Normalise an `S3_KEY_PREFIX` into '' or a `…/`-terminated namespace, and build the object key for
 * one stored version. Both are EXPORTED so `ProfilesService` derives the `blobRef` URIs it hands
 * out from the same rules this store actually writes under — a second copy of the layout is how a
 * ref starts pointing at a key that does not exist.
 */
export function normalizeKeyPrefix(raw: string | undefined): string {
  const prefix = raw ?? '';
  return prefix && !prefix.endsWith('/') ? `${prefix}/` : prefix;
}

/** Object key for one immutable stored version, e.g. `<prefix><teamId>/<profileId>/3.enc`. */
export function blobObjectKey(keyPrefix: string, key: string, version: number): string {
  return `${keyPrefix}${key}/${version}.enc`;
}

/**
 * True when an S3 error is a conditional-write rejection: HTTP 412 `PreconditionFailed` (the
 * object already exists so `If-None-Match: *` failed) or HTTP 409 `ConditionalRequestConflict`
 * (S3 detected a concurrent conditional write on the same key). Both mean "another writer got
 * this version first".
 */
function isConditionalWriteRejection(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) {
    return false;
  }
  const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
  return (
    e.name === 'PreconditionFailed' ||
    e.name === 'ConditionalRequestConflict' ||
    e.$metadata?.httpStatusCode === 412 ||
    e.$metadata?.httpStatusCode === 409
  );
}

/**
 * Production `BlobStore` backed by S3 or any S3-compatible object store (MinIO, R2, …) via the
 * AWS SDK v3. The module selects this implementation only when `S3_BUCKET` is set; without it the
 * in-memory store is used, mirroring the auth repo-factory (Prisma when DATABASE_URL is set).
 *
 * Layout: each version of a blob stream is its own IMMUTABLE object at
 * `<keyPrefix><key>/<version>.enc` (matching the `blobRef` URIs ProfilesService hands out).
 * The current version of a key is the highest `<version>.enc` under its prefix — there is no
 * separate mutable "latest" pointer that could drift from the objects themselves.
 *
 * Atomicity: `put` creates the next version object with `If-None-Match: *`, so S3 itself
 * guarantees exactly one writer can create a given version — two racing pushes at the same base
 * can never both win. A conditional put (`expectedVersion` set) maps the lost race to
 * {@link BlobVersionConflictError} (the caller's 409); an unconditional put re-reads and retries.
 *
 * Retention: after a version is created, the key's versions beyond the newest `BLOB_RETAIN_VERSIONS`
 * are deleted (best-effort — a failed delete is reclaimable bytes, never a failed push). Keeping
 * the window small also keeps the version listing every read performs to a single page, where an
 * unpruned key of thousands of versions cost several paginated LIST calls per pull.
 *
 * Quota: `meta.teamQuotaBytes` is checked before the PUT against the team's live bytes — the
 * latest object of every key under `<keyPrefix><teamId>/`, from one listing with sizes.
 *
 * The bytes stay CLIENT-encrypted end to end — this class never decrypts.
 *
 * Config (env): `S3_BUCKET` (required), `S3_REGION`, `S3_ENDPOINT` (MinIO/R2), `S3_ACCESS_KEY_ID`
 * + `S3_SECRET_ACCESS_KEY` (omit to use the SDK's default credential chain), `S3_KEY_PREFIX`,
 * `S3_FORCE_PATH_STYLE` (defaults to true when a custom endpoint is set — MinIO needs it),
 * `BLOB_RETAIN_VERSIONS`.
 */
@Injectable()
export class S3BlobStore implements BlobStore {
  private readonly logger = new Logger(S3BlobStore.name);
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Optional key namespace inside the bucket, e.g. `profiles/`. Always ''-or-`…/`-terminated. */
  private readonly keyPrefix: string;
  private readonly retainVersions: number;

  /**
   * `client` is injectable for tests (a fake `send` exercises the conflict/versioning logic with
   * no network); when omitted, a real S3Client is built from the `S3_*` env config.
   */
  constructor(config: ConfigService, client?: S3Client) {
    const bucket = config.get<string>('S3_BUCKET');
    if (!bucket) {
      // Should be unreachable: the module only instantiates S3BlobStore when S3_BUCKET is set.
      throw new Error('S3BlobStore requires S3_BUCKET to be configured');
    }
    this.bucket = bucket;
    this.keyPrefix = normalizeKeyPrefix(config.get<string>('S3_KEY_PREFIX'));
    this.retainVersions = resolveBlobRetainVersions(config.get<string>('BLOB_RETAIN_VERSIONS'));

    if (client) {
      this.client = client;
      return;
    }
    const endpoint = config.get<string>('S3_ENDPOINT');
    const accessKeyId = config.get<string>('S3_ACCESS_KEY_ID');
    const secretAccessKey = config.get<string>('S3_SECRET_ACCESS_KEY');
    this.client = new S3Client({
      region: config.get<string>('S3_REGION') ?? 'us-east-1',
      ...(endpoint ? { endpoint } : {}),
      // MinIO (and most S3-compatibles) serve buckets at /<bucket>, not <bucket>.<host>.
      forcePathStyle: config.get<string>('S3_FORCE_PATH_STYLE')
        ? config.get<string>('S3_FORCE_PATH_STYLE') !== 'false'
        : Boolean(endpoint),
      ...(accessKeyId && secretAccessKey ? { credentials: { accessKeyId, secretAccessKey } } : {}),
    });
  }

  async put(key: string, bytes: Buffer, meta: BlobPutMeta): Promise<BlobPutResult> {
    let versions = await this.listVersions(key);
    let current = versions[versions.length - 1] ?? 0;
    if (meta.expectedVersion !== undefined && meta.expectedVersion !== current) {
      throw new BlobVersionConflictError(key, meta.expectedVersion, current);
    }
    // After the version precondition (a stale push must read as a conflict, not as a full store)
    // and before the PUT, so a refused write leaves the bucket exactly as it was.
    if (meta.teamQuotaBytes !== undefined) {
      await this.assertWithinQuota(key, meta.teamId, bytes.length, meta.teamQuotaBytes);
    }
    for (let attempt = 1; attempt <= MAX_PUT_ATTEMPTS; attempt += 1) {
      const nextVersion = current + 1;
      try {
        await this.client.send(
          new PutObjectCommand({
            Bucket: this.bucket,
            Key: this.objectKey(key, nextVersion),
            Body: bytes,
            ContentType: 'application/octet-stream',
            // The atomic compare-and-set: S3 rejects this put (412) unless it CREATES the
            // object, so exactly one writer can ever own a given version number.
            IfNoneMatch: '*',
            // Encrypt at rest with the bucket-managed key. The bytes are ALREADY client-encrypted,
            // so this is defence in depth (and what a bucket policy denying unencrypted PUTs
            // requires) — never the primary protection.
            ServerSideEncryption: 'AES256',
            // No object Metadata: the key already carries <teamId>/<profileId>, and duplicating the
            // topology in metadata only widened what a bucket-listing attacker learns for free.
          }),
        );
      } catch (err) {
        if (!isConditionalWriteRejection(err)) {
          throw err;
        }
        // Another writer created `nextVersion` first. For a conditional put that is exactly the
        // lost-update conflict the caller wants surfaced; unconditionally we re-read and retry.
        if (meta.expectedVersion !== undefined) {
          throw new BlobVersionConflictError(
            key,
            meta.expectedVersion,
            await this.currentVersion(key),
          );
        }
        versions = await this.listVersions(key);
        current = versions[versions.length - 1] ?? 0;
        continue;
      }
      await this.prune(key, [...versions, nextVersion]);
      return { version: nextVersion };
    }
    throw new Error(
      `S3BlobStore.put: gave up on ${key} after ${MAX_PUT_ATTEMPTS} contended attempts`,
    );
  }

  async getLatest(key: string): Promise<BlobRecord | null> {
    const version = await this.currentVersion(key);
    if (version === 0) {
      return null;
    }
    const res = await this.client.send(
      new GetObjectCommand({ Bucket: this.bucket, Key: this.objectKey(key, version) }),
    );
    if (!res.Body) {
      throw new Error(`S3BlobStore.getLatest: empty body for ${this.objectKey(key, version)}`);
    }
    return {
      bytes: Buffer.from(await res.Body.transformToByteArray()),
      version,
      updatedAt: (res.LastModified ?? new Date()).toISOString(),
    };
  }

  async head(key: string): Promise<BlobHead | null> {
    const version = await this.currentVersion(key);
    return version > 0 ? { version } : null;
  }

  async deleteAll(key: string): Promise<void> {
    const keys: string[] = [];
    for await (const obj of this.listPrefix(`${this.keyPrefix}${key}/`)) {
      if (typeof obj.Key === 'string') keys.push(obj.Key);
    }
    await this.deleteObjects(keys);
  }

  private objectKey(key: string, version: number): string {
    return blobObjectKey(this.keyPrefix, key, version);
  }

  /**
   * Delete this key's versions beyond the newest `retainVersions`. `versions` is ascending and
   * already includes the one just created, so the latest is always inside the window. A failed
   * delete is logged, never thrown: the push it follows has already succeeded, and the objects are
   * reclaimable on the next write.
   */
  private async prune(key: string, versions: readonly number[]): Promise<void> {
    const stale = versions.slice(0, Math.max(0, versions.length - this.retainVersions));
    if (stale.length === 0) return;
    try {
      await this.deleteObjects(stale.map((version) => this.objectKey(key, version)));
    } catch (err) {
      this.logger.warn(
        `could not prune old versions of ${key}: ${err instanceof Error ? err.message : String(err)}. ` +
          'The objects are reclaimable on the next write.',
      );
    }
  }

  /** Refuse the write if the team's live bytes after it would exceed `quotaBytes`. */
  private async assertWithinQuota(
    key: string,
    teamId: string,
    incomingBytes: number,
    quotaBytes: number,
  ): Promise<void> {
    const latestByKey = new Map<string, { version: number; size: number }>();
    for await (const obj of this.listPrefix(`${this.keyPrefix}${teamId}/`)) {
      if (typeof obj.Key !== 'string') continue;
      // `<keyPrefix><logical key>/<version>.enc`: the logical key is everything up to the last `/`.
      const rest = obj.Key.slice(this.keyPrefix.length);
      const slash = rest.lastIndexOf('/');
      const match = slash >= 0 ? /^(\d+)\.enc$/.exec(rest.slice(slash + 1)) : null;
      if (!match) continue;
      const logicalKey = rest.slice(0, slash);
      const version = Number(match[1]);
      const known = latestByKey.get(logicalKey);
      if (!known || version > known.version) {
        latestByKey.set(logicalKey, { version, size: obj.Size ?? 0 });
      }
    }
    let used = 0;
    for (const { size } of latestByKey.values()) used += size;
    // This key's current version is being replaced, so only what the OTHER keys hold stays.
    const retained = used - (latestByKey.get(key)?.size ?? 0);
    if (retained + incomingBytes > quotaBytes) {
      throw new BlobQuotaExceededError(teamId, used, quotaBytes, incomingBytes);
    }
  }

  /** Every object under `prefix`, walking continuation tokens. */
  private async *listPrefix(prefix: string): AsyncGenerator<_Object> {
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of page.Contents ?? []) yield obj;
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /** DeleteObjects in batches of its 1000-key maximum; a no-op for an empty list. */
  private async deleteObjects(keys: readonly string[]): Promise<void> {
    for (let start = 0; start < keys.length; start += DELETE_BATCH) {
      await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: {
            Objects: keys.slice(start, start + DELETE_BATCH).map((Key) => ({ Key })),
            Quiet: true,
          },
        }),
      );
    }
  }

  /**
   * Every stored version under `key`, ascending, by listing the key's prefix and parsing the
   * `<version>.enc` object names. S3 ListObjectsV2 is strongly consistent, so a completed put is
   * always visible here.
   */
  private async listVersions(key: string): Promise<number[]> {
    const prefix = `${this.keyPrefix}${key}/`;
    const versions: number[] = [];
    for await (const obj of this.listPrefix(prefix)) {
      const match = obj.Key?.slice(prefix.length).match(/^(\d+)\.enc$/);
      if (match) versions.push(Number(match[1]));
    }
    return versions.sort((a, b) => a - b);
  }

  /** The highest stored version under `key` (0 when nothing exists yet). */
  private async currentVersion(key: string): Promise<number> {
    const versions = await this.listVersions(key);
    return versions[versions.length - 1] ?? 0;
  }
}
