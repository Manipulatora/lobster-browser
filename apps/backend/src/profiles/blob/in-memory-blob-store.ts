import { Injectable } from '@nestjs/common';

import {
  BlobVersionConflictError,
  type BlobHead,
  type BlobPutMeta,
  type BlobPutResult,
  type BlobRecord,
  type BlobStore,
} from './blob-store';

/** A single versioned entry in the in-memory store. */
interface StoredBlob {
  bytes: Buffer;
  version: number;
  updatedAt: string;
}

/**
 * In-memory `BlobStore` backed by a Map — the active provider until an object store (S3) is
 * provisioned. State lives for the lifetime of the process only; it is intentionally NOT durable.
 * Only the latest version per key is retained (older versions are overwritten), which is all the
 * push/pull + conflict-detection flow needs.
 */
@Injectable()
export class InMemoryBlobStore implements BlobStore {
  private readonly byKey = new Map<string, StoredBlob>();

  async put(key: string, bytes: Buffer, meta: BlobPutMeta): Promise<BlobPutResult> {
    const currentVersion = this.byKey.get(key)?.version ?? 0;
    // Compare-and-set: the read of the current version and the write below run with no await
    // between them, so this whole block is atomic on the single-threaded event loop. Two racing
    // pushes at the same `expectedVersion` can therefore never both pass the check.
    if (meta.expectedVersion !== undefined && meta.expectedVersion !== currentVersion) {
      throw new BlobVersionConflictError(key, meta.expectedVersion, currentVersion);
    }
    const nextVersion = currentVersion + 1;
    // Copy the buffer so a later mutation of the caller's array can't rewrite stored bytes.
    this.byKey.set(key, {
      bytes: Buffer.from(bytes),
      version: nextVersion,
      updatedAt: new Date().toISOString(),
    });
    return { version: nextVersion };
  }

  async getLatest(key: string): Promise<BlobRecord | null> {
    const stored = this.byKey.get(key);
    if (!stored) {
      return null;
    }
    return {
      bytes: Buffer.from(stored.bytes),
      version: stored.version,
      updatedAt: stored.updatedAt,
    };
  }

  async head(key: string): Promise<BlobHead | null> {
    const stored = this.byKey.get(key);
    return stored ? { version: stored.version } : null;
  }
}
