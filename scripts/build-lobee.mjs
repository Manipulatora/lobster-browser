#!/usr/bin/env node
// Build the React Lobee extension (packages/lobee-app) and publish it BOTH to packages/lobee — the
// self-contained MV3 bundle the launcher snapshots per profile — and to the desktop app's Tauri
// resource directory, so a packaged build always ships the bundle that matches this source tree.
//
// Staging both places here is what stops the two from drifting. They did: the published bundle sat at
// a build predating thread ids, Stop and New Chat, so the source tests proved nothing about what the
// installed product actually ran.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(repo, 'packages/lobee-app');

const r = spawnSync('node', ['node_modules/.bin/vite', 'build'], { cwd: app, stdio: 'inherit' });
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
