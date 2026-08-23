#!/usr/bin/env node
// Create a NEW patch in the series from files currently modified in the Chromium checkout.
//
//   node lobium/make-patch.mjs fingerprint/native-timezone.patch \
//        --preamble lobium/preambles/native-timezone.txt \
//        third_party/blink/renderer/core/timezone/timezone_controller.cc
//
// The companion to regen-patch.mjs, which UPDATES an existing patch. This one authors the first
// version, which is the step that was previously done by hand — and hand-written hunk headers are
// exactly what the CI gate keeps catching, because a miscounted header applies cleanly under some
// patch implementations and rejects under others.
//
// SAFETY. Refuses if any named file is already claimed by a patch in the series: `git diff` returns
// the diff from PRISTINE, so a file with an existing owner would have that owner's hunks silently
// duplicated here, and the second patch to apply would then fail. Use regen-patch.mjs for those.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromiumSrc } from './chromium-src.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(HERE, 'patches');
const SRC = resolveChromiumSrc();
const GIT = process.env.LOBIUM_GIT || 'git';

const argv = process.argv.slice(2);
const flagIndex = argv.indexOf('--preamble');
const preamblePath = flagIndex >= 0 ? argv[flagIndex + 1] : undefined;
const positional = argv.filter((a, i) => !a.startsWith('--') && i !== flagIndex + 1);
const [target, ...files] = positional;

if (!target || files.length === 0 || !preamblePath) {
  console.error(
    'usage: node lobium/make-patch.mjs <patch/path.patch> --preamble <file> <src-file>...',
  );
  process.exit(2);
}

// --- ownership check ---------------------------------------------------------------------------
const series = readFileSync(join(PATCHES, 'series'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

const claimed = new Map();
for (const name of series) {
  const p = join(PATCHES, name.split('/').join('\\'));
  if (!existsSync(p)) continue;
  for (const m of readFileSync(p, 'utf8').matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) {
    if (!claimed.has(m[1])) claimed.set(m[1], []);
    claimed.get(m[1]).push(name);
  }
}
for (const f of files) {
  const owners = (claimed.get(f) ?? []).filter((o) => o !== target);
  if (owners.length) {
    console.error(
      `refusing: ${f} is already carried by ${owners.join(', ')}.\n` +
        '  git diff would duplicate those hunks here and the series would stop applying.\n' +
        '  Use regen-patch.mjs, or give the new concern its own file.',
    );
    process.exit(1);
  }
}

// --- generate ------------------------------------------------------------------------------------
const diff = execFileSync(
  GIT,
  ['-C', SRC, 'diff', '--no-color', '--no-ext-diff', '-U3', '--', ...files],
  { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
);
if (!diff.trim()) {
  console.error(`refusing: no changes in ${files.join(', ')} — nothing to capture`);
  process.exit(1);
}

// Drop `index <sha>..<sha>` lines. They pin blob hashes of one particular checkout, so they go stale
// on every rebase and make patches noisy to review without affecting how they apply.
const body = diff
  .split('\n')
  .filter((l) => !/^index [0-9a-f]{7,}\.\.[0-9a-f]{7,}/.test(l))
  .join('\n');

// Strip a leading BOM and normalise CRLF. Both come free from PowerShell redirection on the Windows
// build host, and both make the resulting patch fail the series gate — a BOM outright, and CRLF by
// being rejected by `git apply` even though GNU patch accepts it.
const preamble = readFileSync(preamblePath, 'utf8')
  .replace(/^﻿/, '')
  .replace(/\r\n/g, '\n')
  .replace(/\s*$/, '');
const out = `${preamble}\n\n${body.replace(/\r\n/g, '\n').replace(/\n*$/, '\n')}`;

const patchPath = join(PATCHES, target.split('/').join('\\'));
mkdirSync(dirname(patchPath), { recursive: true });
writeFileSync(patchPath, out, 'utf8');
console.log(`wrote ${target} (${files.length} file(s), ${out.split('\n').length} lines)`);
console.log('remember to add it to lobium/patches/series');
