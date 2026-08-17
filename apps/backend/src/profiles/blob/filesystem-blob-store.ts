import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants as fsConstants } from 'node:fs';
import { link, mkdir, mkdtemp, open, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
  BlobVersionConflictError,
  type BlobHead,
  type BlobPutMeta,
  type BlobPutResult,
  type BlobRecord,
  type BlobStore,
} from './blob-store';

/**
 * Durable `BlobStore` on the server's own filesystem.
 *
 * WHY THIS IS ENOUGH. The blobs are encrypted by the desktop client before they are ever uploaded, so
 * the server stores opaque bytes and could not read them if it wanted to. That removes the usual
 * reason to reach for object storage — an encrypted blob needs durability and atomicity, not S3's
 * feature surface — and a directory on a machine that is already backed up provides both. It also
 * removes an external dependency and a set of credentials from the deployment.
 *
 * ## Versions are files, and the FILESYSTEM performs the compare-and-set
 *
 * Each version is its own file, `v0000000001.blob`. A conditional put targets exactly
 * `expectedVersion + 1` and creates it with `link()`, which fails with `EEXIST` if that version
 * already exists. That single syscall IS the compare-and-set: it is atomic on any POSIX filesystem,
 * it holds across processes and replicas rather than only within one event loop, and there is no lock
 * to leak if a process dies holding it.
 *
 * `link()` rather than an exclusive `open()` because it also gives durability. The bytes are written
 * to a temp file and fsync'd FIRST, and only then linked into place, so a crash mid-write cannot
 * leave a torn file at a version number that readers already consider live. An `O_EXCL` create would
 * publish the version before the bytes were in it.
 *
 * ## Every version is kept
 *
 * Unlike the in-memory store, which keeps only the latest, this keeps the whole history — it is what
 * makes point-in-time recovery possible ("my session broke, give me yesterday's cookies"), and it is
 * what the version-as-filename scheme gives for free. Pruning is a policy decision that belongs above
 * this layer; there is deliberately no silent retention limit here.
 */
@Injectable()
export class FilesystemBlobStore implements BlobStore {
  private readonly root: string;

  /** `v` + 10 digits: sorts lexicographically in version order, and 10 digits will not run out. */
  private static readonly VERSION_DIGITS = 10;
  private static readonly FILE_RE = /^v(\d{10})\.blob$/;

  /**
   * A key segment may only be a plain identifier.
   *
   * Keys are `<teamId>/<profileId>` and both are UUIDs, so this is never restrictive in practice —
   * but a key reaches this class from a request, and a segment containing `..` or a separator would
   * turn a blob write into an arbitrary filesystem write. Validating is cheaper than being sure every
   * caller sanitised.
   */
  private static readonly SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

  constructor(config: ConfigService) {
    this.root = config.get<string>('BLOB_STORE_PATH') ?? '/var/lib/lobster/blobs';
  }

  async put(key: string, bytes: Buffer, meta: BlobPutMeta): Promise<BlobPutResult> {
    const dir = this.dirFor(key);
    await mkdir(dir, { recursive: true, mode: 0o700 });

    if (meta.expectedVersion !== undefined) {
      const current = (await this.latestVersion(dir)) ?? 0;
      if (meta.expectedVersion !== current) {
        throw new BlobVersionConflictError(key, meta.expectedVersion, current);
      }
      // The link below is the real check. The read above only produces a good error message for the
      // common, uncontended case — between it and the link, another writer may still take this
      // version, and that is exactly what EEXIST catches.
      const target = meta.expectedVersion + 1;
      try {
        await this.writeVersion(dir, target, bytes);
      } catch (err) {
        if (isEexist(err)) {
          throw new BlobVersionConflictError(
            key,
            meta.expectedVersion,
            (await this.latestVersion(dir)) ?? 0,
          );
        }
        throw err;
      }
      return { version: target };
    }

    // Unconditional put: take the next free version, retrying when a concurrent writer takes it
    // first. Bounded, because an unbounded retry against a busy key is a spin.
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const target = ((await this.latestVersion(dir)) ?? 0) + 1;
      try {
        await this.writeVersion(dir, target, bytes);
        return { version: target };
      } catch (err) {
        if (!isEexist(err)) throw err;
      }
    }
    throw new Error(`could not allocate a blob version for ${key} after 8 attempts`);
  }

  async getLatest(key: string): Promise<BlobRecord | null> {
    const dir = this.dirFor(key);
    const version = await this.latestVersion(dir);
    if (version === null) return null;
    const path = join(dir, this.fileName(version));
    const [bytes, stats] = await Promise.all([readFile(path), stat(path)]);
    return { bytes, version, updatedAt: stats.mtime.toISOString() };
  }

  async head(key: string): Promise<BlobHead | null> {
    const version = await this.latestVersion(this.dirFor(key));
    return version === null ? null : { version };
  }

  async deleteAll(key: string): Promise<void> {
    // `force` makes this idempotent, which the interface requires: deleting a key that was never
    // written is a no-op, not an error.
    await rm(this.dirFor(key), { recursive: true, force: true });
  }

  /** Absolute directory for a key, with every segment validated. */
  private dirFor(key: string): string {
    const segments = key.split('/').filter((s) => s.length > 0);
    if (segments.length === 0) {
      throw new Error('blob key must have at least one segment');
    }
    for (const segment of segments) {
      if (!FilesystemBlobStore.SEGMENT_RE.test(segment)) {
        throw new Error(`unsafe blob key segment: ${JSON.stringify(segment)}`);
      }
    }
    return join(this.root, ...segments);
  }

  private fileName(version: number): string {
    return `v${String(version).padStart(FilesystemBlobStore.VERSION_DIGITS, '0')}.blob`;
  }

  /** Highest stored version, or null when the key has never been written. */
  private async latestVersion(dir: string): Promise<number | null> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw err;
    }
    let highest: number | null = null;
    for (const entry of entries) {
      const match = FilesystemBlobStore.FILE_RE.exec(entry);
      if (!match) continue;
      const version = Number(match[1]);
      if (highest === null || version > highest) highest = version;
    }
    return highest;
  }

  /**
   * Write one version durably, publishing it atomically.
   *
   * Order matters: bytes to a temp file, fsync so they are really on the device, then `link()` to
   * publish. Only the link is visible to a reader, and it cannot appear before the data it points at.
   * The directory is fsync'd too, or the new entry can be lost by a crash even though the file's own
   * contents were durable.
   *
   * Throws `EEXIST` when `version` is already taken. Callers treat that as the CAS losing.
   */
  private async writeVersion(dir: string, version: number, bytes: Buffer): Promise<void> {
    const scratch = await mkdtemp(join(tmpdir(), 'lobster-blob-'));
    const temp = join(scratch, 'payload');
    try {
      const handle = await open(temp, 'w', 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }

      await link(temp, join(dir, this.fileName(version)));

      const dirHandle = await open(dir, fsConstants.O_RDONLY);
      try {
        await dirHandle.sync();
      } finally {
        await dirHandle.close();
      }
    } finally {
      // The temp file is unlinked whether or not the publish succeeded; on success the link keeps the
      // inode alive, so this frees the name and nothing else.
      await unlink(temp).catch(() => {});
      await rm(scratch, { recursive: true, force: true }).catch(() => {});
    }
  }
}

function isEexist(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'EEXIST';
}
