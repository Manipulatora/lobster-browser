#!/usr/bin/env node
// Build the React Lobee extension (packages/lobee-app) and publish it to packages/lobee — the
// self-contained MV3 bundle the launcher snapshots per profile. Run after editing the panel source.
import { spawnSync } from 'node:child_process';
import { cpSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const app = join(repo, 'packages/lobee-app');
const r = spawnSync('node', ['node_modules/.bin/vite', 'build'], { cwd: app, stdio: 'inherit' });
if (r.status !== 0) process.exit(r.status ?? 1);
const out = join(repo, 'packages/lobee');
rmSync(out, { recursive: true, force: true });
cpSync(join(app, 'dist'), out, { recursive: true });
console.log('[build-lobee] published →', out);
