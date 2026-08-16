#!/usr/bin/env node
// Regenerate one patch in the series from the current state of the Chromium checkout.
//
//   node lobium/regen-patch.mjs fingerprint/canvas-farbling.patch
//   node lobium/regen-patch.mjs --check fingerprint/canvas-farbling.patch   (report, write nothing)
//
// WORKFLOW. Apply the whole series (lobium/build.ps1 -Run -Stop patch), edit the hooked file in the
// checkout with a normal editor, then run this to fold the edit back into the patch. That is far
// safer than hand-editing hunk headers, which silently produces line counts that no longer match
// the body.
//
// SAFETY. `git diff` on a file gives the diff from PRISTINE, which is only this patch's content if
// no OTHER patch also touches that file. So the script refuses to regenerate a patch that shares a
// file with another patch in the series - regenerating one of those would silently absorb the
// other's hunks and then the second patch would fail to apply. If you hit that refusal, the fix is
// to give the concern its own patch (see the decomposition note at the top of patches/series).
//
// The human-written preamble above the first `diff --git` is preserved byte for byte.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(HERE, 'patches');
const SRC = process.env.LOBIUM_CHROMIUM_SRC || process.env.CHROMIUM_SRC || 'E:\\lobium-build\\src';
const GIT = process.env.LOBIUM_GIT || 'git';

const argv = process.argv.slice(2);
const check = argv.includes('--check');
const target = argv.find((a) => !a.startsWith('--'));
if (!target) {
  console.error('usage: node lobium/regen-patch.mjs [--check] <patch/path.patch>');
  process.exit(2);
}

const patchPath = join(PATCHES, target.split('/').join('\\'));
if (!existsSync(patchPath)) {
  console.error(`no such patch: ${patchPath}`);
  process.exit(2);
}
if (!existsSync(join(SRC, '.gn'))) {
  console.error(`not a Chromium checkout: ${SRC} (set LOBIUM_CHROMIUM_SRC)`);
  process.exit(2);
}

/** Files a patch touches, in the order it lists them. */
function filesOf(p) {
  return readFileSync(p, 'utf8')
    .split('\n')
    .filter((l) => l.startsWith('+++ b/'))
    .map((l) => l.slice(6).split('\t')[0].trim());
}

const series = readFileSync(join(PATCHES, 'series'), 'utf8')
  .split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));

// --- exclusivity check ---------------------------------------------------------------------------
const owners = new Map();
for (const rel of series) {
  for (const f of filesOf(join(PATCHES, rel.split('/').join('\\')))) {
    if (!owners.has(f)) owners.set(f, []);
    owners.get(f).push(rel);
  }
}
const mine = filesOf(patchPath);
const shared = mine.filter((f) => owners.get(f)?.length > 1);
if (shared.length) {
  console.error(`REFUSING to regenerate ${target}: it shares files with other patches, so a`);
  console.error('`git diff` of those files would absorb their hunks too.\n');
  for (const f of shared) console.error(`  ${f}\n      also in: ${owners.get(f).filter((p) => p !== target).join(', ')}`);
  console.error('\nSplit the concern into its own patch first (see patches/series).');
  process.exit(1);
}

// --- regenerate -----------------------------------------------------------------------------------
const original = readFileSync(patchPath, 'utf8');
const firstDiff = original.indexOf('\ndiff --git ');
const preamble = firstDiff === -1 ? '' : original.slice(0, firstDiff + 1);

let diff;
try {
  diff = execFileSync(GIT, ['--no-optional-locks', 'diff', '--', ...mine], {
    cwd: SRC, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024,
  });
} catch (err) {
  console.error(`git diff failed: ${err.message}`);
  process.exit(1);
}

if (!diff.trim()) {
  console.error(`git diff is EMPTY for ${target}. Is the series applied? (lobium/build.ps1 -Run -Stop patch)`);
  process.exit(1);
}

const next = (preamble + diff).replace(/\r\n/g, '\n');

// Report what changed, so a regeneration is never a silent rewrite.
const oldAdds = (original.match(/^\+(?!\+\+)/gm) || []).length;
const newAdds = (next.match(/^\+(?!\+\+)/gm) || []).length;
const oldHunks = (original.match(/^@@ /gm) || []).length;
const newHunks = (next.match(/^@@ /gm) || []).length;
console.log(`${target}`);
console.log(`  files      ${mine.length}  (${mine.join(', ')})`);
console.log(`  hunks      ${oldHunks} -> ${newHunks}`);
console.log(`  added lines${String(oldAdds).padStart(5)} ->${String(newAdds).padStart(5)}`);
console.log(`  bytes      ${original.length} -> ${next.length}`);

// eslint-disable-next-line no-control-regex
const nonAscii = next.slice(preamble.length).split('\n')
  .filter((l) => l.startsWith('+') && !l.startsWith('+++') && /[^\x00-\x7F]/.test(l));
if (nonAscii.length) {
  console.error(`\n  ${nonAscii.length} added line(s) contain non-ASCII; ci/validation/patch-series.test.mjs will fail:`);
  for (const l of nonAscii.slice(0, 5)) console.error(`    ${l.slice(0, 100)}`);
}

if (check) {
  console.log('\n--check: nothing written');
} else {
  writeFileSync(patchPath, next, 'utf8');
  console.log('\n  written (LF, UTF-8, preamble preserved)');
}
