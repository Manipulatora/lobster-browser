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
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');

const EXTENSIONS = new Set([
  '.json',
  '.mjs',
  '.js',
  '.cjs',
  '.ts',
  '.tsx',
  '.md',
  '.gn',
  '.toml',
  '.patch',
  '.txt',
  '.yml',
  '.yaml',
  '.html',
  '.css',
  '.rs',
  '.sh',
  '.ps1',
]);

// These are the byte-patterns produced when valid UTF-8 punctuation is decoded as Windows-1252
// and then saved as UTF-8. They are not stylistic oddities: they are irreversible corruption once
// they reach user-facing logs or a patch preamble, and this Windows-hosted repository has carried
// both single- and double-encoded forms before.
const MOJIBAKE_FRAGMENTS = [
  '\u00e2\u20ac\u201d', // em dash
  '\u00e2\u20ac\u00a2', // bullet
  '\u00e2\u2020\u2019', // right arrow
  '\u00e2\u20ac\u00a6', // ellipsis
  '\u00c2\u00b7', // middle dot
  '\u00c3\u00a2\u00e2\u201a\u00ac\u00e2\u20ac\u009d', // double-encoded em dash
  '\ufffd', // Unicode replacement character: decoding already discarded a byte
];

function trackedSourceFiles() {
  return execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], {
    cwd: ROOT,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((rel) => {
      const name = rel.slice(rel.lastIndexOf('/') + 1);
      const dot = name.lastIndexOf('.');
      return dot > 0 && EXTENSIONS.has(name.slice(dot));
    })
    .map((rel) => join(ROOT, rel));
}

const TRACKED_SOURCE = trackedSourceFiles();

test('no tracked source file starts with a UTF-8 BOM', () => {
  const offenders = [];
  for (const path of TRACKED_SOURCE) {
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
      '`-Encoding utf8` adds one',
  );
});

test('tracked source contains no known UTF-8/Windows-1252 mojibake', () => {
  const offenders = [];
  for (const path of TRACKED_SOURCE) {
    const text = readFileSync(path, 'utf8');
    const fragment = MOJIBAKE_FRAGMENTS.find((candidate) => text.includes(candidate));
    if (fragment) {
      offenders.push(`${relative(ROOT, path).split('\\').join('/')} (${JSON.stringify(fragment)})`);
    }
  }
  assert.deepEqual(
    offenders,
    [],
    'mojibake found; restore the intended Unicode character instead of preserving the bad bytes',
  );
});

test('production tooling contains no developer-specific checkout or report path', () => {
  const forbidden = [
    /[A-Za-z]:[\\/]+lobium-build[\\/]+src/i,
    /\/home\/ivyhfx\//,
    /\/tmp\/claude-[^/]*\//,
  ];
  const offenders = [];
  for (const path of TRACKED_SOURCE) {
    const rel = relative(ROOT, path).split('\\').join('/');
    if (rel.startsWith('docs/')) continue;
    const text = readFileSync(path, 'utf8');
    const pattern = forbidden.find((candidate) => candidate.test(text));
    if (pattern) offenders.push(`${rel} (${pattern})`);
  }
  assert.deepEqual(
    offenders,
    [],
    'build and validation tools must resolve host paths from environment/configuration, not a developer account or drive',
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
  for (const path of TRACKED_SOURCE) {
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
