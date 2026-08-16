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

/**
 * Locate npm's JS entry point so it can be run through `node` directly.
 *
 * Spawning the `npm` wrapper is a portability trap. On Windows `npm` is npm.cmd, and since the
 * CVE-2024-27980 hardening (Node >= 18.20.2 / 20.12.2) spawnSync REFUSES to execute a .cmd/.bat
 * unless shell:true — it fails with EINVAL and a null status, which the old
 * `process.exit(r.status ?? 1)` turned into a silent exit-1 on the very first workspace. Using
 * shell:true instead fixes that but trips DEP0190 (args are concatenated, not escaped).
 * Running npm-cli.js under the current interpreter avoids both, on every platform.
 */
function resolveNpmCli() {
  const nodeDir = dirname(process.execPath);
  const candidates = [
    process.env.npm_execpath, // set when this script is itself invoked via npm
    join(nodeDir, 'node_modules/npm/bin/npm-cli.js'), // Windows layout
    join(nodeDir, '../lib/node_modules/npm/bin/npm-cli.js'), // POSIX layout
  ];
  return candidates.find((c) => c && c.endsWith('.js') && existsSync(c));
}

const npmCli = resolveNpmCli();

function mustBuild(workspace) {
  console.log(`[bundle-sidecar] building ${workspace}…`);
  const args = ['run', 'build', '--workspace', workspace];
  const r = npmCli
    ? spawnSync(process.execPath, [npmCli, ...args], {
        cwd: repo,
        stdio: 'inherit',
        env: process.env,
      })
    : // Fallback only if npm-cli.js could not be located; shell:true is required on Windows for .cmd.
      spawnSync('npm', args, {
        cwd: repo,
        stdio: 'inherit',
        env: process.env,
        shell: process.platform === 'win32',
      });
  // spawn failures (ENOENT, EACCES) surface on r.error with a null status — report them instead of
  // exiting with a bare code.
  if (r.error) {
    console.error(`[bundle-sidecar] cannot run npm: ${r.error.message}`);
    process.exit(1);
  }
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
  '@lobster/agent',
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
for (const name of ['shared-types', 'proxy', 'fingerprint', 'cookies', 'crypto', 'agent', 'engine-runner']) {
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
  // Public-suffix lookup for @lobster/agent's browser-config guard, plus its own dependency.
  // Its absence did not fail the bundle - the catch below only warns - so the packaged sidecar
  // shipped unable to start at all: `ERR_MODULE_NOT_FOUND: Cannot find package 'tldts'`, thrown
  // before the first RPC. The app still opened, reported no error, and every profile launch failed.
  // See the smoke test at the end of this script, which now makes that impossible to ship again.
  'tldts',
  'tldts-core',
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

// ---------------------------------------------------------------------------------------------
// Smoke test: START the bundle that was just produced and round-trip a `ping`.
//
// WHY THIS IS NOT OPTIONAL. The third-party list above is hand-maintained and copyPkg failures are
// only warnings, so a new dependency in any @lobster/* package silently produces a bundle that
// cannot load. That is precisely what shipped: `tldts` was missing, the sidecar died with
// ERR_MODULE_NOT_FOUND before its first RPC, and nothing anywhere failed - the app opened normally,
// showed no error, and every profile launch failed against a dead sidecar.
//
// A dependency check would only catch what it knows to look for. Actually running the artifact
// catches anything that stops it starting, which is the property that matters.
{
  const { spawnSync } = await import('node:child_process');
  console.log('[bundle-sidecar] smoke test: starting the bundled sidecar...');
  const res = spawnSync(process.execPath, [join(outDir, 'index.js')], {
    input: `${JSON.stringify({ id: 1, method: 'ping', params: {} })}\n`,
    encoding: 'utf8',
    timeout: 60_000,
    // A bare env: the packaged sidecar must not depend on the developer's shell. Keep only what a
    // service process always has.
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP },
  });

  const stdout = res.stdout ?? '';
  const pong = stdout
    .split('\n')
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((m) => m && m.id === 1);

  if (!pong || pong.ok !== true || pong.result?.pong !== true) {
    console.error('[bundle-sidecar] SMOKE TEST FAILED — the bundle does not start.');
    if (res.error) console.error(`  spawn error: ${res.error.message}`);
    if (res.stderr) console.error(res.stderr.split('\n').slice(0, 15).join('\n'));
    if (stdout) console.error(`  stdout: ${stdout.slice(0, 400)}`);
    console.error(
      '\n  A missing runtime dependency is the usual cause. Add it to the third-party list above —\n' +
        '  copyPkg only warns when a package is absent, so the bundle is produced either way.',
    );
    process.exit(1);
  }
  console.log('[bundle-sidecar] smoke test OK (ping/pong)');
}

console.log(`[bundle-sidecar] done → ${outDir}`);
