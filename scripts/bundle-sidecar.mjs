#!/usr/bin/env node
/**
 * Bundle a self-contained engine-runner sidecar for packaged desktop installs (DSK-5/11).
 *
 * Output: apps/desktop/src-tauri/resources/sidecar/
 *   index.js          — entry (copies dist/index.js)
 *   lib/…             — engine-runner dist
 *   node_modules/     — @lobster/* + proxy-chain/undici (no patchright: CDP is first-party)
 *   package.json      — marks the bundle as ESM
 *
 * The Rust core spawns: `$LOBSTER_NODE_BIN <resources>/sidecar/index.js`
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..'); // scripts/ → lobster-browser/
const outDir = join(repo, 'apps/desktop/src-tauri/resources/sidecar');
const require = createRequire(import.meta.url);

function mustBuild(workspace) {
  console.log(`[bundle-sidecar] building ${workspace}…`);
  const r = spawnSync('npm', ['run', 'build', '--workspace', workspace], {
    cwd: repo,
    stdio: 'inherit',
    env: process.env,
  });
  if (r.status !== 0) process.exit(r.status ?? 1);
}

function resolvePkg(name) {
  // Prefer the hoisted workspace node_modules (avoids package "exports" blocking package.json).
  const candidates = [
    join(repo, 'node_modules', ...name.split('/')),
    join(repo, 'packages/engine-runner/node_modules', ...name.split('/')),
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'package.json'))) return c;
  }
  // Last resort: require.resolve may fail when exports omit package.json.
  try {
    return dirname(require.resolve(`${name}/package.json`));
  } catch {
    throw new Error(`cannot resolve package ${name}`);
  }
}

function copyPkg(name, destName = name) {
  const src = resolvePkg(name);
  const dest = join(outDir, 'node_modules', destName);
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true, filter: (p) => !p.includes('/.git') });
  console.log(`[bundle-sidecar] copied ${name} → node_modules/${destName}`);
}

// 1. Build workspace packages the sidecar imports.
for (const ws of [
  '@lobster/shared-types',
  '@lobster/proxy',
  '@lobster/fingerprint',
  '@lobster/cookies',
  '@lobster/crypto',
  '@lobster/engine-runner',
]) {
  mustBuild(ws);
}

// 2. Fresh output dir.
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

// 3. Copy engine-runner dist as the runnable tree.
const runnerDist = join(repo, 'packages/engine-runner/dist');
if (!existsSync(join(runnerDist, 'index.js'))) {
  console.error('[bundle-sidecar] engine-runner dist/index.js missing');
  process.exit(1);
}
cpSync(runnerDist, join(outDir, 'dist'), { recursive: true });
writeFileSync(
  join(outDir, 'index.js'),
  `#!/usr/bin/env node\nimport './dist/index.js';\n`,
  { mode: 0o755 },
);

// 4. Minimal package.json so Node treats the bundle as ESM and resolves local deps.
writeFileSync(
  join(outDir, 'package.json'),
  JSON.stringify(
    {
      name: 'lobster-engine-sidecar',
      version: '0.0.0',
      private: true,
      type: 'module',
      main: 'index.js',
    },
    null,
    2,
  ) + '\n',
);

// 5. Workspace packages (file: layout under node_modules/@lobster).
mkdirSync(join(outDir, 'node_modules/@lobster'), { recursive: true });
for (const name of ['shared-types', 'proxy', 'fingerprint', 'cookies', 'crypto', 'engine-runner']) {
  const src = join(repo, 'packages', name);
  const dest = join(outDir, 'node_modules/@lobster', name);
  // Prefer dist + package.json only (smaller).
  mkdirSync(dest, { recursive: true });
  const pkg = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
  writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 2) + '\n');
  if (existsSync(join(src, 'dist'))) {
    cpSync(join(src, 'dist'), join(dest, 'dist'), { recursive: true });
  }
  console.log(`[bundle-sidecar] staged @lobster/${name}`);
}

// 6. Third-party runtime deps (and their transitive deps) from the hoisted root node_modules.
// proxy-chain (+ tslib) backs the authenticated SOCKS/HTTP local shim (docs/OPERATIONS.md).
// NOTE: patchright is intentionally NOT bundled — the sidecar drives CDP via the first-party
// cdp-client.ts (raw DevTools WebSocket). patchright is a dev-only tool for ci/validation tests.
for (const name of [
  'undici',
  'socks-proxy-agent',
  'socks',
  'agent-base',
  'debug',
  'ms',
  'ip-address',
  'smart-buffer',
  'proxy-chain',
  'tslib',
  // CRX/unpacked extension preparation.
  'yauzl',
  'pend',
]) {
  try {
    copyPkg(name);
  } catch (err) {
    console.warn(`[bundle-sidecar] skip ${name}: ${err instanceof Error ? err.message : err}`);
  }
}
// @noble/hashes (scoped)
{
  const src = resolvePkg('@noble/hashes');
  const dest = join(outDir, 'node_modules/@noble/hashes');
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  console.log('[bundle-sidecar] copied @noble/hashes');
}

console.log(`[bundle-sidecar] done → ${outDir}`);
