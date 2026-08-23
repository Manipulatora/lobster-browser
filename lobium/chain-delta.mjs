#!/usr/bin/env node
// Compute the delta between "the series as written" and "the checkout as it is", for ONE file that
// several patches share.
//
//   node lobium/chain-delta.mjs <src-file> <patch> [<patch>...]
//   node lobium/chain-delta.mjs --emit <out.patch> --preamble <file> <src-file> <patch>...
//
// WHY THIS EXISTS. regen-patch.mjs refuses a file carried by more than one patch, because `git diff`
// gives the diff from PRISTINE and would fold every patch's hunks into whichever one was
// regenerated. That refusal is correct, but it leaves no way to fold a NEW edit back into a chained
// file — and hand-editing hunk headers is exactly what the series gate keeps catching.
//
// So: replay the chain in a scratch directory to reconstruct what the series produces, diff that
// against the real checkout, and emit the difference as its own patch. Nothing is hand-counted, the
// existing patches are left byte-identical, and the result is verifiable — applying the chain plus
// the emitted delta must reproduce the checkout exactly, which this checks before writing anything.
import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolveChromiumSrc } from './chromium-src.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(HERE, 'patches');
const SRC = resolveChromiumSrc();
const GIT = process.env.LOBIUM_GIT || 'git';

const argv = process.argv.slice(2);
const take = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
};
const emitTo = take('--emit');
const preamblePath = take('--preamble');
const [file, ...patchNames] = argv.filter((a) => !a.startsWith('--'));

if (!file || patchNames.length === 0) {
  console.error(
    'usage: node lobium/chain-delta.mjs [--emit out.patch --preamble f] <src-file> <patch>...',
  );
  process.exit(2);
}

const scratch = join(tmpdir(), `lobium-chain-${process.pid}`);
rmSync(scratch, { recursive: true, force: true });

const resolved = patchNames.map((name) => {
  const p = join(PATCHES, name.split('/').join('\\'));
  if (!existsSync(p)) {
    console.error(`no such patch: ${p}`);
    process.exit(2);
  }
  return { name, path: p, text: readFileSync(p, 'utf8') };
});

// Materialize EVERY file the chain touches, not just the one being analysed. The patches in a chain
// are usually multi-file (screen-dpr also carries screen.cc and local_dom_window.cc), and `patch`
// stops to ask "File to patch:" for anything missing — which reads EOF here and silently skips the
// rest of that patch, producing a replay that looks like a mismatch in the file under study.
const touched = new Set([file]);
for (const { text } of resolved) {
  for (const m of text.matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) touched.add(m[1]);
}
for (const f of touched) {
  mkdirSync(join(scratch, dirname(f)), { recursive: true });
  writeFileSync(
    join(scratch, f),
    // Pristine content straight out of git, so the replay starts where a fresh checkout would.
    execFileSync(GIT, ['-C', SRC, 'show', `HEAD:${f}`], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    }),
    'utf8',
  );
}

for (const { name, path: p } of resolved) {
  try {
    // --batch: never prompt. A prompt here would read EOF and be treated as "skip", turning a real
    // apply failure into a silently wrong replay.
    execFileSync(
      'patch',
      ['-p1', '-s', '--batch', '--no-backup-if-mismatch', '-d', scratch, '-i', p],
      {
        encoding: 'utf8',
      },
    );
  } catch (err) {
    console.error(`chain replay FAILED at ${name}:\n${err.stdout || ''}${err.stderr || ''}`);
    console.error(
      '\nThe series does not apply to a pristine tree in this order. Fix that before folding in\n' +
        'any new edit — a delta cut against a broken chain is meaningless.',
    );
    process.exit(1);
  }
}

const replayed = readFileSync(join(scratch, file), 'utf8');
const actual = readFileSync(join(SRC, file), 'utf8');

if (replayed === actual) {
  console.log(`${file}: the chain already reproduces the checkout exactly — no delta to emit.`);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

// Diff replayed -> actual. --no-index works outside a repo and gives a normal unified diff; the
// a/ and b/ paths are rewritten to the real source path so the result applies with -p1 like every
// other patch in the series.
let diff = '';
try {
  execFileSync(
    GIT,
    ['diff', '--no-index', '--no-color', '-U3', '--', join(scratch, file), join(SRC, file)],
    {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    },
  );
} catch (err) {
  // git diff --no-index exits 1 when the files differ, which is the expected case here.
  diff = err.stdout ?? '';
}
if (!diff.trim()) {
  console.error('files differ but git produced no diff — refusing to emit an empty patch');
  process.exit(1);
}

const posix = file.split('\\').join('/');
const body = diff
  .split('\n')
  .filter((l) => !/^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/.test(l))
  .map((l) => {
    if (l.startsWith('diff --git ')) return `diff --git a/${posix} b/${posix}`;
    if (l.startsWith('--- ')) return `--- a/${posix}`;
    if (l.startsWith('+++ ')) return `+++ b/${posix}`;
    return l;
  })
  .join('\n');

const hunks = (body.match(/^@@ /gm) || []).length;
console.log(`${file}: chain output differs from the checkout in ${hunks} hunk(s).`);

if (!emitTo) {
  console.log('\n' + body);
  rmSync(scratch, { recursive: true, force: true });
  process.exit(0);
}

if (!preamblePath) {
  console.error('--emit requires --preamble');
  process.exit(2);
}
const preamble = readFileSync(preamblePath, 'utf8')
  .replace(/^\uFEFF/, '')
  .replace(/\r\n/g, '\n')
  .replace(/\s*$/, '');

const out = `${preamble}\n\n${body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`;
const outPath = join(PATCHES, emitTo.split('/').join('\\'));
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, out, 'utf8');

// Verify: chain + delta must reproduce the checkout byte for byte. Emitting first and checking after
// is deliberate — the check runs against the file that was actually written, not against an
// in-memory string that might differ from it.
execFileSync(
  'patch',
  ['-p1', '-s', '--batch', '--no-backup-if-mismatch', '-d', scratch, '-i', outPath],
  {
    encoding: 'utf8',
  },
);
const verified = readFileSync(join(scratch, file), 'utf8');
rmSync(scratch, { recursive: true, force: true });
if (verified !== actual) {
  console.error(`VERIFICATION FAILED: chain + ${emitTo} does not reproduce ${file}`);
  process.exit(1);
}
console.log(`wrote ${emitTo} (${hunks} hunk(s)) — verified: chain + delta reproduces the checkout`);
console.log('remember to add it to lobium/patches/series, AFTER the patches it was cut against');
