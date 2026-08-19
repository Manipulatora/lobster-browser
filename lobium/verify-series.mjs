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
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir, homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(HERE, 'patches');
// The Windows build host keeps the tree on E: because a Chromium checkout does not fit beside the
// repo; the Linux one keeps it under $HOME. Either way LOBIUM_CHROMIUM_SRC wins.
const SRC =
  process.env.LOBIUM_CHROMIUM_SRC ||
  (process.platform === 'win32' ? 'E:\\lobium-build\\src' : join(homedir(), 'lobium-build', 'src'));
const GIT = process.env.LOBIUM_GIT || 'git';

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

const touched = new Set();
for (const { text } of resolved) {
  for (const m of text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) touched.add(m[1]);
}

const scratch = join(tmpdir(), `lobium-verify-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });

let staged = 0;
for (const f of touched) {
  mkdirSync(join(scratch, dirname(f)), { recursive: true });
  let pristine;
  try {
    pristine = execFileSync(GIT, ['-C', SRC, 'show', `HEAD:${f}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch {
    // A patch that CREATES a file has no pristine blob. Start it empty so the patch can create it.
    pristine = '';
  }
  writeFileSync(join(scratch, f), pristine, 'utf8');
  staged++;
}
console.log(`staged ${staged} pristine file(s) from HEAD`);

const failures = [];
for (const { name, path: p } of resolved) {
  try {
    execFileSync('patch', ['-p1', '-s', '--batch', '--no-backup-if-mismatch', '-d', scratch, '-i', p], {
      encoding: 'utf8',
    });
  } catch (err) {
    failures.push({ name, output: `${err.stdout ?? ''}${err.stderr ?? ''}`.trim() });
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
