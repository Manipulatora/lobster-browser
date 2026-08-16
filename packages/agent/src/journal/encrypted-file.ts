import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open, rename, unlink } from 'node:fs/promises';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { MAX_JOURNAL_BYTES } from './schema.js';

const ENVELOPE_PREFIX = 'lobee-run-journal-v1:';
const IV_BYTES = 12;
const TAG_BYTES = 16;

/**
 * Whether this platform can fsync a directory to persist its entries.
 *
 * POSIX: a rename is only durable once the containing directory is fsynced, so the barrier below is
 * mandatory and a failure there is intentionally fatal.
 *
 * Windows: there is no directory fsync. `FlushFileBuffers` on a directory handle returns
 * ERROR_ACCESS_DENIED, which Node surfaces as `EPERM: operation not permitted, fsync` — so the
 * POSIX code path did not merely degrade on Windows, it made every journal write throw and the
 * agent unrunnable. Windows does not need the call: NTFS and ReFS journal metadata operations
 * (create/rename/unlink), so the directory entry produced by the rename is already recoverable
 * after a crash — the same guarantee the POSIX fsync buys. The file contents are still flushed
 * explicitly via `handle.sync()` before the rename on every platform.
 */
const DIRECTORY_SYNC_SUPPORTED = process.platform !== 'win32';

/**
 * `O_NOFOLLOW` refuses to open a final path component that is a symlink. Windows does not define it,
 * and `constants.O_NOFOLLOW` is therefore `undefined` there — which `|` coerces to 0, silently
 * dropping the protection instead of failing. Resolve it once so the degradation is explicit, and
 * fall back to `lstatNoFollow` below wherever it is unavailable.
 */
const O_NOFOLLOW = constants.O_NOFOLLOW ?? 0;
const HAS_O_NOFOLLOW = O_NOFOLLOW !== 0;

/**
 * The portable half of `O_NOFOLLOW`: refuse a path whose final component is a symlink (on Windows,
 * that includes a directory junction, which `lstat` also reports as a link).
 *
 * This is a check-then-open, so unlike the real `O_NOFOLLOW` it has a TOCTOU window. It is only used
 * where the kernel flag does not exist, it is strictly better than the silent no-op it replaces, and
 * Node exposes no way to close the window on Windows. Callers that CREATE a file still use
 * `O_CREAT | O_EXCL`, which is atomic and needs no such check.
 */
async function assertNotSymlink(path: string): Promise<void> {
  if (HAS_O_NOFOLLOW) return;
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new JournalStorageError(`${basename(path)} is a symbolic link`);
    }
  } catch (error) {
    if (isMissing(error)) return; // the open below reports the absence
    throw error;
  }
}

export class JournalStorageError extends Error {
  constructor(message: string) {
    super(`run journal storage error: ${message}`);
    this.name = 'JournalStorageError';
  }
}

/** Safety-focused encrypted file primitive scoped to one journal directory. */
export class EncryptedJournalFile {
  private readonly root: string;
  private readonly key: Buffer;
  private readonly maxPlaintextBytes: number;

  constructor(
    root: string,
    opts: { encryptionKey: string | Uint8Array; maxPlaintextBytes?: number },
  ) {
    this.root = resolve(root);
    this.key = decodeKey(opts.encryptionKey);
    this.maxPlaintextBytes = normalizeByteCap(opts.maxPlaintextBytes);
  }

  resolveFile(filename: string): string {
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}\.journal$/.test(filename)) {
      throw new JournalStorageError('invalid journal filename');
    }
    const path = resolve(this.root, filename);
    this.assertContained(path);
    return path;
  }

  async exists(path: string): Promise<boolean> {
    this.assertContained(path);
    if (!(await this.verifyRoot())) return false;
    let handle;
    try {
      await assertNotSymlink(path);
      handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      if (error instanceof JournalStorageError) throw error;
      throw storageFailure(error, basename(path));
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async read(path: string): Promise<string | null> {
    this.assertContained(path);
    if (!(await this.verifyRoot())) return null;
    let handle;
    try {
      await assertNotSymlink(path);
      handle = await open(path, constants.O_RDONLY | O_NOFOLLOW);
      const stat = await handle.stat();
      if (!stat.isFile()) throw new JournalStorageError(`${basename(path)} is not a regular file`);
      const maxEnvelopeBytes =
        Math.ceil(((this.maxPlaintextBytes + IV_BYTES + TAG_BYTES) * 4) / 3) +
        ENVELOPE_PREFIX.length +
        8;
      if (stat.size > maxEnvelopeBytes) {
        throw new JournalStorageError(`${basename(path)} exceeds the size cap`);
      }
      const raw = (await handle.readFile()).toString('utf8');
      return this.decrypt(raw, path);
    } catch (error) {
      if (isMissing(error)) return null;
      if (error instanceof JournalStorageError) throw error;
      throw storageFailure(error, basename(path));
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  async write(path: string, plaintext: string): Promise<void> {
    this.assertContained(path);
    if (Buffer.byteLength(plaintext, 'utf8') > this.maxPlaintextBytes) {
      throw new JournalStorageError(`journal exceeds the ${this.maxPlaintextBytes}-byte cap`);
    }
    await this.ensureRoot();
    const encrypted = this.encrypt(plaintext, path);
    const temp = resolve(
      dirname(path),
      `.${basename(path)}.${randomBytes(12).toString('hex')}.tmp`,
    );
    this.assertContained(temp);
    let handle;
    try {
      handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
      await handle.writeFile(encrypted, 'utf8');
      // Set the final inode mode before it becomes visible at `path`. A chmod after rename can fail
      // after the new revision has already replaced the old one, making the caller believe an append
      // failed even though the durable journal now says (for example) that dispatch began.
      await handle.chmod(0o600);
      await handle.sync();
      await handle.close();
      handle = undefined;
      await rename(temp, path);
      await this.fsyncDirectory();
    } catch (error) {
      await handle?.close().catch(() => {});
      await unlink(temp).catch(() => {});
      if (error instanceof JournalStorageError) throw error;
      throw storageFailure(error, basename(path));
    }
  }

  async remove(path: string): Promise<void> {
    this.assertContained(path);
    if (!(await this.verifyRoot())) return;
    try {
      await unlink(path);
      await this.fsyncDirectory();
    } catch (error) {
      if (isMissing(error)) return;
      throw storageFailure(error, basename(path));
    }
  }

  private async ensureRoot(): Promise<void> {
    const existed = await this.verifyRoot();
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    if (!(await this.verifyRoot())) {
      throw new JournalStorageError('journal directory disappeared during creation');
    }
    await chmod(this.root, 0o700);
    if (!existed) {
      // Syncing the new directory persists its contents, but not necessarily the directory entry that
      // links it from its parent. Persist that entry before any caller can rely on a journal created in
      // it. A failure is intentionally fatal: this store is an effect-ordering barrier, not best effort.
      await this.fsyncDirectory(dirname(this.root));
    }
  }

  /**
   * A final-component O_NOFOLLOW does not protect against a configured root that is itself a symlink.
   * Refuse that configuration on every operation; callers may safely treat false as an absent store.
   */
  async verifyRoot(): Promise<boolean> {
    try {
      const stat = await lstat(this.root);
      if (stat.isSymbolicLink())
        throw new JournalStorageError('journal directory must not be a symlink');
      if (!stat.isDirectory()) throw new JournalStorageError('journal root is not a directory');
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      if (error instanceof JournalStorageError) throw error;
      throw storageFailure(error, basename(this.root));
    }
  }

  private async fsyncDirectory(path = this.root): Promise<void> {
    // See DIRECTORY_SYNC_SUPPORTED: skipped only where the platform provides the same ordering
    // guarantee through metadata journaling, never as a way to swallow a real sync failure.
    if (!DIRECTORY_SYNC_SUPPORTED) return;
    let handle;
    try {
      handle = await open(path, constants.O_RDONLY);
      await handle.sync();
    } catch (error) {
      // A dispatch marker is not a durability barrier if its rename can disappear after a filesystem
      // or host crash. Refuse to execute on a platform/filesystem that cannot sync the directory
      // instead of silently weakening restart safety.
      throw storageFailure(error, basename(path));
    } finally {
      await handle?.close().catch(() => {});
    }
  }

  private encrypt(plaintext: string, path: string): string {
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    cipher.setAAD(this.aad(path));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return ENVELOPE_PREFIX + Buffer.concat([iv, tag, ciphertext]).toString('base64');
  }

  private decrypt(envelope: string, path: string): string {
    if (!envelope.startsWith(ENVELOPE_PREFIX)) {
      throw new JournalStorageError(`${basename(path)} has an unsupported envelope version`);
    }
    const encoded = envelope.slice(ENVELOPE_PREFIX.length);
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(encoded)) {
      throw new JournalStorageError(`${basename(path)} is corrupt`);
    }
    const payload = Buffer.from(encoded, 'base64');
    if (payload.length <= IV_BYTES + TAG_BYTES) {
      throw new JournalStorageError(`${basename(path)} is corrupt`);
    }
    const iv = payload.subarray(0, IV_BYTES);
    const tag = payload.subarray(IV_BYTES, IV_BYTES + TAG_BYTES);
    const ciphertext = payload.subarray(IV_BYTES + TAG_BYTES);
    try {
      const decipher = createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAAD(this.aad(path));
      decipher.setAuthTag(tag);
      const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
      if (plaintext.byteLength > this.maxPlaintextBytes) {
        throw new JournalStorageError(`${basename(path)} exceeds the plaintext size cap`);
      }
      return plaintext.toString('utf8');
    } catch (error) {
      if (error instanceof JournalStorageError) throw error;
      throw new JournalStorageError(`${basename(path)} authentication failed`);
    }
  }

  private aad(path: string): Buffer {
    this.assertContained(path);
    const relativePath = relative(this.root, resolve(path)).split(sep).join('/');
    return Buffer.from(`${ENVELOPE_PREFIX}\0${relativePath}`, 'utf8');
  }

  private assertContained(path: string): void {
    const candidate = resolve(path);
    const relativePath = relative(this.root, candidate);
    if (
      !relativePath ||
      relativePath.startsWith(`..${sep}`) ||
      relativePath === '..' ||
      isAbsolute(relativePath)
    ) {
      throw new JournalStorageError('path escapes the journal directory');
    }
  }
}

function decodeKey(value: string | Uint8Array): Buffer {
  const key =
    typeof value === 'string'
      ? /^[A-Za-z0-9+/]{43}=$/.test(value)
        ? Buffer.from(value, 'base64')
        : Buffer.alloc(0)
      : Buffer.from(value);
  if (key.length !== 32) {
    throw new JournalStorageError('encryption key must be exactly 32 bytes (base64 or binary)');
  }
  return key;
}

function normalizeByteCap(value: number | undefined): number {
  if (value === undefined) return MAX_JOURNAL_BYTES;
  if (!Number.isSafeInteger(value) || value < 1_024) {
    throw new JournalStorageError('plaintext byte cap must be an integer of at least 1024');
  }
  return Math.min(MAX_JOURNAL_BYTES, value);
}

function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

function storageFailure(error: unknown, filename: string): JournalStorageError {
  const detail = error instanceof Error ? error.message : String(error);
  return new JournalStorageError(`${filename}: ${detail}`);
}
