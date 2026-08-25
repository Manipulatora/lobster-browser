#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const metadataPath = join(ROOT, 'lobium', 'fonts', 'sources.json');
const catalogPath = join(ROOT, 'packages', 'fingerprint', 'src', 'catalog.generated.ts');

function parseArgs(argv) {
  const result = { out: undefined, roots: [], scanner: 'fc-scan' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') result.out = argv[++index];
    else if (arg === '--source-root') result.roots.push(argv[++index]);
    else if (arg === '--fc-scan') result.scanner = argv[++index];
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.out || !result.scanner) {
    throw new Error(
      'usage: provision-open-fonts.mjs --out DIR [--source-root DIR] [--fc-scan EXECUTABLE]',
    );
  }
  return result;
}

const compareNames = (a, b) => a.localeCompare(b, 'en');

/** The complete, explicitly approved family inventory a source file is allowed to expose. */
export function declaredSourceFamilies(source) {
  if (!source || typeof source !== 'object' || Array.isArray(source)) {
    throw new Error('font source entry is not an object');
  }
  if (typeof source.family !== 'string' || !source.family.trim()) {
    throw new Error('font source entry has no primary family');
  }
  const companions = source.companionFamilies ?? [];
  if (
    !Array.isArray(companions) ||
    companions.some((family) => typeof family !== 'string' || !family.trim())
  ) {
    throw new Error(`${source.family} has invalid companionFamilies`);
  }
  const families = [source.family, ...companions];
  if (new Set(families).size !== families.length) {
    throw new Error(`${source.family} has duplicate declared family names`);
  }
  const sortedCompanions = [...companions].sort(compareNames);
  if (companions.some((family, index) => family !== sortedCompanions[index])) {
    throw new Error(`${source.family} companionFamilies must be sorted`);
  }
  return families.sort(compareNames);
}

/** Fail closed when font bytes expose a family that the reviewed source metadata did not approve. */
export function assertExactScannedFamilies(path, source, scannedFamilies) {
  const expected = declaredSourceFamilies(source);
  const actual = [...new Set(scannedFamilies)].sort(compareNames);
  const expectedSet = new Set(expected);
  const actualSet = new Set(actual);
  const missing = expected.filter((family) => !actualSet.has(family));
  const undeclared = actual.filter((family) => !expectedSet.has(family));
  if (missing.length || undeclared.length) {
    throw new Error(
      `${path} family inventory differs from ${source.family} metadata ` +
        `(missing: ${missing.join(', ') || 'none'}; undeclared: ${undeclared.join(', ') || 'none'})`,
    );
  }
  return expected;
}

function sourceOwners(metadata) {
  const owners = new Map();
  for (const source of metadata.families) {
    if (
      typeof source.filePattern !== 'string' ||
      !source.filePattern ||
      typeof source.license !== 'string' ||
      !source.license ||
      typeof source.licenseUrl !== 'string' ||
      !source.licenseUrl
    ) {
      throw new Error(`invalid metadata for ${source.family ?? '<unknown family>'}`);
    }
    for (const family of declaredSourceFamilies(source)) {
      if (owners.has(family)) {
        throw new Error(`physical family is owned by multiple source entries: ${family}`);
      }
      owners.set(family, source);
    }
  }
  return owners;
}

/** Build exact one-entry-per-physical-family license coverage. */
export function buildLicenseLedger(metadata, physicalFamilies) {
  const owners = sourceOwners(metadata);
  return [...new Set(physicalFamilies)].sort(compareNames).map((family) => {
    const source = owners.get(family);
    if (!source)
      throw new Error(`physical family has no approved source/license metadata: ${family}`);
    return { family, license: source.license, licenseUrl: source.licenseUrl };
  });
}

/** Content identity binds both bytes and the complete family inventory exposed by those bytes. */
export function fontPackContentIdentity(files) {
  const identity = files.map((file) => [file.sha256, [...file.families].sort(compareNames)]);
  return createHash('sha256').update(JSON.stringify(identity)).digest('hex');
}

async function walk(root) {
  const files = [];
  const visit = async (dir) => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name, 'en'));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (
        entry.isFile() &&
        // Noto's CJK faces are OpenType collections. Excluding .ttc silently removed the only
        // high-quality CJK coverage from the isolated browser pack and produced tofu squares.
        ['.ttf', '.otf', '.ttc'].includes(extname(entry.name).toLowerCase())
      ) {
        files.push(path);
      }
    }
  };
  await visit(root);
  return files;
}

async function scannedFamilies(path, scanner) {
  try {
    const { stdout } = await execFileAsync(scanner, ['--format', '%{family}\\n', path], {
      maxBuffer: 1024 * 1024,
    });
    return new Set(
      stdout
        .split(/\r?\n/)
        .flatMap((line) => line.split(','))
        .map((family) => family.trim())
        .filter(Boolean),
    );
  } catch (error) {
    throw new Error(
      `fc-scan is required to verify physical font family names (${path}, scanner ${scanner}): ${error.message}`,
    );
  }
}

function personaFamilies(allFamilies, preferred) {
  const available = new Set(allFamilies);
  return preferred.filter((family) => available.has(family));
}

function readGeneratedCatalog(source, exportName) {
  const escaped = exportName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(
    `export const ${escaped} = (\\[[\\s\\S]*?\\]) satisfies readonly string\\[\\];`,
  ).exec(source);
  if (!match) throw new Error(`cannot read ${exportName} from ${catalogPath}`);
  const values = JSON.parse(match[1].replace(/,\s*]/g, ']'));
  if (!Array.isArray(values) || values.some((value) => typeof value !== 'string')) {
    throw new Error(`invalid ${exportName} in ${catalogPath}`);
  }
  return [...new Set(values)].sort((a, b) => a.localeCompare(b, 'en'));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const metadata = JSON.parse(await readFile(metadataPath, 'utf8'));
  const generatedCatalog = await readFile(catalogPath, 'utf8');
  if (metadata.version !== 1 || !Array.isArray(metadata.families)) {
    throw new Error(`invalid font source metadata: ${metadataPath}`);
  }
  const owners = sourceOwners(metadata);
  const roots =
    args.roots.length > 0
      ? args.roots.map((root) => resolve(root))
      : ['/usr/share/fonts', '/usr/local/share/fonts'].map((root) => resolve(root));
  const candidates = (await Promise.all(roots.map((root) => walk(root))))
    .flat()
    .sort((a, b) => a.localeCompare(b, 'en'));
  const matched = [];
  for (const source of metadata.families) {
    const pattern = new RegExp(source.filePattern, 'i');
    for (const path of candidates.filter((candidate) => pattern.test(basename(candidate)))) {
      const physicalFamilies = await scannedFamilies(path, args.scanner);
      const families = assertExactScannedFamilies(path, source, physicalFamilies);
      const bytes = await readFile(path);
      matched.push({
        source,
        families,
        path,
        bytes,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
  }
  if (matched.length === 0) {
    throw new Error(`no approved redistributable fonts found under: ${roots.join(', ')}`);
  }
  const out = resolve(args.out);
  await rm(out, { recursive: true, force: true });
  await mkdir(join(out, 'files'), { recursive: true });
  const seen = new Set();
  const files = [];
  for (const item of matched.sort(
    (a, b) =>
      a.source.family.localeCompare(b.source.family, 'en') ||
      basename(a.path).localeCompare(basename(b.path), 'en') ||
      a.sha256.localeCompare(b.sha256, 'en'),
  )) {
    const dedupe = `${item.families.join('\0')}\0${item.sha256}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const filename = `${item.sha256.slice(0, 16)}-${basename(item.path)}`;
    const relativePath = `files/${filename}`;
    await copyFile(item.path, join(out, relativePath));
    files.push({
      path: relativePath,
      sha256: item.sha256,
      families: item.families,
      license: item.source.license,
    });
  }
  const families = [...new Set(files.flatMap((file) => file.families))].sort((a, b) =>
    a.localeCompare(b, 'en'),
  );
  // Font isolation must not mean glyph isolation. These fallback-only open families cover the
  // scripts most commonly encountered on the web while the persona's `families` catalog remains
  // unchanged. They are provisioned for every OS persona so Android/Windows/macOS profiles cannot
  // turn Arabic, CJK, Indic text, mathematical symbols, or emoji into square replacement glyphs.
  const requiredCoverageFamilies = [
    'Noto Color Emoji',
    'Noto Music',
    'Noto Sans Arabic',
    'Noto Sans Armenian',
    'Noto Sans Bengali',
    'Noto Sans CJK JP',
    'Noto Sans Devanagari',
    'Noto Sans Ethiopic',
    'Noto Sans Georgian',
    'Noto Sans Gujarati',
    'Noto Sans Gurmukhi',
    'Noto Sans Hebrew',
    'Noto Sans Kannada',
    'Noto Sans Khmer',
    'Noto Sans Lao',
    'Noto Sans Malayalam',
    'Noto Sans Math',
    'Noto Sans Myanmar',
    'Noto Sans Sinhala',
    'Noto Sans Symbols',
    'Noto Sans Symbols2',
    'Noto Sans Tamil',
    'Noto Sans Telugu',
    'Noto Sans Thai',
    'Noto Serif CJK JP',
  ];
  const requiredCoveragePhysical = requiredCoverageFamilies
    .flatMap((family) => declaredSourceFamilies(owners.get(family) ?? { family }))
    .sort(compareNames);
  const coveragePhysical = personaFamilies(families, requiredCoveragePhysical);
  const missingCoverage = requiredCoveragePhysical.filter(
    (family) => !coveragePhysical.includes(family),
  );
  if (missingCoverage.length) {
    throw new Error(
      `provisioned pack is missing required Unicode fallback families: ${missingCoverage.join(', ')}`,
    );
  }
  const withCoverage = (preferred) => [
    ...new Set([...personaFamilies(families, preferred), ...coveragePhysical]),
  ];
  const windowsPhysical = withCoverage([
    'Carlito',
    'Caladea',
    'Liberation Sans',
    'Liberation Serif',
    'Liberation Mono',
    'Noto Sans',
    'Noto Serif',
    'Noto Sans Mono',
  ]);
  const macosPhysical = withCoverage([
    'Liberation Sans',
    'Liberation Serif',
    'Liberation Mono',
    'Carlito',
    'Caladea',
    'Noto Sans',
    'Noto Serif',
    'Noto Sans Mono',
  ]);
  const androidPhysical = withCoverage([
    'Roboto',
    'Roboto Condensed',
    'Noto Sans',
    'Noto Sans Mono',
    'Noto Serif',
    'Noto Color Emoji',
  ]);
  if (
    !windowsPhysical.length ||
    !macosPhysical.length ||
    !androidPhysical.length ||
    !families.length
  ) {
    throw new Error('provisioned pack cannot supply all desktop personas');
  }
  const windows = readGeneratedCatalog(generatedCatalog, 'WINDOWS_FONT_NAMES');
  const macos = readGeneratedCatalog(generatedCatalog, 'MACOS_FONT_NAMES');
  const linux = readGeneratedCatalog(generatedCatalog, 'LINUX_FONT_NAMES');
  const android = [
    'Droid Sans',
    'Google Sans',
    'Noto Color Emoji',
    'Noto Sans',
    'Noto Sans Mono',
    'Roboto',
    'Roboto Condensed',
    'sans-serif',
  ];
  const licenses = buildLicenseLedger(metadata, families);
  const contentIdentity = fontPackContentIdentity(files);
  const manifest = {
    version: 1,
    packId: `lobster-open-fonts-${contentIdentity.slice(0, 16)}`,
    files,
    personas: {
      windows: { families: windows, physicalFamilies: windowsPhysical },
      macos: { families: macos, physicalFamilies: macosPhysical },
      linux: { families: linux, physicalFamilies: families },
      android: { families: android, physicalFamilies: androidPhysical },
    },
    licenses,
  };
  await writeFile(join(out, 'font-pack.manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, {
    mode: 0o644,
  });
  process.stdout.write(
    `[fonts] ${files.length} files, ${families.length} physical families -> ${out}\n`,
  );
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
