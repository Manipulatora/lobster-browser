#!/usr/bin/env node
// Report which patch in the series owns each file, and which tree files no patch claims.
//
//   node lobium/patch-owners.mjs                  # full ownership table
//   node lobium/patch-owners.mjs --dirty          # only files modified in the checkout
//
// WHY. Regenerating a patch with `git diff` is only correct when that patch is the SOLE writer of
// the file — otherwise the diff absorbs every other patch's hunks and the series stops applying.
// Before touching any patch, this answers the question that decides the method: sole owner (regen),
// shared (hand-edit the specific hunks), or unclaimed (a new patch is needed).
import { readFileSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveChromiumSrc } from './chromium-src.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PATCHES = join(HERE, 'patches');
const SRC = resolveChromiumSrc();

const series = readFileSync(join(PATCHES, 'series'), 'utf8')
  .split('\n')
  .map((l) => l.trim())
  .filter((l) => l && !l.startsWith('#'));

/** file path -> [patch names] */
const owners = new Map();
for (const name of series) {
  const p = join(PATCHES, name.split('/').join('\\'));
  if (!existsSync(p)) continue;
  for (const m of readFileSync(p, 'utf8').matchAll(/^diff --git a\/(\S+) b\/\S+$/gm)) {
    const file = m[1];
    if (!owners.has(file)) owners.set(file, []);
    owners.get(file).push(name);
  }
}

const dirtyOnly = process.argv.includes('--dirty');
const dirty = new Set(
  execFileSync('git', ['-C', SRC, 'status', '--porcelain', '--untracked-files=no'], {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
  })
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter(Boolean),
);

const rows = [];
for (const file of dirtyOnly ? dirty : new Set([...owners.keys(), ...dirty])) {
  const list = owners.get(file) ?? [];
  rows.push({
    file,
    n: list.length,
    kind: list.length === 0 ? 'UNCLAIMED' : list.length === 1 ? 'sole' : 'SHARED',
    patches: list,
  });
}
rows.sort((a, b) => a.kind.localeCompare(b.kind) || a.file.localeCompare(b.file));

for (const r of rows) {
  console.log(`${r.kind.padEnd(9)} ${r.file}`);
  for (const p of r.patches) console.log(`          ${p}`);
}
console.log(
  `\n${rows.filter((r) => r.kind === 'sole').length} sole, ` +
    `${rows.filter((r) => r.kind === 'SHARED').length} shared, ` +
    `${rows.filter((r) => r.kind === 'UNCLAIMED').length} unclaimed`,
);
