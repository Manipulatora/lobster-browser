#!/usr/bin/env node

import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { createReadStream } from 'node:fs';
import { lstat, readFile, readdir, stat } from 'node:fs/promises';
import { extname, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

export const ENGINE_MARKER = 'LOBSTER_ENGINE.json';
export const ARTIFACT_TREE_ALGORITHM = 'sha256-path-size-content-v1';
export const FONT_PACK_MANIFEST = 'font-pack.manifest.json';
export const FONT_FAMILY_INVENTORY_ALGORITHM = 'sha256-path-content-families-v1';
export const LOBIUM_CAPABILITY_CONTRACT_VERSION = 3;
export const WINDOWS_REQUIRED_CAPABILITIES = Object.freeze([
  'config-channel-v1',
  'navigator-ua-ch',
  'navigator-webdriver',
  'navigator-languages',
  'network-accept-language',
  'process-locale-timezone',
  'native-geolocation',
  'webrtc-policy',
  'webgl-deep',
  'webgl2-deep',
  'screen-metrics',
  'mobile-persona',
  'canvas-farbling',
  'webgl-farbling',
  'audio-farbling',
  'client-rects',
  'media-devices',
  'webgpu-adapter',
  'native-timezone',
  'font-isolation',
  // The Android phone/tablet stage. Windows-relevant since 2026-08-26: branding/device-frame.patch
  // was Linux-only, so a Windows build compiled LobiumDeviceFrameView and then dropped it at link
  // time because every BrowserView call site was #if BUILDFLAG(IS_LINUX). Nothing caught that,
  // because the capability contract did not cover the feature and Chromium ignores switches it does
  // not recognise — the launcher kept sending --lobium-device-frame to a binary that had no idea
  // what it meant, and every Android profile opened as a plain desktop window while reporting
  // success. Requiring it here makes a runtime without the frame unpackageable rather than
  // shippable.
  'device-frame',
]);

const SHA256 = /^[0-9a-f]{64}$/;
const GIT_COMMIT = /^[0-9a-f]{40}$/;
const VERSION = /^\d+\.\d+\.\d+\.\d+$/;
const FONT_EXTENSIONS = new Set(['.ttf', '.ttc', '.otf']);
const FONT_LIKE_EXTENSIONS = new Set([...FONT_EXTENSIONS, '.otc', '.woff', '.woff2', '.eot']);
const FONT_PERSONAS = Object.freeze(['windows', 'macos', 'linux', 'android']);
const FONT_SCANNER_VERSION = /^fontconfig version (\d+\.\d+(?:\.\d+)?)$/;
const execFileAsync = promisify(execFile);

function fail(message) {
  throw new Error(`invalid Lobium runtime: ${message}`);
}

function fontFail(message) {
  throw new Error(`invalid Lobium font pack: ${message}`);
}

function normalizedSafeRelativePath(value, label, failure) {
  if (typeof value !== 'string' || value.length === 0) failure(`${label} is empty`);
  const normalized = value.replaceAll('\\', '/');
  const parts = normalized.split('/');
  if (
    normalized.startsWith('/') ||
    /^[a-z]:/i.test(normalized) ||
    /[\u0000-\u001f<>:"|?*]/.test(normalized) ||
    parts.some((part) => part === '' || part === '.' || part === '..' || /[. ]$/.test(part))
  ) {
    failure(`${label} is unsafe: ${JSON.stringify(value)}`);
  }
  return normalized;
}

function safeRelativePath(value, label = 'artifact path') {
  return normalizedSafeRelativePath(value, label, fail);
}

function safeFontRelativePath(value, label) {
  const normalized = normalizedSafeRelativePath(value, label, fontFail);
  if (normalized !== value) fontFail(`${label} must use canonical '/' separators`);
  if (
    normalized
      .split('/')
      .some((part) => /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))
  ) {
    fontFail(`${label} contains a reserved Windows device name`);
  }
  return normalized;
}

function uniqueNonEmptyStrings(value, label) {
  if (!Array.isArray(value) || value.length === 0) fontFail(`${label} is empty or absent`);
  const result = [];
  const seen = new Set();
  for (const item of value) {
    if (typeof item !== 'string' || item.length === 0 || item !== item.trim()) {
      fontFail(`${label} contains an invalid string`);
    }
    if (seen.has(item)) fontFail(`${label} contains duplicate value ${JSON.stringify(item)}`);
    seen.add(item);
    result.push(item);
  }
  return result;
}

const compareOrdinal = (left, right) => (left < right ? -1 : left > right ? 1 : 0);

/** Require the scanner's complete family set to equal the manifest declaration byte-for-byte. */
export function assertExactFontFamilies(path, declaredFamilies, scannedFamilies) {
  const declared = uniqueNonEmptyStrings(declaredFamilies, `font ${path} declared families`).sort(
    compareOrdinal,
  );
  const scanned = uniqueNonEmptyStrings(scannedFamilies, `font ${path} scanned families`).sort(
    compareOrdinal,
  );
  const declaredSet = new Set(declared);
  const scannedSet = new Set(scanned);
  const missing = declared.filter((family) => !scannedSet.has(family));
  const undeclared = scanned.filter((family) => !declaredSet.has(family));
  if (missing.length || undeclared.length) {
    fontFail(
      `font ${path} scanned family inventory differs from its declaration ` +
        `(missing: ${missing.join(', ') || 'none'}; undeclared: ${undeclared.join(', ') || 'none'})`,
    );
  }
  return declared;
}

/** Parse one fc-scan family per line, including fontconfig's comma-separated alias representation. */
export function parseFontScannerFamilies(path, stdout) {
  if (typeof stdout !== 'string' || stdout.length === 0) {
    fontFail(`font scanner returned no family output for ${path}`);
  }
  const normalized = stdout.replaceAll('\r\n', '\n');
  const lines = normalized.endsWith('\n')
    ? normalized.slice(0, -1).split('\n')
    : normalized.split('\n');
  if (!lines.length || lines.some((line) => line.length === 0)) {
    fontFail(`font scanner returned an empty family line for ${path}`);
  }
  const families = [];
  const seen = new Set();
  for (const line of lines) {
    for (const rawFamily of line.split(',')) {
      const family = rawFamily.trim();
      if (!family) fontFail(`font scanner returned an empty family for ${path}`);
      if (seen.has(family)) {
        fontFail(`font scanner returned duplicate family ${JSON.stringify(family)} for ${path}`);
      }
      seen.add(family);
      families.push(family);
    }
  }
  return families;
}

/** Bind each declared family set to the path and content digest of the bytes that expose it. */
export function buildFontFamilyInventory(manifest) {
  const entries = manifest.files
    .map((file, index) => ({
      path: safeFontRelativePath(file.path, `file entry ${index} path`),
      sha256: file.sha256,
      families: uniqueNonEmptyStrings(file.families, `file ${file.path} families`).sort(
        compareOrdinal,
      ),
    }))
    .sort((left, right) => compareOrdinal(left.path, right.path));
  const canonical = JSON.stringify(
    entries.map(({ path, sha256, families }) => [path, sha256, families]),
  );
  return {
    algorithm: FONT_FAMILY_INVENTORY_ALGORITHM,
    sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}

/** A release rescan must use the exact scanner whose provenance the package marker records. */
export function assertExactFontScannerProvenance(recorded, observed) {
  const fields = ['product', 'version', 'executableSha256'];
  const mismatch = fields.filter((field) => recorded?.[field] !== observed?.[field]);
  if (mismatch.length) {
    fail(`font scanner provenance differs from the packaging attestation: ${mismatch.join(', ')}`);
  }
  return observed;
}

async function sha256File(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function walkFiles(root, dir = root) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    if (entry.isSymbolicLink()) fail(`symbolic links are not allowed: ${relative(root, absolute)}`);
    if (entry.isDirectory()) found.push(...(await walkFiles(root, absolute)));
    else if (entry.isFile()) found.push(absolute);
    else fail(`unsupported filesystem entry: ${relative(root, absolute)}`);
  }
  return found;
}

async function ordinaryPath(path, kind, label, { nonzero = false } = {}) {
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    fontFail(`${label} is absent or unreadable: ${error instanceof Error ? error.message : error}`);
  }
  const expected = kind === 'directory' ? info.isDirectory() : info.isFile();
  if (!expected || info.isSymbolicLink()) fontFail(`${label} is not an ordinary ${kind}: ${path}`);
  if (nonzero && info.size === 0) fontFail(`${label} is empty: ${path}`);
  return info;
}

async function rejectPortableLinks(root, dir = root) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      fontFail(`links or reparse points are not allowed: ${relative(root, absolute)}`);
    }
    if (info.isDirectory()) await rejectPortableLinks(root, absolute);
    else if (!info.isFile()) fontFail(`unsupported filesystem entry: ${relative(root, absolute)}`);
  }
}

async function rejectWindowsReparsePoints(root) {
  if (process.platform !== 'win32') return;
  // Node identifies junctions and symbolic links, but Windows has additional reparse-point types
  // (for example cloud placeholders). Ask Windows itself for the attribute without interpolating the
  // caller's path into a command string. The iterative walk refuses a reparse directory before it
  // can be traversed.
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$root = $env:LOBSTER_FONT_PACK_REPARSE_ROOT
$pending = New-Object System.Collections.Stack
$pending.Push((Get-Item -LiteralPath $root -Force))
while ($pending.Count -gt 0) {
  $item = $pending.Pop()
  if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
    [Console]::Error.WriteLine("font pack contains a Windows reparse point: $($item.FullName)")
    exit 17
  }
  if ($item.PSIsContainer) {
    foreach ($child in @(Get-ChildItem -LiteralPath $item.FullName -Force)) {
      $pending.Push($child)
    }
  }
}`;
  try {
    await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      env: { ...process.env, LOBSTER_FONT_PACK_REPARSE_ROOT: root },
      windowsHide: true,
    });
  } catch (error) {
    const detail = `${error?.stderr ?? ''}${error?.stdout ?? ''}`.trim();
    fontFail(detail || `could not audit Windows reparse points below ${root}`);
  }
}

function normalizeFontScanner(fontScanner) {
  if (typeof fontScanner !== 'string' || !fontScanner) {
    fontFail('font scanner must name one explicit executable');
  }
  return { executable: resolve(fontScanner) };
}

async function prepareFontScanner(fontScanner) {
  const scanner = normalizeFontScanner(fontScanner);
  await ordinaryPath(scanner.executable, 'file', 'font scanner executable', { nonzero: true });
  await rejectWindowsReparsePoints(scanner.executable);

  let stdout;
  let stderr;
  try {
    ({ stdout, stderr } = await execFileAsync(scanner.executable, ['--version'], {
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    }));
  } catch (error) {
    fontFail(
      `font scanner version probe failed: ${error instanceof Error ? error.message : error}`,
    );
  }
  const stdoutVersion = stdout.trim();
  const stderrVersion = stderr.trim();
  if (stdoutVersion && stderrVersion) {
    fontFail('font scanner version probe wrote conflicting stdout and stderr output');
  }
  // fc-scan writes `--version` to stderr on Windows/MSYS2 and stdout on common Linux builds.
  // Accept exactly one channel, then apply the same strict one-line grammar to either platform.
  const versionOutput = stdoutVersion || stderrVersion;
  const versionLines = versionOutput.replaceAll('\r\n', '\n').split('\n');
  if (versionLines.length !== 1 || !FONT_SCANNER_VERSION.test(versionLines[0])) {
    fontFail(
      `font scanner returned an unsupported version string: ${JSON.stringify(versionOutput)}`,
    );
  }
  return {
    ...scanner,
    provenance: {
      product: 'fontconfig-fc-scan',
      version: versionLines[0],
      executableSha256: await sha256File(scanner.executable),
    },
  };
}

async function scanDeclaredFontFamilies(root, manifest, fontScanner) {
  const scanner = await prepareFontScanner(fontScanner);
  for (const file of manifest.files) {
    const absolute = resolve(root, ...file.path.split('/'));
    let stdout;
    let stderr;
    try {
      ({ stdout, stderr } = await execFileAsync(
        scanner.executable,
        ['--format', '%{family}\\n', absolute],
        {
          encoding: 'utf8',
          maxBuffer: 1024 * 1024,
          timeout: 30_000,
          windowsHide: true,
        },
      ));
    } catch (error) {
      fontFail(
        `font scanner failed for ${file.path}: ${error instanceof Error ? error.message : error}`,
      );
    }
    if (stderr.trim()) fontFail(`font scanner wrote to stderr for ${file.path}: ${stderr.trim()}`);
    const scanned = parseFontScannerFamilies(file.path, stdout);
    assertExactFontFamilies(file.path, file.families, scanned);
  }
  return scanner.provenance;
}

async function discoverFontFiles(root, filesRoot, dir = filesRoot) {
  const discovered = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const absolute = resolve(dir, entry.name);
    const info = await lstat(absolute);
    if (info.isSymbolicLink()) {
      fontFail(`links or reparse points are not allowed: ${relative(root, absolute)}`);
    }
    if (info.isDirectory()) {
      discovered.push(...(await discoverFontFiles(root, filesRoot, absolute)));
    } else if (info.isFile()) {
      const extension = extname(entry.name).toLowerCase();
      if (FONT_EXTENSIONS.has(extension)) {
        if (info.size === 0) fontFail(`font file is empty: ${relative(root, absolute)}`);
        discovered.push(relative(root, absolute).split(sep).join('/'));
      } else if (FONT_LIKE_EXTENSIONS.has(extension)) {
        fontFail(`font file uses an unsupported extension: ${relative(root, absolute)}`);
      }
    } else {
      fontFail(`unsupported filesystem entry: ${relative(root, absolute)}`);
    }
  }
  return discovered;
}

/** Verify a v1 open-font pack as a self-contained physical and licensing ledger. */
export async function verifyFontPack(fontsBaseDir) {
  const root = resolve(fontsBaseDir);
  const manifestPath = resolve(root, FONT_PACK_MANIFEST);
  const filesRoot = resolve(root, 'files');
  await ordinaryPath(root, 'directory', 'font pack root');
  await rejectWindowsReparsePoints(root);
  await rejectPortableLinks(root);
  await ordinaryPath(filesRoot, 'directory', 'font pack files root');
  await ordinaryPath(manifestPath, 'file', 'font pack manifest', { nonzero: true });

  let manifest;
  try {
    manifest = JSON.parse((await readFile(manifestPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    fontFail(
      `cannot parse ${FONT_PACK_MANIFEST}: ${error instanceof Error ? error.message : error}`,
    );
  }
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)) {
    fontFail('manifest is not an object');
  }
  if (manifest.version !== 1) fontFail(`unsupported manifest version ${manifest.version ?? '?'}`);
  if (
    typeof manifest.packId !== 'string' ||
    manifest.packId.length === 0 ||
    manifest.packId !== manifest.packId.trim()
  ) {
    fontFail('packId is empty or malformed');
  }
  if (!Array.isArray(manifest.files) || manifest.files.length === 0) {
    fontFail('manifest declares no font files');
  }

  const declared = new Map();
  const declaredCaseFolded = new Set();
  const physicalFamilies = new Set();
  for (const [index, rawFile] of manifest.files.entries()) {
    if (!rawFile || typeof rawFile !== 'object' || Array.isArray(rawFile)) {
      fontFail(`file entry ${index} is not an object`);
    }
    const path = safeFontRelativePath(rawFile.path, `file entry ${index} path`);
    if (!path.startsWith('files/') || !FONT_EXTENSIONS.has(extname(path).toLowerCase())) {
      fontFail(`file entry ${index} is not an allowed font below files/: ${path}`);
    }
    const folded = path.toLowerCase();
    if (declaredCaseFolded.has(folded)) fontFail(`duplicate font path ${path}`);
    declaredCaseFolded.add(folded);
    if (!SHA256.test(rawFile.sha256 ?? '')) fontFail(`file ${path} has an invalid SHA-256`);
    const families = uniqueNonEmptyStrings(rawFile.families, `file ${path} families`);
    if (
      typeof rawFile.license !== 'string' ||
      rawFile.license.length === 0 ||
      rawFile.license !== rawFile.license.trim()
    ) {
      fontFail(`file ${path} has an invalid license identifier`);
    }
    const absolute = resolve(root, ...path.split('/'));
    await ordinaryPath(absolute, 'file', `declared font ${path}`, { nonzero: true });
    const actualSha256 = await sha256File(absolute);
    if (actualSha256 !== rawFile.sha256) {
      fontFail(`font ${path} failed SHA-256 verification`);
    }
    for (const family of families) physicalFamilies.add(family);
    declared.set(path, { ...rawFile, families });
  }

  const discovered = (await discoverFontFiles(root, filesRoot)).sort();
  const declaredPaths = [...declared.keys()].sort();
  const undeclared = discovered.filter((path) => !declared.has(path));
  const missing = declaredPaths.filter((path) => !discovered.includes(path));
  if (undeclared.length || missing.length) {
    fontFail(
      `font file ledger mismatch (undeclared: ${undeclared.join(', ') || 'none'}; ` +
        `missing: ${missing.join(', ') || 'none'})`,
    );
  }

  if (
    !manifest.personas ||
    typeof manifest.personas !== 'object' ||
    Array.isArray(manifest.personas)
  ) {
    fontFail('personas are absent or malformed');
  }
  const personaCoverage = new Set();
  for (const persona of FONT_PERSONAS) {
    const rawPersona = manifest.personas[persona];
    if (!rawPersona || typeof rawPersona !== 'object' || Array.isArray(rawPersona)) {
      fontFail(`${persona} persona is absent or malformed`);
    }
    uniqueNonEmptyStrings(rawPersona.families, `${persona} persona families`);
    const physical = uniqueNonEmptyStrings(
      rawPersona.physicalFamilies,
      `${persona} persona physicalFamilies`,
    );
    const selectedPhysical = new Set(physical);
    for (const family of physical) {
      if (!physicalFamilies.has(family)) {
        fontFail(`${persona} persona physical family is not backed by a declared file: ${family}`);
      }
      personaCoverage.add(family);
    }
    // DirectWrite stages whole font files, not individual faces inside a TTC. If a persona selects
    // one family from a multi-family file, every family exposed by those same bytes enters its private
    // collection. Require the manifest to describe that effective set now so a package that passed
    // release verification cannot fail later at the launcher boundary (or silently widen a persona).
    for (const [path, file] of declared) {
      if (!file.families.some((family) => selectedPhysical.has(family))) continue;
      const outsidePersona = file.families.filter((family) => !selectedPhysical.has(family));
      if (outsidePersona.length) {
        fontFail(
          `${persona} persona selects only part of multi-family font ${path} ` +
            `(also exposed: ${outsidePersona.join(', ')})`,
        );
      }
    }
  }
  const uncovered = [...physicalFamilies].filter((family) => !personaCoverage.has(family)).sort();
  if (uncovered.length)
    fontFail(`declared physical families have no persona coverage: ${uncovered.join(', ')}`);

  if (!Array.isArray(manifest.licenses) || manifest.licenses.length === 0) {
    fontFail('licenses are absent or malformed');
  }
  const licenses = new Map();
  for (const [index, rawLicense] of manifest.licenses.entries()) {
    if (!rawLicense || typeof rawLicense !== 'object' || Array.isArray(rawLicense)) {
      fontFail(`license entry ${index} is not an object`);
    }
    for (const field of ['family', 'license', 'licenseUrl']) {
      const value = rawLicense[field];
      if (typeof value !== 'string' || value.length === 0 || value !== value.trim()) {
        fontFail(`license entry ${index} has an invalid ${field}`);
      }
    }
    let licenseUrl;
    try {
      licenseUrl = new URL(rawLicense.licenseUrl);
    } catch {
      fontFail(`license entry ${index} has an invalid licenseUrl`);
    }
    if (licenseUrl.protocol !== 'https:' || licenseUrl.username || licenseUrl.password) {
      fontFail(`license entry ${index} must use an HTTPS licenseUrl without credentials`);
    }
    if (licenses.has(rawLicense.family)) fontFail(`duplicate license family ${rawLicense.family}`);
    licenses.set(rawLicense.family, rawLicense);
  }
  const extraLicenses = [...licenses.keys()]
    .filter((family) => !physicalFamilies.has(family))
    .sort();
  const missingLicenses = [...physicalFamilies].filter((family) => !licenses.has(family)).sort();
  if (extraLicenses.length || missingLicenses.length) {
    fontFail(
      `license family coverage mismatch (extra: ${extraLicenses.join(', ') || 'none'}; ` +
        `missing: ${missingLicenses.join(', ') || 'none'})`,
    );
  }
  for (const [path, file] of declared) {
    for (const family of file.families) {
      if (licenses.get(family).license !== file.license) {
        fontFail(`license identifier for ${family} does not match declared font ${path}`);
      }
    }
  }
  return manifest;
}

/**
 * Verify both the manifest/file ledgers and the family names actually encoded in every font file.
 * The scanner is an explicit executable and is invoked directly, never through a command shell.
 */
export async function verifyFontPackWithScanner(fontsBaseDir, fontScanner) {
  const root = resolve(fontsBaseDir);
  const manifest = await verifyFontPack(root);
  const scanner = await scanDeclaredFontFamilies(root, manifest, fontScanner);
  return {
    manifest,
    fontInventory: { ...buildFontFamilyInventory(manifest), scanner },
  };
}

/**
 * Hash every runtime file except the marker that carries this ledger. Paths use `/` and are sorted
 * by Unicode code point. The tree digest hashes one UTF-8 line per file:
 *
 *     relative/path<TAB>decimal-bytes<TAB>lowercase-file-sha256<LF>
 *
 * This is intentionally simple enough to reproduce in Windows PowerShell 5.1 without depending on
 * JSON property ordering or a platform-specific directory enumeration order.
 */
export async function buildArtifactLedger(runtimeDir) {
  const root = resolve(runtimeDir);
  if (!(await stat(root)).isDirectory()) fail(`${root} is not a directory`);
  const paths = (await walkFiles(root))
    .map((absolute) => ({
      absolute,
      path: relative(root, absolute).split(sep).join('/'),
    }))
    .filter(({ path }) => path !== ENGINE_MARKER)
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const files = [];
  for (const item of paths) {
    const info = await stat(item.absolute);
    files.push({
      path: safeRelativePath(item.path),
      bytes: info.size,
      sha256: await sha256File(item.absolute),
    });
  }
  const canonical = files.map((file) => `${file.path}\t${file.bytes}\t${file.sha256}\n`).join('');
  return {
    algorithm: ARTIFACT_TREE_ALGORITHM,
    treeSha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
    files,
  };
}

export async function verifyLobiumRuntime(runtimeDir, { fontScanner } = {}) {
  const root = resolve(runtimeDir);
  const markerPath = resolve(root, ENGINE_MARKER);
  let marker;
  try {
    marker = JSON.parse((await readFile(markerPath, 'utf8')).replace(/^\uFEFF/, ''));
  } catch (error) {
    fail(`cannot read ${ENGINE_MARKER}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!marker || typeof marker !== 'object' || Array.isArray(marker))
    fail('marker is not an object');
  if (marker.schemaVersion !== 2) fail(`unsupported marker schema ${marker.schemaVersion}`);
  if (marker.engine !== 'lobium' || marker.platform !== 'win-x64') {
    fail(`marker identifies ${marker.engine ?? '?'} on ${marker.platform ?? '?'}`);
  }
  if (!VERSION.test(marker.version ?? '')) fail(`invalid engine version ${marker.version ?? '?'}`);
  const chrome = safeRelativePath(marker.chrome, 'chrome path');
  if (chrome !== 'chrome.exe') fail(`unexpected browser executable ${chrome}`);
  if (marker.fonts !== null && marker.fonts !== undefined) {
    const fonts = safeRelativePath(marker.fonts, 'font manifest path');
    if (fonts !== 'fonts/font-pack.manifest.json') {
      fail(`unexpected font manifest ${fonts}`);
    }
  }
  if (typeof marker.fonts === 'string') {
    const inventory = marker.fontInventory;
    if (
      !inventory ||
      inventory.algorithm !== FONT_FAMILY_INVENTORY_ALGORITHM ||
      !SHA256.test(inventory.sha256 ?? '') ||
      !inventory.scanner ||
      inventory.scanner.product !== 'fontconfig-fc-scan' ||
      !FONT_SCANNER_VERSION.test(inventory.scanner.version ?? '') ||
      !SHA256.test(inventory.scanner.executableSha256 ?? '')
    ) {
      fail('font-family inventory attestation is absent or malformed');
    }
  } else if (marker.fontInventory !== null) {
    fail('font-family inventory attestation exists without a provisioned font pack');
  }
  if (
    !marker.provenance ||
    marker.provenance.chromiumRef !== marker.version ||
    marker.provenance.capabilityContractVersion !== LOBIUM_CAPABILITY_CONTRACT_VERSION ||
    !SHA256.test(marker.provenance.buildArgsSha256 ?? '') ||
    !GIT_COMMIT.test(marker.provenance.chromiumCommit ?? '') ||
    !GIT_COMMIT.test(marker.provenance.lobsterRevision ?? '') ||
    typeof marker.provenance.lobsterWorkingTreeDirty !== 'boolean' ||
    !Array.isArray(marker.provenance.capabilities) ||
    marker.provenance.capabilities.some((capability) => typeof capability !== 'string')
  ) {
    fail('build provenance is absent or malformed');
  }
  const capabilities = new Set(marker.provenance.capabilities);
  if (
    capabilities.size !== WINDOWS_REQUIRED_CAPABILITIES.length ||
    marker.provenance.capabilities.length !== WINDOWS_REQUIRED_CAPABILITIES.length ||
    WINDOWS_REQUIRED_CAPABILITIES.some((capability) => !capabilities.has(capability))
  ) {
    fail('build provenance capability set differs from the Windows contract');
  }
  if (!marker.artifacts || marker.artifacts.algorithm !== ARTIFACT_TREE_ALGORITHM) {
    fail(`unsupported artifact ledger algorithm ${marker.artifacts?.algorithm ?? '?'}`);
  }
  if (!SHA256.test(marker.artifacts.treeSha256 ?? '') || !Array.isArray(marker.artifacts.files)) {
    fail('artifact ledger is malformed');
  }

  const recorded = marker.artifacts.files;
  const seen = new Set();
  for (const [index, file] of recorded.entries()) {
    const path = safeRelativePath(file?.path, `artifact ${index} path`);
    if (seen.has(path)) fail(`duplicate artifact path ${path}`);
    seen.add(path);
    if (!Number.isSafeInteger(file?.bytes) || file.bytes < 0 || !SHA256.test(file?.sha256 ?? '')) {
      fail(`artifact ${path} has an invalid size or SHA-256`);
    }
    if (index > 0 && recorded[index - 1].path >= path)
      fail('artifact ledger is not ordinally sorted');
  }

  const actual = await buildArtifactLedger(root);
  if (JSON.stringify(recorded) !== JSON.stringify(actual.files)) {
    fail('artifact file set, size, or SHA-256 differs from the marker');
  }
  if (marker.artifacts.treeSha256 !== actual.treeSha256) {
    fail(
      `tree SHA-256 differs (marker ${marker.artifacts.treeSha256}, actual ${actual.treeSha256})`,
    );
  }
  if (!seen.has(chrome)) fail(`${chrome} is absent from the artifact ledger`);
  if (!seen.has(`${marker.version}.manifest`)) {
    fail(`${marker.version}.manifest is absent from the artifact ledger`);
  }
  if (typeof marker.fonts === 'string' && !seen.has(marker.fonts.replaceAll('\\', '/'))) {
    fail(`${marker.fonts} is absent from the artifact ledger`);
  }
  if (typeof marker.fonts === 'string') {
    const fontsRoot = resolve(root, 'fonts');
    const verified = fontScanner
      ? await verifyFontPackWithScanner(fontsRoot, fontScanner)
      : { manifest: await verifyFontPack(fontsRoot) };
    const actualInventory = buildFontFamilyInventory(verified.manifest);
    if (
      marker.fontInventory.algorithm !== actualInventory.algorithm ||
      marker.fontInventory.sha256 !== actualInventory.sha256
    ) {
      fail('font-family inventory differs from the packaging attestation');
    }
    if (fontScanner) {
      assertExactFontScannerProvenance(
        marker.fontInventory.scanner,
        verified.fontInventory.scanner,
      );
    }
  } else if (seen.has(`fonts/${FONT_PACK_MANIFEST}`)) {
    fail(`font pack is present but marker.fonts records no provisioned pack`);
  }
  return marker;
}

const thisFile = resolve(fileURLToPath(import.meta.url));
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : '';
if (invokedFile && invokedFile.toLowerCase() === thisFile.toLowerCase()) {
  const argv = process.argv.slice(2);
  const fontPackMode = argv[0] === '--font-pack';
  const target = fontPackMode ? argv[1] : argv[0];
  let fontScanner;
  let json = false;
  let invalid = !target;
  for (let index = fontPackMode ? 2 : 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--font-scanner' && !fontScanner && argv[index + 1]) {
      fontScanner = argv[++index];
    } else if (argument === '--json' && !json) {
      json = true;
    } else {
      invalid = true;
    }
  }
  if (fontPackMode && !fontScanner) invalid = true;
  if (invalid) {
    console.error(
      'usage: node scripts/verify-lobium-runtime.mjs <runtime-directory> ' +
        '[--font-scanner <fc-scan-executable>] [--json]\n' +
        '   or: node scripts/verify-lobium-runtime.mjs --font-pack <font-pack-directory> ' +
        '--font-scanner <fc-scan-executable> [--json]',
    );
    process.exitCode = 2;
  } else {
    try {
      if (fontPackMode) {
        const result = await verifyFontPackWithScanner(target, fontScanner);
        if (json) {
          console.log(
            JSON.stringify({
              kind: 'font-pack',
              packId: result.manifest.packId,
              files: result.manifest.files.length,
              fontInventory: result.fontInventory,
            }),
          );
        } else {
          console.log(
            `verified Lobium font pack ${result.manifest.packId}: ` +
              `${result.manifest.files.length} files with exact scanned family inventories`,
          );
        }
      } else {
        const marker = await verifyLobiumRuntime(target, { fontScanner });
        if (json) {
          console.log(
            JSON.stringify({
              kind: 'runtime',
              version: marker.version,
              platform: marker.platform,
              files: marker.artifacts.files.length,
              treeSha256: marker.artifacts.treeSha256,
              fontInventory: marker.fontInventory,
              fontBytesRescanned: Boolean(fontScanner && typeof marker.fonts === 'string'),
            }),
          );
        } else if (fontScanner && typeof marker.fonts === 'string') {
          console.log(
            `verified Lobium ${marker.version} ${marker.platform}: ` +
              `${marker.artifacts.files.length} files, tree ${marker.artifacts.treeSha256}; ` +
              'font bytes rescanned against the packaged family attestation',
          );
        } else if (typeof marker.fonts === 'string') {
          console.log(
            `attested Lobium ${marker.version} ${marker.platform}: ` +
              `${marker.artifacts.files.length} files, tree ${marker.artifacts.treeSha256}; ` +
              'font-family inventory bound to the packaging scan (font bytes not rescanned)',
          );
        } else {
          console.log(
            `verified Lobium ${marker.version} ${marker.platform}: ` +
              `${marker.artifacts.files.length} files, tree ${marker.artifacts.treeSha256}; no font pack`,
          );
        }
      }
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
