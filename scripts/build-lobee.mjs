#!/usr/bin/env node
// Build the React Lobee extension (packages/lobee-app) and publish it BOTH to packages/lobee — the
// self-contained MV3 bundle the launcher snapshots per profile — and to the desktop app's Tauri
// resource directory, so a packaged build always ships the bundle that matches this source tree.
//
// Staging both places here is what stops the two from drifting. They did: the published bundle sat at
// a build predating thread ids, Stop and New Chat, so the source tests proved nothing about what the
// installed product actually ran.
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(repo, 'packages/lobee-app');

// Resolve vite's real JS entry, not the node_modules/.bin shim. On POSIX that shim is a symlink to the
// script and `node .bin/vite` happens to work; on Windows npm writes a SHELL script there (plus
// vite.cmd / vite.ps1), so handing it to node is a syntax error and the whole extension build dies.
// Workspaces hoist, so check the package root first and fall back to the local install.
const viteEntry = [
  join(repo, 'node_modules/vite/bin/vite.js'),
  join(app, 'node_modules/vite/bin/vite.js'),
].find((candidate) => existsSync(candidate));
if (!viteEntry) {
  console.error('[build-lobee] cannot find vite/bin/vite.js — run npm install first');
  process.exit(1);
}

const r = spawnSync(process.execPath, [viteEntry, 'build'], { cwd: app, stdio: 'inherit' });
if (r.error) {
  console.error(`[build-lobee] cannot run vite: ${r.error.message}`);
  process.exit(1);
}
if (r.status !== 0) process.exit(r.status ?? 1);

const targets = [join(repo, 'packages/lobee'), join(repo, 'apps/desktop/src-tauri/resources/lobee')];
for (const out of targets) {
  rmSync(out, { recursive: true, force: true });
  mkdirSync(dirname(out), { recursive: true });
  cpSync(join(app, 'dist'), out, { recursive: true });
  rmSync(join(out, 'node_modules'), { recursive: true, force: true });
  console.log('[build-lobee] published →', out);
}

// ANTI-DETECT INVARIANT (P0). Lobee's extension id is a fixed public constant, so a single
// `web_accessible_resources` or `externally_connectable` match would turn `chrome-extension://<id>/…`
// into a universal fingerprinting probe usable by any page. This guard used to live only in the Linux
// product script, which meant an ordinary `tauri build` could ship a violating manifest; it belongs
// wherever the bundle is produced.
const manifestPath = join(targets[0], 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const forbidden = ['web_accessible_resources', 'externally_connectable'].filter((k) => k in manifest);
if (forbidden.length > 0) {
  console.error(
    `[build-lobee] FATAL: manifest must not declare ${forbidden.join(', ')} — Lobee's id is public, ` +
      'so either key makes the extension detectable from any page.',
  );
  process.exit(1);
}
console.log('[build-lobee] anti-detect manifest guard: OK (no WAR / externally_connectable)');
