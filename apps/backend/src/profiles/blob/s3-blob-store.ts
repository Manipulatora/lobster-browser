import { Injectable } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';

import type { BlobHead, BlobPutMeta, BlobPutResult, BlobRecord, BlobStore } from './blob-store';

/**
 * Production `BlobStore` backed by S3 (or an S3-compatible object store). The module selects this
 * implementation only when `S3_BUCKET` is set; without it the in-memory store is used, mirroring
 * the auth repo-factory (Prisma when DATABASE_URL is set, in-memory otherwise).
 *
 * STUB — the constructor reads and validates the `S3_*` config so misconfiguration fails fast at
 * boot, but the read/write methods are not yet implemented.
 *
 * Day 2: wire the AWS SDK. `put` -> PutObject at `<keyPrefix>/<key>/<version>.enc` with a version
 * derived from object metadata / a version marker; `getLatest`/`head` -> GetObject/HeadObject.
 * The bytes stay CLIENT-encrypted end to end — this class never decrypts.
 */
@Injectable()
export class S3BlobStore implements BlobStore {
  private readonly bucket: string;
  private readonly region: string;
  /** Optional custom endpoint for S3-compatible stores (MinIO, R2, …). */
  private readonly endpoint: string | undefined;

  constructor(config: ConfigService) {
    const bucket = config.get<string>('S3_BUCKET');
    if (!bucket) {
      // Should be unreachable: the module only instantiates S3BlobStore when S3_BUCKET is set.
      throw new Error('S3BlobStore requires S3_BUCKET to be configured');
    }
    this.bucket = bucket;
    this.region = config.get<string>('S3_REGION') ?? 'us-east-1';
    this.endpoint = config.get<string>('S3_ENDPOINT');
  }

  async put(_key: string, _bytes: Buffer, _meta: BlobPutMeta): Promise<BlobPutResult> {
    // Day 2: PutObject to `${this.bucket}` (region ${this.region}, endpoint ${this.endpoint}).
    // When `_meta.expectedVersion` is set it MUST be enforced atomically — e.g. a conditional
    // PutObject (If-Match on the version marker's ETag) — throwing BlobVersionConflictError on a
    // 412 so racing pushes at the same base can't clobber each other.
    throw new Error('S3BlobStore.put not configured — TODO(Day 2): implement S3 PutObject');
  }

  async getLatest(_key: string): Promise<BlobRecord | null> {
    // Day 2: GetObject the latest version marker from `${this.bucket}`.
    throw new Error('S3BlobStore.getLatest not configured — TODO(Day 2): implement S3 GetObject');
  }

  async head(_key: string): Promise<BlobHead | null> {
    // Day 2: HeadObject the latest version marker from `${this.bucket}`.
    throw new Error('S3BlobStore.head not configured — TODO(Day 2): implement S3 HeadObject');
  }
}
