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
  const result = { out: undefined, roots: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--out') result.out = argv[++index];
    else if (arg === '--source-root') result.roots.push(argv[++index]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!result.out) throw new Error('usage: provision-open-fonts.mjs --out DIR [--source-root DIR]');
  return result;
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

async function scannedFamilies(path) {
  try {
    const { stdout } = await execFileAsync('fc-scan', ['--format', '%{family}\\n', path], {
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
      `fc-scan is required to verify physical font family names (${path}): ${error.message}`,
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
      const physicalFamilies = await scannedFamilies(path);
      if (!physicalFamilies.has(source.family)) {
        throw new Error(
          `${path} matched ${source.family} metadata but fc-scan reported: ${[...physicalFamilies].join(', ')}`,
        );
      }
      const bytes = await readFile(path);
      matched.push({
        source,
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
    const dedupe = `${item.source.family}\0${item.sha256}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    const filename = `${item.sha256.slice(0, 16)}-${basename(item.path)}`;
    const relativePath = `files/${filename}`;
    await copyFile(item.path, join(out, relativePath));
    files.push({
      path: relativePath,
      sha256: item.sha256,
      families: [item.source.family],
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
  const coveragePhysical = personaFamilies(families, requiredCoverageFamilies);
  const missingCoverage = requiredCoverageFamilies.filter(
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
  const licenses = metadata.families
    .filter((source) => families.includes(source.family))
    .map(({ family, license, licenseUrl }) => ({ family, license, licenseUrl }))
    .sort((a, b) => a.family.localeCompare(b.family, 'en'));
  const contentIdentity = createHash('sha256')
    .update(files.map((file) => `${file.sha256}:${file.families.join(',')}`).join('\n'))
    .digest('hex');
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

main().catch((error) => {
  process.stderr.write(`error: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
