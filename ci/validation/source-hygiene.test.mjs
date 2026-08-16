// Source-hygiene gate: no UTF-8 BOM in tracked source.
//
// WHY THIS EXISTS. A BOM is invisible in every editor and breaks things far from where it was
// introduced. It has now cost this repo twice:
//
//   - patch files: GNU patch accepted them, `git apply` rejected them, so half the tooling silently
//     could not use the series. (patch-series.test.mjs covers that case.)
//   - package.json: JSON.parse throws on the leading U+FEFF, and the failure surfaced as
//     "Failed to load PostCSS config" during a Vite build of an unrelated package — because PostCSS
//     walks up looking for config and hits the root package.json. Nothing in the message named the
//     real file or the real cause.
//
// Both were written by PowerShell. `Set-Content -Encoding utf8` and `Out-File -Encoding utf8` emit a
// BOM in Windows PowerShell 5.1, which is the default shell on the Windows build host, so this is not
// a one-off mistake but a standing hazard of the platform. Use
// `[System.IO.File]::WriteAllText($path, $text, (New-Object System.Text.UTF8Encoding($false)))`, or
// write the file from Node.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const SKIP_DIRS = new Set([
  'node_modules',
  'target',
  'dist',
  '.git',
  '.tools',
  'reports',
  'out',
  // Third-party font binaries and their sidecars; not our source and not parsed as text by us.
  'fonts',
]);

const EXTENSIONS = new Set(['.json', '.mjs', '.js', '.cjs', '.ts', '.tsx', '.md', '.gn', '.toml']);

function walk(dir, acc = []) {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    let info;
    try {
      info = statSync(path);
    } catch {
      continue; // a symlink into a pruned tree, or a file that vanished mid-walk
    }
    if (info.isDirectory()) {
      if (!SKIP_DIRS.has(name)) walk(path, acc);
      continue;
    }
    const dot = name.lastIndexOf('.');
    if (dot > 0 && EXTENSIONS.has(name.slice(dot))) acc.push(path);
  }
  return acc;
}

test('no tracked source file starts with a UTF-8 BOM', () => {
  const offenders = [];
  for (const path of walk(ROOT)) {
    // Read as latin1 so the first byte is inspectable as a byte rather than being consumed by the
    // UTF-8 decoder, which silently strips a BOM and would make this test always pass.
    const head = readFileSync(path, 'latin1').slice(0, 3);
    if (head.charCodeAt(0) === 0xef && head.charCodeAt(1) === 0xbb && head.charCodeAt(2) === 0xbf) {
      offenders.push(relative(ROOT, path).split('\\').join('/'));
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'UTF-8 BOM found. Rewrite with [System.IO.File]::WriteAllText(path, text, ' +
      '(New-Object System.Text.UTF8Encoding($false))) or from Node — PowerShell 5.1 ' +
      "`-Encoding utf8` adds one",
  );
});

/**
 * JSONC by convention, and legitimately so: TypeScript and VS Code both document comment support in
 * these, and the toolchain that reads them is comment-aware. Applying strict JSON.parse to them would
 * report a defect where there is none, and a gate that cries wolf gets switched off.
 */
function isJsonc(rel) {
  return /(^|\/)\.vscode\//.test(rel) || /(^|\/)tsconfig[^/]*\.json$/.test(rel);
}

test('every strict-JSON file actually parses', () => {
  // A BOM is only the failure mode that bit us. Any malformed JSON in a config the build reads is the
  // same class of defect: discovered late, in a message that names something else — the BOM in
  // package.json surfaced as a PostCSS config error in a different package.
  const bad = [];
  for (const path of walk(ROOT)) {
    if (!path.endsWith('.json')) continue;
    const rel = relative(ROOT, path).split('\\').join('/');
    if (isJsonc(rel)) continue;
    try {
      JSON.parse(readFileSync(path, 'utf8'));
    } catch (err) {
      bad.push(`${rel}: ${err.message}`);
    }
  }
  assert.deepEqual(bad, [], 'malformed JSON');
});
