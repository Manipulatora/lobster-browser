#!/usr/bin/env node
// Prove the patch series reproduces the working checkout, file for file.
//
//   node lobium/verify-series.mjs
//
// The series is how the engine is REPRODUCED. Everything else in CI checks that the patches are well
// formed; nothing checked that applying them yields the binary that was actually tested. A hook
// present in the checkout but missing from its patch means the next clean build silently ships
// without it — and, worse, still reports it in the capability manifest, because that lives in the
// staged module rather than in a patch. The sidecar would then launch profiles trusting spoofing
// that is not there.
//
// Replays the whole series into a scratch tree built from pristine git blobs and diffs the result
// against the checkout. Read-only with respect to the checkout: nothing here can damage a build
// tree, which is why it is safe to run before an expensive link.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync, readdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveChromiumSrc } from './chromium-src.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(HERE, 'patches');
const SRC = resolveChromiumSrc();
const GIT = process.env.LOBIUM_GIT || 'git';
const GIT_FOR_WINDOWS_PATCH = 'C:\\Program Files\\Git\\usr\\bin\\patch.exe';
const PATCH =
  process.env.LOBIUM_PATCH ||
  (process.platform === 'win32' && existsSync(GIT_FOR_WINDOWS_PATCH)
    ? GIT_FOR_WINDOWS_PATCH
    : 'patch');

const buildScript = readFileSync(join(HERE, 'build.sh'), 'utf8');
const pinMatch = /CHROMIUM_REF="\$\{CHROMIUM_REF:-([0-9.]+)\}"/.exec(buildScript);
if (!pinMatch) {
  console.error('could not read the pinned CHROMIUM_REF from lobium/build.sh');
  process.exit(2);
}
const PINNED_REF = pinMatch[1];

function git(args, options = {}) {
  return execFileSync(GIT, ['-C', SRC, ...args], {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  });
}

let headCommit;
let pinnedCommit;
try {
  headCommit = git(['rev-parse', '--verify', 'HEAD']).trim();
  pinnedCommit = git(['rev-parse', '--verify', `refs/tags/${PINNED_REF}^{commit}`]).trim();
} catch (err) {
  console.error(
    `cannot resolve HEAD and pinned Chromium tag ${PINNED_REF} in ${SRC}:\n${`${err.stderr ?? err.message ?? err}`.trim()}`,
  );
  process.exit(2);
}
if (headCommit !== pinnedCommit) {
  console.error(
    `Chromium checkout HEAD is ${headCommit}, but Lobium is pinned to ${PINNED_REF} (${pinnedCommit}).`,
  );
  console.error(
    'Sync the checkout to the pinned tag before replaying or building the patch series.',
  );
  process.exit(2);
}
console.log(
  `verified Chromium checkout at pinned tag ${PINNED_REF} (${pinnedCommit.slice(0, 12)})`,
);

const series = readFileSync(join(PATCHES, 'series'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const resolved = [];
for (const name of series) {
  // series entries are always '/'-separated; split them so join() applies the host separator
  // instead of baking one filename that contains a slash.
  const p = join(PATCHES, ...name.split('/'));
  if (!existsSync(p)) {
    console.error(`no such patch: ${name}`);
    process.exit(2);
  }
  resolved.push({ name, path: p, text: readFileSync(p, 'utf8') });
}

function touchedPaths(text) {
  return [...text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)].map((m) => m[1]);
}

const touched = new Set();
for (const { text } of resolved) {
  for (const path of touchedPaths(text)) touched.add(path);
}

function walkPatchFiles(dir, rel = '') {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) return walkPatchFiles(join(dir, entry.name), childRel);
    return entry.isFile() && entry.name.endsWith('.patch') ? [childRel] : [];
  });
}

const activeNames = new Set(series);
const inactiveOwners = new Map();
for (const name of walkPatchFiles(PATCHES)) {
  if (activeNames.has(name)) continue;
  const text = readFileSync(join(PATCHES, ...name.split('/')), 'utf8');
  for (const path of touchedPaths(text)) {
    if (!inactiveOwners.has(path)) inactiveOwners.set(path, []);
    inactiveOwners.get(path).push(name);
  }
}

const scratch = join(tmpdir(), `lobium-verify-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });

let staged = 0;
for (const f of touched) {
  mkdirSync(join(scratch, dirname(f)), { recursive: true });
  let pristine;
  try {
    pristine = git(['show', `${pinnedCommit}:${f}`]);
  } catch {
    // A patch that CREATES a file has no pristine blob. Start it empty so the patch can create it.
    pristine = '';
  }
  writeFileSync(join(scratch, f), pristine, 'utf8');
  staged++;
}
console.log(`staged ${staged} pristine file(s) from ${PINNED_REF}`);

const failures = [];
for (const { name, path: p } of resolved) {
  try {
    execFileSync(
      PATCH,
      ['-p1', '-s', '--batch', '--no-backup-if-mismatch', '-d', scratch, '-i', p],
      {
        encoding: 'utf8',
      },
    );
  } catch (err) {
    failures.push({
      name,
      output: `${err.stdout ?? ''}${err.stderr ?? ''}${err.message ?? ''}`.trim(),
    });
  }
}

if (failures.length) {
  console.error(`\n${failures.length} patch(es) FAILED to apply to a pristine tree:\n`);
  for (const f of failures) console.error(`  ${f.name}\n${f.output.replace(/^/gm, '      ')}\n`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(1);
}
console.log(`applied ${resolved.length} patch(es) cleanly`);

const drift = [];
for (const f of touched) {
  const replayed = readFileSync(join(scratch, f), 'utf8');
  let actual;
  try {
    actual = readFileSync(join(SRC, f), 'utf8');
  } catch {
    drift.push({ file: f, why: 'present in the series but missing from the checkout' });
    continue;
  }
  // Compare with line endings normalised. Git may check a file out with CRLF depending on
  // core.autocrlf, and a line-ending difference is not a difference in what gets compiled.
  if (replayed.replace(/\r\n/g, '\n') !== actual.replace(/\r\n/g, '\n')) {
    drift.push({ file: f, why: 'the series output differs from the checkout' });
  }
}

// Added first-party files are copied into Chromium before the series is applied. They are part of
// the build footprint even though no patch owns them, so compare each staged copy byte-for-byte.
// This catches the easy-to-miss case where the source module changed after it was staged.
const stagedCopies = new Map();
for (const entry of readdirSync(join(HERE, 'src'), { withFileTypes: true })) {
  if (entry.isFile()) {
    stagedCopies.set(`components/lobium_fp/${entry.name}`, join(HERE, 'src', entry.name));
  }
}
for (const name of [
  'lobium_master.png',
  'lobster_ad.png',
  'lobster_wordmark.png',
  'lobster_wordmark_horizontal.png',
]) {
  stagedCopies.set(
    `chrome/browser/resources/new_tab_page/icons/${name}`,
    join(HERE, 'assets', 'ntp-icons', name),
  );
}
for (const [destination, source] of stagedCopies) {
  if (!existsSync(source)) {
    drift.push({ file: destination, why: `staging source is missing: ${source}` });
    continue;
  }
  const actual = join(SRC, ...destination.split('/'));
  if (!existsSync(actual)) {
    drift.push({ file: destination, why: 'required staged copy is missing from the checkout' });
    continue;
  }
  if (!readFileSync(source).equals(readFileSync(actual))) {
    drift.push({ file: destination, why: 'staged copy differs from its Lobium source' });
  }
}

// The active series plus the explicit staging map is the complete expected build footprint. A
// patch removed from `series` must not leave its old hunks or new files behind, and reject artifacts
// must never be mistaken for a reproducible checkout.
function nulSeparatedGitPaths(args) {
  const output = git(args, { encoding: 'buffer' });
  return output.toString('utf8').split('\0').filter(Boolean);
}
const changedPaths = new Set([
  ...nulSeparatedGitPaths(['diff', '--name-only', '-z', '--']),
  ...nulSeparatedGitPaths(['diff', '--cached', '--name-only', '-z', '--']),
  ...nulSeparatedGitPaths(['ls-files', '--others', '--exclude-standard', '-z']),
]);
for (const path of changedPaths) {
  if (touched.has(path) || stagedCopies.has(path)) continue;
  const inactive = inactiveOwners.get(path);
  drift.push({
    file: path,
    why: inactive
      ? `changed only by patch(es) absent from series: ${inactive.join(', ')}`
      : 'unexpected changed/untracked path outside the active series and staging map',
  });
}
rmSync(scratch, { recursive: true, force: true });

if (drift.length) {
  console.error(`\nDRIFT in ${drift.length} file(s) — the series does NOT reproduce this build:\n`);
  for (const d of drift) console.error(`  ${d.file}\n      ${d.why}`);
  console.error(
    '\nFor a file carried by ONE patch: node lobium/regen-patch.mjs <patch>' +
      '\nFor a file shared by several: node lobium/chain-delta.mjs <file> <patch>... --emit ...',
  );
  process.exit(1);
}

console.log(`\nOK: the series reproduces all ${touched.size} patched files exactly.`);
