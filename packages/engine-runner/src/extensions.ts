import { createHash, createPublicKey, verify } from 'node:crypto';
import { proxyDispatcherForUrl } from '@lobster/proxy';
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
import { getBridgeOrigin, issueBridgeToken, provisionProfile } from './agent/bridge-registry.js';

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
  /**
   * The profile's upstream proxy URL. Supplying it is not optional for a proxied profile — see
   * {@link downloadChromeWebStoreCrx}, which refuses to download rather than egress directly.
   */
  proxyUrl?: string;
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

/**
 * Flatten an error and its `cause` chain into one line.
 *
 * undici reports every transport failure as the same opaque `TypeError: fetch failed` and carries the
 * actual reason — `ECONNREFUSED`, a SOCKS5 authentication rejection, a TLS failure, DNS — on
 * `error.cause`. Reporting only `.message` turned "your proxy refused these credentials" into
 * "fetch failed", which is indistinguishable from "the store is down" and leaves the user nothing to
 * act on. Walk the chain so the surfaced message names the thing that actually went wrong.
 */
function describeErrorChain(error: unknown): string {
  const seen = new Set<unknown>();
  const parts: string[] = [];
  let current: unknown = error;
  while (current && !seen.has(current)) {
    seen.add(current);
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(code && !current.message.includes(code) ? `${current.message} (${code})` : current.message);
      current = (current as { cause?: unknown }).cause;
    } else {
      parts.push(String(current));
      break;
    }
  }
  return parts.join(': ');
}

/** Proxy URL with its credentials removed: these strings reach logs and the UI. */
function redactProxyUrl(raw: string): string {
  try {
    const url = new URL(raw);
    return `${url.protocol}//${url.hostname}:${url.port}`;
  } catch {
    return '<unparseable proxy url>';
  }
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
  // This runs inside the launch path, seconds before a proxied session opens for the same profile.
  // A bare fetch puts an HTTPS GET for a named extension id on the wire from the machine's real IP,
  // with a distinctive installer user-agent — host IP → extension id → timestamp, joinable to the
  // proxied session that follows by timing alone. It is a per-machine cache, so it happens once per
  // extension and is almost impossible to notice, which is why it has to be structurally impossible
  // rather than remembered. Fail closed: a profile that has a proxy has it because its traffic must
  // not come from this host, so a route that cannot be built refuses the install.
  let dispatcher: unknown;
  if (options.proxyUrl) {
    try {
      dispatcher = proxyDispatcherForUrl(options.proxyUrl);
    } catch (error) {
      throw new Error(
        `refusing to download extension ${id} directly: this profile's proxy route could not be built (${error instanceof Error ? error.message : String(error)})`,
      );
    }
  }
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
        // undici reads `dispatcher` off the init object; a caller-supplied `fetch` (tests) ignores it.
        ...(dispatcher ? ({ dispatcher } as Record<string, unknown>) : {}),
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
      // Name the route. A profile with a proxy downloads THROUGH it by design (see above), so a
      // failure here is usually the proxy, not the store — and "fetch failed" alone never says so.
      const via = options.proxyUrl
        ? `through this profile's proxy (${redactProxyUrl(options.proxyUrl)})`
        : 'directly';
      throw new Error(
        `Chrome Web Store download ${via} failed: ${describeErrorChain(error)}`,
        { cause: error },
      );
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

async function validateExtensionManifest(root: string): Promise<ExtensionManifestFacts> {
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
  const fields = manifest as Record<string, unknown>;
  const version = fields.manifest_version;
  if (version !== 2 && version !== 3) throw new Error('extension manifest_version must be 2 or 3');
  return {
    manifestVersion: version,
    ...(typeof fields.version === 'string' ? { version: fields.version } : {}),
    ...(typeof fields.name === 'string' ? { name: fields.name } : {}),
  };
}

interface ExtensionManifestFacts {
  manifestVersion: 2 | 3;
  version?: string;
  name?: string;
}

/**
 * The stamp written inside every unpacked extension directory, and the reason a launch no longer
 * re-extracts one it already has.
 *
 * `digest` identifies the SOURCE the directory was produced from — the CRX bytes for a web-store
 * extension, a walk of the tree for a local one. A launch that finds a matching stamp keeps the
 * directory. That is worth hundreds of milliseconds on every launch of a profile with a large
 * extension (the unpack is bounded at 256 MB), and it is also the difference between a developer's
 * in-place edit surviving a relaunch and being silently overwritten.
 *
 * `version` is here because nothing else records it. The web-store download URL asks for `uc` — the
 * latest published build — so the version a profile runs is whatever Google served that day, and
 * without a stamp there is no way to answer "which version was this session established under" after
 * the fact.
 */
const INSTALL_STAMP = '.lobster-extension.json';

interface InstallStamp {
  digest: string;
  source: BrowserExtensionRef['source'];
  id?: string;
  /**
   * The directory this extension occupies, which is what identifies it ACROSS versions.
   *
   * An unpacked extension has no store id, and its digest changes the moment a file does — so
   * merging the ledger on the digest recorded an edited extension as a second install beside its own
   * previous version instead of replacing it. The slot is derived from the source path, so it
   * survives the edit that the digest exists to detect.
   */
  slot?: string;
  name?: string;
  version?: string;
  installedAt: string;
}

async function readStamp(destination: string): Promise<InstallStamp | undefined> {
  const raw = await readFile(join(destination, INSTALL_STAMP), 'utf8').catch(() => undefined);
  if (!raw) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as InstallStamp).digest === 'string'
    ) {
      return parsed as InstallStamp;
    }
  } catch {
    // A stamp we cannot read is a stamp we do not trust: fall through and reinstall.
  }
  return undefined;
}

/**
 * A digest of a local directory as a build tool would take it: every file's relative path, size and
 * modification time, in a stable order. Deliberately not a content hash — the tree is bounded at
 * 256 MB and reading all of it to decide whether to copy all of it would cost what it saves.
 */
async function directoryFingerprint(root: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const hash = createHash('sha256');
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      const info = await lstat(join(dir, entry.name));
      if (info.isDirectory()) {
        hash.update(`d:${rel}\n`);
        await walk(join(dir, entry.name), rel);
      } else if (info.isFile()) {
        hash.update(`f:${rel}:${info.size}:${Math.trunc(info.mtimeMs)}\n`);
      }
    }
  };
  await walk(root, '');
  return hash.digest('hex');
}

/** Extract a verified ZIP with traversal, symlink, special-file, count and expansion limits. */
export async function extractExtensionZip(
  zipBytes: Buffer,
  destination: string,
): Promise<ExtensionManifestFacts> {
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
    const facts = await validateExtensionManifest(staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return facts;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function snapshotUnpackedDirectory(
  source: string,
  destination: string,
): Promise<ExtensionManifestFacts> {
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
    const facts = await validateExtensionManifest(staging);
    await rm(destination, { recursive: true, force: true });
    await rename(staging, destination);
    return facts;
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
  const installed: InstallStamp[] = [];
  for (const [index, extension] of extensions.entries()) {
    if (!extension.enabled) continue;
    try {
      if (extension.source === 'chrome_web_store') {
        const id = parseChromeWebStoreId(extension.id ?? extension.url ?? '');
        if (!id) throw new Error('invalid Chrome Web Store id or detail URL');
        const crx = await cachedCrx(id, options);
        const destination = join(root, `webstore-${id}`);
        const digest = createHash('sha256').update(crx.zip).digest('hex');
        installed.push(
          await install(destination, digest, 'chrome_web_store', id, () =>
            extractExtensionZip(crx.zip, destination),
          ),
        );
        loaded.push(destination);
      } else if (extension.source === 'unpacked') {
        const path = extension.path?.trim();
        if (!path) throw new Error('local unpacked extension has no path');
        const source = await realpath(path);
        const key = createHash('sha256').update(source).digest('hex').slice(0, 24);
        const destination = join(
          root,
          `local-${key}-${basename(path).replace(/[^A-Za-z0-9._-]/g, '_')}`,
        );
        const digest = await directoryFingerprint(source);
        installed.push(
          await install(destination, digest, 'unpacked', undefined, () =>
            snapshotUnpackedDirectory(path, destination),
          ),
        );
        loaded.push(destination);
      } else {
        throw new Error(`unsupported extension source "${String(extension.source)}"`);
      }
    } catch (error) {
      const label =
        extension.name || extension.id || extension.url || extension.path || `#${index + 1}`;
      throw new Error(`extension ${label} could not be installed: ${describeErrorChain(error)}`, {
        cause: error,
      });
    }
  }
  await recordInstalled(root, installed);
  return loaded;
}

/**
 * Unpack into `destination` unless it already holds exactly this source, and stamp the result.
 *
 * The stamp is written LAST and inside the finished directory, so a run that dies mid-unpack leaves
 * no stamp and the next launch redoes the work rather than trusting a partial tree.
 */
async function install(
  destination: string,
  digest: string,
  source: BrowserExtensionRef['source'],
  id: string | undefined,
  unpack: () => Promise<ExtensionManifestFacts>,
): Promise<InstallStamp> {
  const existing = await readStamp(destination);
  if (existing?.digest === digest) return existing;
  const facts = await unpack();
  const stamp: InstallStamp = {
    digest,
    source,
    ...(id ? { id } : {}),
    slot: basename(destination),
    ...(facts.name ? { name: facts.name } : {}),
    ...(facts.version ? { version: facts.version } : {}),
    installedAt: new Date().toISOString(),
  };
  await writeFile(join(destination, INSTALL_STAMP), JSON.stringify(stamp), { mode: 0o600 });
  return stamp;
}

/**
 * The per-profile record of what is installed and at which version, at
 * `<userDataDir>/lobium-extensions/installed.json`.
 *
 * It is a snapshot artifact (`extension-manifest` in the desktop's registry) so it TRAVELS, while the
 * unpacked trees themselves deliberately do not — they are re-fetchable, and a 256 MB tree per
 * profile per machine is not a backup, it is a mirror of the Web Store. What travels is the answer to
 * "which extension, at which version, was this session established under", which is exactly what a
 * restored profile cannot otherwise tell you: the next launch on the new machine fetches whatever the
 * store publishes that day.
 *
 * Merged, not replaced: Lobee installs itself after the user's extensions and must not erase them.
 */
async function recordInstalled(root: string, entries: InstallStamp[]): Promise<void> {
  if (!entries.length) return;
  const path = join(root, 'installed.json');
  const previous = await readFile(path, 'utf8')
    .then((raw): InstallStamp[] => {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as InstallStamp[]) : [];
    })
    .catch(() => [] as InstallStamp[]);
  const merged = new Map<string, InstallStamp>();
  for (const entry of [...previous, ...entries]) {
    if (entry && typeof entry.digest === 'string') {
      merged.set(entry.id ?? entry.slot ?? entry.digest, entry);
    }
  }
  const ordered = [...merged.values()].sort((a, b) =>
    (a.id ?? a.name ?? a.digest).localeCompare(b.id ?? b.name ?? b.digest, 'en'),
  );
  await writeFile(path, JSON.stringify(ordered, null, 2), { mode: 0o600 });
}

/**
 * Stable extension ID of the first-party Lobee side-panel extension. It is DERIVED from the fixed
 * `"key"` (base64 SPKI public key) in `packages/lobee/manifest.json` — Chromium computes the ID as the
 * a–p mapping of the first 16 bytes of SHA-256(DER public key), independent of the load path — so it is
 * known ahead of time and can be pinned. If the manifest key ever changes, recompute this.
 */
export const LOBEE_EXTENSION_ID = 'opbicdcjjlpehmibpmkmkconpnnkijel';

/**
 * Report, on stderr, that this launch will carry no Lobee side panel.
 *
 * Same `[lobium] profile <id> …` report channel the launcher uses for a fail-closed proxy and for
 * extensions `--disable-extensions-except` refuses (see `reportUnloadableUserExtensions`), so every
 * "your browser is not what you configured" line for one launch reads off one stream in one format.
 */
function reportLobeeUnavailable(reason: string, profileId?: string): void {
  const who = profileId ? `profile ${profileId}` : 'this launch';
  console.error(`[lobium] ${who} will run WITHOUT the Lobee side panel: ${reason}`);
}

/**
 * Resolve the first-party Lobee side-panel extension (bundled with the desktop app), so it can be
 * auto-loaded into EVERY profile. The directory comes from `LOBSTER_LOBEE_DIR` (set by the installer)
 * or an explicit override. It is snapshotted into the profile like any unpacked extension. Returns
 * `undefined` when Lobee isn't configured (dev/CI without the bundle) so launches still work — but it
 * SAYS SO on stderr first; see {@link reportLobeeUnavailable}.
 *
 * IT IS LOADED FOR EVERY PACKAGE, INCLUDING THE ONES THAT MAY NOT RUN IT, and the panel locks itself
 * instead. Entitlement is decided by the credential the desktop pushes (see `managed-credential.ts`)
 * and read by the panel from the bridge's `/entitlement`, not baked into this snapshot — because a
 * snapshot is written once at launch and an upgrade bought five minutes later would otherwise need a
 * browser restart to take effect. Withholding the extension entirely would also make an advertised
 * feature simply absent, which reads as a broken build rather than as a package boundary; a panel
 * that names the user's package and what Plus unlocks is the honest version of "not for this plan".
 * Runs are refused by the bridge and again by the proxy regardless of what the panel shows.
 */
export async function prepareDefaultLobeeExtension(
  userDataDir: string,
  profileId?: string,
  dir: string | undefined = process.env.LOBSTER_LOBEE_DIR,
): Promise<string | undefined> {
  const source = dir?.trim();
  if (!source) {
    // SILENCE HERE COST US A SHIPPED FEATURE. Both "not configured" and "configured but empty" used
    // to return undefined without a word, so a packaged build that shipped Lobee on disk but never
    // published LOBSTER_LOBEE_DIR (every Windows install did exactly that — only the Linux launcher
    // wrapper exported it) launched profiles with no side panel and nothing anywhere said so. The
    // user's bug report was "I cannot find Lobee agent extension in the profile", and there was no
    // log line on either side to point at. Still non-fatal — a missing panel must never block a
    // browser launch — but never again invisible.
    reportLobeeUnavailable(
      'LOBSTER_LOBEE_DIR is not set; the desktop app publishes it at startup, so an unset value means ' +
        'either a bare sidecar/dev run or a packaged build that failed to resolve its bundled copy',
      profileId,
    );
    return undefined;
  }
  if (!isAbsolute(source)) throw new Error('LOBSTER_LOBEE_DIR must be an absolute path');
  const manifest = await stat(join(source, 'manifest.json')).catch(() => undefined);
  if (!manifest?.isFile()) {
    // Configured, and wrong: the path exists in someone's mind but carries no extension. Naming the
    // exact directory is the whole point — it is the difference between "Lobee is missing" and
    // "Lobee was looked for HERE". Skipped rather than thrown, so a broken bundle degrades to a
    // browser without a panel instead of a browser that will not start.
    reportLobeeUnavailable(`no manifest.json under ${source}`, profileId);
    return undefined;
  }
  const root = join(userDataDir, 'lobium-extensions');
  await mkdir(root, { recursive: true, mode: 0o700 });
  const destination = join(root, 'lobee');
  // Lobee is loaded into EVERY profile, so its re-copy is the one that happens most often — and the
  // one whose cost is paid by users who never asked for an extension at all.
  const stamp = await install(
    destination,
    await directoryFingerprint(source),
    'unpacked',
    LOBEE_EXTENSION_ID,
    () => snapshotUnpackedDirectory(source, destination),
  );
  await recordInstalled(root, [stamp]);

  // Wire this profile's Lobee panel to the loopback agent bridge: an unguessable per-profile token +
  // the bridge origin, written into THIS snapshot only. `bridge.json` is a normal packaged resource the
  // extension reads via chrome.runtime.getURL — no web page can fetch it (no web_accessible_resources).
  if (profileId) {
    const token = issueBridgeToken(profileId);
    provisionProfile(profileId, { memoryDir: join(userDataDir, 'agent') });
    const config = { origin: getBridgeOrigin(), token, profileId };
    await writeFile(join(destination, 'bridge.json'), JSON.stringify(config), { mode: 0o600 });
  }
  return destination;
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

/** An extension the user installed from inside the browser, which this launch will refuse to load. */
export interface UnloadableUserExtension {
  id: string;
  name?: string;
  version?: string;
}

/**
 * Chromium's `ManifestLocation::kInternal` — a CRX installed through the browser's own web-store flow,
 * i.e. by the user from inside the profile. Our own loads are `kCommandLine` (8) and the bundled PDF
 * viewer is `kComponent` (5), so keying on this value reports only the user's own installs.
 */
const MANIFEST_LOCATION_INTERNAL = 1;

/**
 * List the extensions the user installed from inside the browser, for a launch that carries
 * `--disable-extensions-except` (which {@link extensionLaunchArgs} always emits).
 *
 * That switch makes Chromium refuse every extension not named on it — and it refuses SILENTLY: the CRX
 * is unpacked into `Default/Extensions` and an enabled `extensions.settings` entry is written, so the
 * install looks successful, yet the extension never runs and never appears in chrome://extensions.
 * Dropping the switch would surrender the "only our extensions run" guarantee, so until that product
 * decision is made the launcher at least names what is not loading instead of failing invisibly.
 */
export async function detectUnloadableUserExtensions(
  userDataDir: string,
): Promise<UnloadableUserExtension[]> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(join(userDataDir, 'Default', 'Preferences'), 'utf8'));
  } catch {
    // Absent (fresh profile), unreadable, or corrupt Preferences: nothing to report either way. This is
    // a diagnostic, so it must never be the reason a launch fails.
    return [];
  }
  const settings = (parsed as { extensions?: { settings?: unknown } } | null)?.extensions?.settings;
  if (!settings || typeof settings !== 'object') return [];
  const found: UnloadableUserExtension[] = [];
  for (const [id, value] of Object.entries(settings as Record<string, unknown>)) {
    if (!value || typeof value !== 'object') continue;
    const entry = value as { location?: unknown; manifest?: { name?: unknown; version?: unknown } };
    if (entry.location !== MANIFEST_LOCATION_INTERNAL) continue;
    const name = typeof entry.manifest?.name === 'string' ? entry.manifest.name : undefined;
    const version =
      typeof entry.manifest?.version === 'string' ? entry.manifest.version : undefined;
    found.push({ id, ...(name ? { name } : {}), ...(version ? { version } : {}) });
  }
  return found;
}
