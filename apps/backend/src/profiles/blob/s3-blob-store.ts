import { Injectable } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';

import {
  BlobVersionConflictError,
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
 * The bytes stay CLIENT-encrypted end to end — this class never decrypts.
 *
 * Config (env): `S3_BUCKET` (required), `S3_REGION`, `S3_ENDPOINT` (MinIO/R2), `S3_ACCESS_KEY_ID`
 * + `S3_SECRET_ACCESS_KEY` (omit to use the SDK's default credential chain), `S3_KEY_PREFIX`,
 * `S3_FORCE_PATH_STYLE` (defaults to true when a custom endpoint is set — MinIO needs it).
 */
@Injectable()
export class S3BlobStore implements BlobStore {
  private readonly client: S3Client;
  private readonly bucket: string;
  /** Optional key namespace inside the bucket, e.g. `profiles/`. Always ''-or-`…/`-terminated. */
  private readonly keyPrefix: string;

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
    const rawPrefix = config.get<string>('S3_KEY_PREFIX') ?? '';
    this.keyPrefix = rawPrefix && !rawPrefix.endsWith('/') ? `${rawPrefix}/` : rawPrefix;

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
      ...(accessKeyId && secretAccessKey
        ? { credentials: { accessKeyId, secretAccessKey } }
        : {}),
    });
  }

  async put(key: string, bytes: Buffer, meta: BlobPutMeta): Promise<BlobPutResult> {
    let current = await this.currentVersion(key);
    if (meta.expectedVersion !== undefined && meta.expectedVersion !== current) {
      throw new BlobVersionConflictError(key, meta.expectedVersion, current);
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
            // Non-secret tagging for auditing/lifecycle rules; never the blob plaintext.
            Metadata: { 'team-id': meta.teamId, 'profile-id': meta.profileId },
          }),
        );
        return { version: nextVersion };
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
        current = await this.currentVersion(key);
      }
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
    const prefix = `${this.keyPrefix}${key}/`;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      const keys = (page.Contents ?? [])
        .map((obj) => obj.Key)
        .filter((k): k is string => typeof k === 'string');
      if (keys.length > 0) {
        // DeleteObjects removes up to 1000 keys per call; a page is already ≤1000, so one call per page.
        await this.client.send(
          new DeleteObjectsCommand({
            Bucket: this.bucket,
            Delete: { Objects: keys.map((k) => ({ Key: k })), Quiet: true },
          }),
        );
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
  }

  /** Object key for one immutable stored version, e.g. `<prefix><teamId>/<profileId>/3.enc`. */
  private objectKey(key: string, version: number): string {
    return `${this.keyPrefix}${key}/${version}.enc`;
  }

  /**
   * The highest stored version under `key` (0 when nothing exists yet), by listing the key's
   * prefix and parsing the `<version>.enc` object names. S3 ListObjectsV2 is strongly consistent,
   * so a completed put is always visible here.
   */
  private async currentVersion(key: string): Promise<number> {
    const prefix = `${this.keyPrefix}${key}/`;
    let max = 0;
    let continuationToken: string | undefined;
    do {
      const page = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          ContinuationToken: continuationToken,
        }),
      );
      for (const obj of page.Contents ?? []) {
        const match = obj.Key?.slice(prefix.length).match(/^(\d+)\.enc$/);
        if (match) {
          max = Math.max(max, Number(match[1]));
        }
      }
      continuationToken = page.IsTruncated ? page.NextContinuationToken : undefined;
    } while (continuationToken);
    return max;
  }
}
