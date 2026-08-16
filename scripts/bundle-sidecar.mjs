#!/usr/bin/env node
/**
 * Bundle a self-contained engine-runner sidecar for packaged desktop installs (DSK-5/11).
 *
 * Output: apps/desktop/src-tauri/resources/sidecar/
 *   index.js          â€” entry (copies dist/index.js)
 *   lib/â€¦             â€” engine-runner dist
 *   node_modules/     â€” @lobster/* + proxy-chain/undici (no patchright: CDP is first-party)
 *   package.json      â€” marks the bundle as ESM
 *
 * The Rust core spawns: `$LOBSTER_NODE_BIN <resources>/sidecar/index.js`
 */

import { cpSync, existsSync, mkdirSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, '..'); // scripts/ â†’ lobster-browser/
const outDir = join(repo, 'apps/desktop/src-tauri/resources/sidecar');
const require = createRequire(import.meta.url);

/**
 * Locate npm's JS entry point so it can be run through `node` directly.
 *
 * Spawning the `npm` wrapper is a portability trap. On Windows `npm` is npm.cmd, and since the
 * CVE-2024-27980 hardening (Node >= 18.20.2 / 20.12.2) spawnSync REFUSES to execute a .cmd/.bat
 * unless shell:true â€” it fails with EINVAL and a null status, which the old
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
  console.log(`[bundle-sidecar] building ${workspace}â€¦`);
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
  // spawn failures (ENOENT, EACCES) surface on r.error with a null status â€” report them instead of
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
  console.log(`[bundle-sidecar] copied ${name} â†’ node_modules/${destName}`);
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

// 3. Bundle engine-runner and everything it imports into ONE file.
//
// This used to copy dist/ verbatim and then copy every dependency's whole package directory beside
// it. That shipped 41.8 MB of node_modules - 21.5 MB of it our own @lobster packages, which carry
// the full fingerprint catalog in unminified source form, plus every README, .d.ts, map and test
// fixture in every third-party package. Node then resolved and parsed that tree on each launch.
//
// Bundling keeps only the code actually reachable from the entry. Node built-ins stay external
// (they are provided by the runtime); everything else is inlined.
const runnerEntry = join(repo, 'packages/engine-runner/dist/index.js');
if (!existsSync(runnerEntry)) {
  console.error('[bundle-sidecar] engine-runner dist/index.js missing');
  process.exit(1);
}

{
  const { rolldown } = await import('rolldown');
  const build = await rolldown({
    input: runnerEntry,
    platform: 'node',
    // Node built-ins only. Anything else that stays external would have to be shipped beside the
    // bundle, which is the thing being removed.
    external: [/^node:/],
    // A dependency that cannot be resolved must fail the build, not silently become a runtime
    // require of something we did not ship - that is the failure mode the tldts incident had.
    onwarn(warning, warn) {
      if (warning.code === 'UNRESOLVED_IMPORT' || warning.code === 'MISSING_EXPORT') {
        console.error(`[bundle-sidecar] ${warning.code}: ${warning.message}`);
        process.exit(1);
      }
      warn(warning);
    },
  });
  await build.write({
    file: join(outDir, 'index.js'),
    format: 'esm',
    // One file: no module resolution work at startup, and nothing beside it that can go missing.
    codeSplitting: false,
    banner: '#!/usr/bin/env node',
  });
  await build.close();
  const bytes = readFileSync(join(outDir, 'index.js')).length;
  console.log(`[bundle-sidecar] bundled index.js  ${(bytes / 1024 / 1024).toFixed(2)} MB`);
}

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

// 5. Nothing else to copy.
//
// Sections 5 and 6 used to copy the @lobster workspace packages and a HAND-MAINTAINED list of
// third-party packages into node_modules/ beside the entry. The bundle above inlines everything
// reachable from the entry, so both are gone - and with them the hand-maintained list that once
// shipped a sidecar unable to start, because @lobster/agent gained a dependency nobody added to
// it and copyPkg only warned. What the bundler cannot resolve now fails the build.

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
    console.error('[bundle-sidecar] SMOKE TEST FAILED â€” the bundle does not start.');
    if (res.error) console.error(`  spawn error: ${res.error.message}`);
    if (res.stderr) console.error(res.stderr.split('\n').slice(0, 15).join('\n'));
    if (stdout) console.error(`  stdout: ${stdout.slice(0, 400)}`);
    console.error(
      '\n  A missing runtime dependency is the usual cause. Add it to the third-party list above â€”\n' +
        '  copyPkg only warns when a package is absent, so the bundle is produced either way.',
    );
    process.exit(1);
  }
  console.log('[bundle-sidecar] smoke test OK (ping/pong)');
}

console.log(`[bundle-sidecar] done â†’ ${outDir}`);
