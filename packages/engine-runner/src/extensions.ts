import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  stat,
  writeFile,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { BrowserExtensionRef } from '@lobster/shared-types';
import yauzl, { type Entry, type ZipFile } from 'yauzl';

export const MAX_CRX_BYTES = 64 * 1024 * 1024;
export const MAX_EXTENSION_UNPACKED_BYTES = 256 * 1024 * 1024;
export const MAX_EXTENSION_FILES = 10_000;
export const EXTENSION_DOWNLOAD_TIMEOUT_MS = 30_000;
const EXTENSION_ID = /^[a-p]{32}$/;
const CRX_MAGIC = Buffer.from('Cr24');
const CRX3_SIGNED_PREFIX = Buffer.from('CRX3 SignedData\0', 'ascii');

export interface PrepareExtensionsOptions {
  cacheDir?: string;
  fetch?: typeof fetch;
  maxCrxBytes?: number;
  timeoutMs?: number;
  webStoreDownloadUrl?: (id: string) => string;
}

interface ProtoField {
  number: number;
  wire: number;
  bytes?: Buffer;
}

interface VerifiedCrx3 {
  id: string;
  zip: Buffer;
}

function readVarint(buffer: Buffer, start: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  for (let offset = start; offset < buffer.length && shift <= 49; offset += 1) {
    const byte = buffer[offset];
    if (byte === undefined) break;
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) return { value, next: offset + 1 };
    shift += 7;
  }
  throw new Error('invalid protobuf varint in CRX3 header');
}

function protoFields(buffer: Buffer): ProtoField[] {
  const fields: ProtoField[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    const tag = readVarint(buffer, offset);
    offset = tag.next;
    const number = Math.floor(tag.value / 8);
    const wire = tag.value & 7;
    if (number <= 0) throw new Error('invalid protobuf field in CRX3 header');
    if (wire === 2) {
      const length = readVarint(buffer, offset);
      offset = length.next;
      const end = offset + length.value;
      if (!Number.isSafeInteger(end) || end > buffer.length) {
        throw new Error('truncated protobuf field in CRX3 header');
      }
      fields.push({ number, wire, bytes: buffer.subarray(offset, end) });
      offset = end;
    } else if (wire === 0) {
      const value = readVarint(buffer, offset);
      fields.push({ number, wire });
      offset = value.next;
    } else if (wire === 1) {
      offset += 8;
      fields.push({ number, wire });
    } else if (wire === 5) {
      offset += 4;
      fields.push({ number, wire });
    } else {
      throw new Error(`unsupported protobuf wire type ${wire} in CRX3 header`);
    }
    if (offset > buffer.length) throw new Error('truncated protobuf field in CRX3 header');
  }
  return fields;
}

function extensionIdFromPublicKey(publicKey: Buffer): string {
  return createHash('sha256')
    .update(publicKey)
    .digest()
    .subarray(0, 16)
    .toString('hex')
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)));
}

function extensionIdFromCrxId(crxId: Buffer): string {
  if (crxId.length !== 16) throw new Error('CRX3 signed extension id is not 16 bytes');
  return crxId
    .toString('hex')
    .replace(/[0-9a-f]/g, (hex) => String.fromCharCode(97 + Number.parseInt(hex, 16)));
}

/** Parse a bare id or an official Chrome Web Store detail URL. Arbitrary URLs are rejected. */
export function parseChromeWebStoreId(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (EXTENSION_ID.test(normalized)) return normalized;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    const modern =
      url.hostname === 'chromewebstore.google.com' && url.pathname.startsWith('/detail/');
    const legacy =
      url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore/detail/');
    if (!modern && !legacy) return undefined;
    return url.pathname
      .split('/')
      .filter(Boolean)
      .reverse()
      .find((part) => EXTENSION_ID.test(part));
  } catch {
    return undefined;
  }
}

/** Verify CRX3 identity and signature before any ZIP parser sees attacker-controlled entries. */
export function verifyCrx3(buffer: Buffer, expectedId: string): VerifiedCrx3 {
  if (!EXTENSION_ID.test(expectedId)) throw new Error(`invalid extension id "${expectedId}"`);
  if (buffer.length < 12 || !buffer.subarray(0, 4).equals(CRX_MAGIC)) {
    throw new Error('download is not a CRX file');
  }
  if (buffer.readUInt32LE(4) !== 3) throw new Error('only CRX3 packages are supported');
  const headerSize = buffer.readUInt32LE(8);
  const zipOffset = 12 + headerSize;
  if (headerSize === 0 || zipOffset > buffer.length) throw new Error('truncated CRX3 header');
  const fields = protoFields(buffer.subarray(12, zipOffset));
  const signedHeader = fields.find((field) => field.number === 10_000)?.bytes;
  if (!signedHeader) throw new Error('CRX3 has no signed header data');
  const crxId = protoFields(signedHeader).find((field) => field.number === 1)?.bytes;
  if (!crxId || extensionIdFromCrxId(crxId) !== expectedId) {
    throw new Error(`CRX3 signed extension id does not match requested id ${expectedId}`);
  }
  const length = Buffer.alloc(4);
  length.writeUInt32LE(signedHeader.length);
  const signed = Buffer.concat([
    CRX3_SIGNED_PREFIX,
    length,
    signedHeader,
    buffer.subarray(zipOffset),
  ]);
  let matchingKey = false;
  let validSignature = false;
  for (const proofField of fields.filter((field) => field.number === 2 || field.number === 3)) {
    if (!proofField.bytes) continue;
    const proof = protoFields(proofField.bytes);
    const publicKey = proof.find((field) => field.number === 1)?.bytes;
    const signature = proof.find((field) => field.number === 2)?.bytes;
    if (!publicKey || !signature || extensionIdFromPublicKey(publicKey) !== expectedId) continue;
    matchingKey = true;
    try {
      const key = createPublicKey({ key: publicKey, format: 'der', type: 'spki' });
      if (verify('sha256', signed, key, signature)) validSignature = true;
    } catch {
      // Invalid key material is handled by the fail-closed check below.
    }
  }
  if (!matchingKey) throw new Error(`CRX3 public key does not derive requested id ${expectedId}`);
  if (!validSignature) throw new Error(`CRX3 signature verification failed for ${expectedId}`);
  const zip = buffer.subarray(zipOffset);
  if (zip.length < 4 || zip[0] !== 0x50 || zip[1] !== 0x4b) {
    throw new Error('CRX3 payload is not a ZIP archive');
  }
  return { id: expectedId, zip };
}

function officialDownloadUrl(id: string): string {
  const x = encodeURIComponent(`id=${id}&installsource=ondemand&uc`);
  return `https://clients2.google.com/service/update2/crx?response=redirect&prodversion=152.0.0.0&acceptformat=crx3&x=${x}`;
}

function allowedDownloadUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'https:' || url.username || url.password) return false;
    return (
      url.hostname === 'clients2.google.com' ||
      url.hostname.endsWith('.googleusercontent.com') ||
      url.hostname.endsWith('.gvt1.com')
    );
  } catch {
    return false;
  }
}

async function responseBytes(response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`extension download exceeds ${maxBytes} bytes`);
  }
  if (!response.body) throw new Error('extension download returned an empty body');
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk);
    total += bytes.length;
    if (total > maxBytes) throw new Error(`extension download exceeds ${maxBytes} bytes`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

export async function downloadChromeWebStoreCrx(
  id: string,
  options: PrepareExtensionsOptions = {},
): Promise<Buffer> {
  if (!EXTENSION_ID.test(id)) throw new Error(`invalid Chrome Web Store extension id "${id}"`);
  const request = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? EXTENSION_DOWNLOAD_TIMEOUT_MS;
  const maxBytes = options.maxCrxBytes ?? MAX_CRX_BYTES;
  let current = (options.webStoreDownloadUrl ?? officialDownloadUrl)(id);
  const deadline = Date.now() + timeoutMs;
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    if (!allowedDownloadUrl(current)) {
      throw new Error(`Chrome Web Store download redirected to a disallowed URL: ${current}`);
    }
    const controller = new AbortController();
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`Chrome Web Store download timed out after ${timeoutMs} ms`);
    }
    const timer = setTimeout(() => controller.abort(), remainingMs);
    try {
      const response = await request(current, {
        redirect: 'manual',
        signal: controller.signal,
        headers: { 'user-agent': 'Lobster Browser extension installer' },
      });
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location)
          throw new Error(`Chrome Web Store redirect ${response.status} had no location`);
        current = new URL(location, current).toString();
        continue;
      }
      if (!response.ok) {
        throw new Error(`Chrome Web Store download failed with HTTP ${response.status}`);
      }
      return await responseBytes(response, maxBytes);
    } catch (error) {
      if (controller.signal.aborted) {
        throw new Error(`Chrome Web Store download timed out after ${timeoutMs} ms`);
      }
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }
  throw new Error('Chrome Web Store download exceeded 5 redirects');
}

function safeArchivePath(root: string, name: string): string {
  if (
    !name ||
    name.includes('\0') ||
    name.includes('\\') ||
    name.startsWith('/') ||
    /^[A-Za-z]:/.test(name)
  ) {
    throw new Error(`unsafe extension archive path "${name}"`);
  }
  const target = resolve(root, name);
  const rel = relative(resolve(root), target);
  if (!rel || rel === '.' || rel.startsWith(`..${sep}`) || rel === '..' || isAbsolute(rel)) {
    throw new Error(`extension archive path escapes destination: "${name}"`);
  }
  return target;
}

function openZip(buffer: Buffer): Promise<ZipFile> {
  return new Promise((resolveZip, reject) => {
    yauzl.fromBuffer(
      buffer,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true, strictFileNames: true },
      (error, zip) => {
        if (error || !zip) reject(error ?? new Error('could not open extension ZIP'));
        else resolveZip(zip);
      },
    );
  });
}

function openEntry(zip: ZipFile, entry: Entry): Promise<NodeJS.ReadableStream> {
  return new Promise((resolveStream, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) reject(error ?? new Error(`could not read ${entry.fileName}`));
      else resolveStream(stream);
    });
  });
}

async function validateExtensionManifest(root: string): Promise<void> {
  const manifestPath = join(root, 'manifest.json');
  const manifestStat = await lstat(manifestPath).catch(() => undefined);
  if (!manifestStat?.isFile() || manifestStat.isSymbolicLink()) {
    throw new Error('extension has no regular root manifest.json');
  }
  let manifest: unknown;
  try {
    manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    throw new Error('extension manifest.json is invalid JSON');
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    throw new Error('extension manifest.json is not an object');
  }
  const version = (manifest as Record<string, unknown>).manifest_version;
  if (version !== 2 && version !== 3) throw new Error('extension manifest_version must be 2 or 3');
}

/** Extract a verified ZIP with traversal, symlink, special-file, count and expansion limits. */
export async function extractExtensionZip(zipBytes: Buffer, destination: string): Promise<void> {
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.extension-'));
  try {
    const zip = await openZip(zipBytes);
    await new Promise<void>((resolveExtraction, reject) => {
      let count = 0;
      let total = 0;
      let active = false;
      const fail = (error: unknown) => {
        zip.close();
        reject(error instanceof Error ? error : new Error(String(error)));
      };
      zip.on('error', fail);
      zip.on('end', () => {
        if (!active) resolveExtraction();
      });
      zip.on('entry', (entry: Entry) => {
        active = true;
        void (async () => {
          count += 1;
          total += entry.uncompressedSize;
          if (count > MAX_EXTENSION_FILES)
            throw new Error('extension archive contains too many files');
          if (
            entry.uncompressedSize > MAX_EXTENSION_UNPACKED_BYTES ||
            total > MAX_EXTENSION_UNPACKED_BYTES
          ) {
            throw new Error('extension archive exceeds unpacked size limit');
          }
          const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
          const kind = mode & 0o170000;
          if (kind === 0o120000)
            throw new Error(`extension archive contains symlink ${entry.fileName}`);
          if (kind !== 0 && kind !== 0o040000 && kind !== 0o100000) {
            throw new Error(`extension archive contains unsafe special file ${entry.fileName}`);
          }
          const target = safeArchivePath(staging, entry.fileName);
          if (entry.fileName.endsWith('/')) {
            await mkdir(target, { recursive: true, mode: 0o700 });
          } else {
            await mkdir(dirname(target), { recursive: true, mode: 0o700 });
            const input = await openEntry(zip, entry);
            const { createWriteStream } = await import('node:fs');
            await pipeline(input, createWriteStream(target, { flags: 'wx', mode: 0o600 }));
          }
          active = false;
          zip.readEntry();
        })().catch(fail);
      });
      zip.readEntry();
    });
    await validateExtensionManifest(staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function snapshotUnpackedDirectory(source: string, destination: string): Promise<void> {
  if (!isAbsolute(source)) throw new Error('local unpacked extension path must be absolute');
  const sourceStat = await lstat(source).catch(() => {
    throw new Error(`local unpacked extension path does not exist: ${source}`);
  });
  if (sourceStat.isSymbolicLink()) {
    throw new Error(`local unpacked extension path must not be a symlink: ${source}`);
  }
  const root = await realpath(source).catch(() => {
    throw new Error(`local unpacked extension path does not exist: ${source}`);
  });
  const rootStat = await lstat(root);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`local unpacked extension path is not a regular directory: ${source}`);
  }
  const parent = dirname(destination);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.unpacked-'));
  let count = 0;
  let total = 0;
  const copyTree = async (from: string, to: string): Promise<void> => {
    const { readdir } = await import('node:fs/promises');
    const entries = await readdir(from, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      count += 1;
      if (count > MAX_EXTENSION_FILES) throw new Error('local extension contains too many files');
      const src = join(from, entry.name);
      const dst = join(to, entry.name);
      const info = await lstat(src);
      if (info.isSymbolicLink()) throw new Error(`local extension contains symlink: ${src}`);
      if (info.isDirectory()) {
        await mkdir(dst, { recursive: true, mode: 0o700 });
        await copyTree(src, dst);
      } else if (info.isFile()) {
        total += info.size;
        if (total > MAX_EXTENSION_UNPACKED_BYTES) {
          throw new Error('local extension exceeds unpacked size limit');
        }
        await copyFile(src, dst);
      } else {
        throw new Error(`local extension contains unsafe special file: ${src}`);
      }
    }
  };
  try {
    await copyTree(root, staging);
    await validateExtensionManifest(staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function cachedCrx(id: string, options: PrepareExtensionsOptions): Promise<VerifiedCrx3> {
  const cacheDir =
    options.cacheDir ??
    process.env.LOBSTER_EXTENSION_CACHE_DIR ??
    join(homedir(), '.cache', 'lobster', 'extensions');
  await mkdir(cacheDir, { recursive: true, mode: 0o700 });
  const path = join(cacheDir, `${id}.crx3`);
  const cached = await readFile(path).catch(() => undefined);
  if (cached) {
    try {
      return verifyCrx3(cached, id);
    } catch {
      await rm(path, { force: true });
    }
  }
  const downloaded = await downloadChromeWebStoreCrx(id, options);
  const verified = verifyCrx3(downloaded, id);
  const temporary = join(cacheDir, `.${id}.${process.pid}.${Date.now()}.tmp`);
  await writeFile(temporary, downloaded, { mode: 0o600, flag: 'wx' });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    if (!(await stat(path).catch(() => undefined))) throw error;
  }
  return verified;
}

/**
 * Resolve every enabled reference to a profile-owned unpacked directory. Disabled refs are intentionally
 * omitted. Any enabled ref that cannot be verified/snapshotted rejects the launch with its list index.
 */
export async function prepareProfileExtensions(
  extensions: readonly BrowserExtensionRef[] | undefined,
  userDataDir: string,
  options: PrepareExtensionsOptions = {},
): Promise<string[]> {
  if (!extensions?.length) return [];
  const root = join(userDataDir, 'lobium-extensions');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const loaded: string[] = [];
  for (const [index, extension] of extensions.entries()) {
    if (!extension.enabled) continue;
    try {
      if (extension.source === 'chrome_web_store') {
        const id = parseChromeWebStoreId(extension.id ?? extension.url ?? '');
        if (!id) throw new Error('invalid Chrome Web Store id or detail URL');
        const crx = await cachedCrx(id, options);
        const destination = join(root, `webstore-${id}`);
        await extractExtensionZip(crx.zip, destination);
        loaded.push(destination);
      } else if (extension.source === 'unpacked') {
        const path = extension.path?.trim();
        if (!path) throw new Error('local unpacked extension has no path');
        const key = createHash('sha256')
          .update(await realpath(path))
          .digest('hex')
          .slice(0, 24);
        const destination = join(
          root,
          `local-${key}-${basename(path).replace(/[^A-Za-z0-9._-]/g, '_')}`,
        );
        await snapshotUnpackedDirectory(path, destination);
        loaded.push(destination);
      } else {
        throw new Error(`unsupported extension source "${String(extension.source)}"`);
      }
    } catch (error) {
      const label =
        extension.name || extension.id || extension.url || extension.path || `#${index + 1}`;
      throw new Error(
        `extension ${label} could not be installed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  return loaded;
}

export function extensionLaunchArgs(paths: readonly string[]): string[] {
  if (!paths.length) return [];
  const unsafe = paths.find((path) => path.includes(',') || /[\0\r\n]/.test(path));
  if (unsafe) {
    throw new Error(
      `extension load path cannot be represented safely in Chromium flags: ${unsafe}`,
    );
  }
  const value = paths.join(',');
  return [`--disable-extensions-except=${value}`, `--load-extension=${value}`];
}
