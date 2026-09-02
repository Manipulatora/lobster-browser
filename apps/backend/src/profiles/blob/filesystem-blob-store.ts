import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { constants as fsConstants, type Dirent } from 'node:fs';
import { link, mkdir, mkdtemp, open, readdir, readFile, rm, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

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
 * ## Only the newest versions are kept
 *
 * Each version being its own file makes history free — and growth unbounded. This store used to keep
 * every version and call pruning "a policy decision that belongs above this layer"; no layer above
 * ever made it, and the desktop pushes a snapshot after every stop and every dirty reconcile tick, so
 * 20 profiles × 10 stops a day × 10 MiB was 2 GB a day per active user with nothing ever reclaimed.
 * After every successful write the store now deletes this key's versions beyond the newest
 * `BLOB_RETAIN_VERSIONS` (default 5): enough history for "my session broke, give me yesterday's
 * cookies", and bounded disk. The latest version is never a candidate — it is what the write just
 * published, and the window is at least one.
 *
 * Pruning runs AFTER the write is published and is best-effort: a failure to delete an old file
 * leaves reclaimable bytes for the next write to clear, which is strictly better than failing a push
 * whose bytes are already durable.
 *
 * ## Quota
 *
 * `meta.teamQuotaBytes` is checked before anything is written, against the team's LIVE bytes — the
 * latest version of every key under `<root>/<teamId>/`, minus the version this write replaces. See
 * {@link BlobPutMeta.teamQuotaBytes} for why retained history does not count. The measurement is one
 * directory listing per profile plus one `stat`, not a walk of every version, so it stays cheap as
 * history accumulates.
 */
@Injectable()
export class FilesystemBlobStore implements BlobStore {
  private readonly logger = new Logger(FilesystemBlobStore.name);
  private readonly root: string;
  private readonly retainVersions: number;

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
    this.retainVersions = resolveBlobRetainVersions(config.get<string>('BLOB_RETAIN_VERSIONS'));
  }

  async put(key: string, bytes: Buffer, meta: BlobPutMeta): Promise<BlobPutResult> {
    const dir = this.dirFor(key);

    if (meta.expectedVersion !== undefined) {
      const current = (await this.latestVersion(dir)) ?? 0;
      if (meta.expectedVersion !== current) {
        throw new BlobVersionConflictError(key, meta.expectedVersion, current);
      }
    }
    // The quota is measured after the version precondition and before any byte lands: a stale push
    // must read as a conflict (the caller's cue to pull) rather than as a full disk, and a refused
    // push must leave the store exactly as it found it — which is why the key's directory is only
    // created once both checks have passed (the listings above tolerate its absence).
    if (meta.teamQuotaBytes !== undefined) {
      await this.assertWithinQuota(dir, meta.teamId, bytes.length, meta.teamQuotaBytes);
    }

    await mkdir(dir, { recursive: true, mode: 0o700 });
    const version = await this.publish(dir, key, bytes, meta.expectedVersion);
    await this.prune(dir, key);
    return { version };
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

  /**
   * Allocate the next version and write it durably. A conditional put targets exactly
   * `expectedVersion + 1`; an unconditional put takes the next free version, retrying when a
   * concurrent writer takes it first. Bounded, because an unbounded retry against a busy key is a
   * spin.
   */
  private async publish(
    dir: string,
    key: string,
    bytes: Buffer,
    expectedVersion: number | undefined,
  ): Promise<number> {
    if (expectedVersion !== undefined) {
      // The link inside writeVersion is the real check. The read in `put` only produces a good error
      // message for the common, uncontended case — between it and the link, another writer may still
      // take this version, and that is exactly what EEXIST catches.
      const target = expectedVersion + 1;
      try {
        await this.writeVersion(dir, target, bytes);
      } catch (err) {
        if (isEexist(err)) {
          throw new BlobVersionConflictError(
            key,
            expectedVersion,
            (await this.latestVersion(dir)) ?? 0,
          );
        }
        throw err;
      }
      return target;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const target = ((await this.latestVersion(dir)) ?? 0) + 1;
      try {
        await this.writeVersion(dir, target, bytes);
        return target;
      } catch (err) {
        if (!isEexist(err)) throw err;
      }
    }
    throw new Error(`could not allocate a blob version for ${key} after 8 attempts`);
  }

  /**
   * Delete this key's versions beyond the newest `retainVersions`. Runs after the new version is
   * published, so the file just written is always inside the window; a concurrent writer's newer
   * version only moves the window forward, never onto a version anyone still reads as the latest.
   */
  private async prune(dir: string, key: string): Promise<void> {
    try {
      const versions = await this.listVersions(dir);
      const stale = versions.slice(0, Math.max(0, versions.length - this.retainVersions));
      for (const version of stale) {
        // ENOENT is a concurrent pruner having got there first — the outcome is the same.
        await unlink(join(dir, this.fileName(version))).catch((err: NodeJS.ErrnoException) => {
          if (err.code !== 'ENOENT') throw err;
        });
      }
    } catch (err) {
      this.logger.warn(
        `could not prune old versions of ${key}: ${err instanceof Error ? err.message : String(err)}. ` +
          'The bytes are reclaimable on the next write.',
      );
    }
  }

  /** Refuse the write if the team's live bytes after it would exceed `quotaBytes`. */
  private async assertWithinQuota(
    dir: string,
    teamId: string,
    incomingBytes: number,
    quotaBytes: number,
  ): Promise<void> {
    if (!FilesystemBlobStore.SEGMENT_RE.test(teamId)) {
      throw new Error(`unsafe blob team segment: ${JSON.stringify(teamId)}`);
    }
    const live = await this.liveBytesByDir(join(this.root, teamId));
    let used = 0;
    for (const bytes of live.values()) used += bytes;
    // This key's current version is being replaced, so only what the OTHER keys hold stays.
    const retained = used - (live.get(dir) ?? 0);
    if (retained + incomingBytes > quotaBytes) {
      throw new BlobQuotaExceededError(teamId, used, quotaBytes, incomingBytes);
    }
  }

  /**
   * Size of the latest version in every key directory under `teamDir`, keyed by directory. Walks
   * subdirectories because a key may have more than two segments; skips the `.tmp-*` scratch
   * directories a write in flight leaves beside the versions.
   */
  private async liveBytesByDir(teamDir: string): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    const pending = [teamDir];
    while (pending.length > 0) {
      const dir = pending.pop()!;
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
        throw err;
      }
      let latest: number | null = null;
      for (const entry of entries) {
        if (entry.isDirectory()) {
          if (!entry.name.startsWith('.tmp-')) pending.push(join(dir, entry.name));
          continue;
        }
        const match = FilesystemBlobStore.FILE_RE.exec(entry.name);
        if (!match) continue;
        const version = Number(match[1]);
        if (latest === null || version > latest) latest = version;
      }
      if (latest !== null) {
        result.set(dir, (await stat(join(dir, this.fileName(latest)))).size);
      }
    }
    return result;
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

  /** Every stored version of a key, ascending; empty when the key has never been written. */
  private async listVersions(dir: string): Promise<number[]> {
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
      throw err;
    }
    const versions: number[] = [];
    for (const entry of entries) {
      const match = FilesystemBlobStore.FILE_RE.exec(entry);
      if (match) versions.push(Number(match[1]));
    }
    return versions.sort((a, b) => a - b);
  }

  /** Highest stored version, or null when the key has never been written. */
  private async latestVersion(dir: string): Promise<number | null> {
    const versions = await this.listVersions(dir);
    return versions.length === 0 ? null : versions[versions.length - 1]!;
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
    // THE SCRATCH FILE MUST LIVE IN THE STORE, NOT IN THE SYSTEM TEMP DIRECTORY.
    //
    // It used to be `mkdtemp(join(tmpdir(), …))`, and the `link()` below then failed with EXDEV —
    // "cross-device link not permitted" — whenever the two were on different filesystems. That is
    // not an exotic setup: it is the DEFAULT on most Linux distributions, where /tmp is a tmpfs and
    // BLOB_STORE_PATH would be somewhere under /var. Every single write failed, on the store whose
    // entire purpose is durability. Verified by reproducing both the EXDEV and the EPERM below.
    //
    // Keeping the scratch file inside `dir` guarantees the same filesystem, which is what makes
    // `link()` — the atomic publish this design depends on — possible at all.
    const scratch = await mkdtemp(join(dir, '.tmp-'));
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
      await syncDirectory(dir);
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

/**
 * fsync a directory so a newly-linked entry survives a crash, where the platform supports it.
 *
 * POSIX requires this: the file's own contents being durable says nothing about the directory
 * entry that points at them, so without it a crash can lose a version that readers already
 * consider live.
 *
 * WINDOWS CANNOT DO IT, and used to make every write fail. Opening a directory handle and calling
 * fsync returns EPERM there, which propagated out of `put` — so the durable blob store could not
 * store a blob at all on Windows. It is not merely unsupported but unnecessary: NTFS journals
 * metadata, so the directory entry is already durable once the link returns.
 *
 * Any failure is therefore swallowed rather than propagated. The alternative — failing a write that
 * has already succeeded, because an optimisation could not be applied — is strictly worse than a
 * marginally weaker crash guarantee on platforms that do not need it.
 */
async function syncDirectory(dir: string): Promise<void> {
  try {
    const handle = await open(dir, fsConstants.O_RDONLY);
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // EPERM on Windows, EINVAL/EISDIR on some others. The data itself is already fsync'd.
  }
}
