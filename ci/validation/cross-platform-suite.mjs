#!/usr/bin/env node
// CROSS-PLATFORM node:test SUITE — the portable half of the repo, run on windows-latest and
// macos-latest (docs/PROFILE_DATA_SYNC.md §13, Phase 1).
//
// Why this exists instead of `npm run test --workspaces --if-present`:
//
//   1. A handful of individual test FILES are not portable TODAY, and a permanently red job gates
//      nothing. The exclusions below name every file we do not run, on which platform, and why — so
//      the cost of each one is visible in review rather than discovered as an absence.
//   2. One risk (Windows symlink privilege) can only be resolved on the runner itself, so it is
//      PROBED rather than assumed. A probe keeps the job honest either way: with the privilege
//      nothing is skipped; without it the skipped files are printed by name instead of the whole
//      job going red for a reason that has nothing to do with the code under test.
//
// The failure mode of any allowlist is silence, so this script fails when an exclusion no longer
// matches a real file: a renamed test would otherwise stay quietly un-run forever.
//
// Deliberately NOT run here (both are covered by the ubuntu `web` job):
//   - apps/backend — it ships as a Linux container, has no platform-conditional code, and its e2e
//     specs stand up Nest + supertest per file. Running them on Windows/macOS costs minutes and
//     buys no platform signal.
//   - apps/desktop (the JS half) — no test script; its Rust core is covered by cargo in the same job.

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');
const PLATFORM = process.platform;

/** TypeScript project references built once, in dependency order, before anything runs. */
const TS_PROJECTS = [
  'packages/shared-types',
  'packages/crypto',
  'packages/fingerprint',
  'packages/proxy',
  'packages/cookies',
  'packages/agent',
  'packages/engine-runner',
];

/**
 * Files we do not run, and the exact reason.
 *
 * `platforms` is an unconditional exclusion. `requires` names a runtime capability probed below, so
 * the file runs wherever the capability is real. Every entry must point at a file that exists — see
 * `assertExclusionsStillMatch`.
 */
const EXCLUSIONS = [
  {
    file: 'packages/engine-runner/dist/runners/lobium-launcher.test.js',
    platforms: ['win32'],
    // `ensureChromiumLaunchPreferences writes Preferences atomically` asserts
    // `stat().mode & 0o777 === 0o600` (src/runners/lobium-launcher.test.ts:310). Windows has no POSIX
    // mode bits — Node maps `mode` onto the read-only ATTRIBUTE alone, so a file written 0o600 reads
    // back 0o666 and the assertion fails for a reason unrelated to the atomic-write behaviour it is
    // there to prove. Two sibling suites already handle exactly this (lobium-config.test.ts:251,
    // journal/store.test.ts:35): assert `mode & 0o200` on win32 instead. Once that one assertion is
    // guarded the same way, DELETE this entry — the launcher is the most platform-sensitive module
    // in the tree and this is the least comfortable exclusion in the list.
    why: 'asserts a POSIX 0o600 mode that Windows cannot express (lobium-launcher.test.ts:310)',
  },
  {
    file: 'packages/agent/dist/journal/store.test.js',
    requires: 'symlink',
    why: 'creates symlinks to prove the journal store refuses them',
  },
  {
    file: 'packages/agent/dist/upload.test.js',
    requires: 'symlink',
    why: 'creates symlinks and a home-directory alias to prove the upload allowlist is realpath-based',
  },
  {
    file: 'packages/engine-runner/dist/extensions.test.js',
    requires: 'symlink',
    why: 'creates a symlink inside a local unpacked extension to prove the snapshot fails closed',
  },
];

/**
 * The suites, in the order they run. `dir` is walked for `match`; nothing is globbed by a shell, so
 * the Windows shell's lack of glob expansion cannot change what runs.
 */
const SUITES = [
  { name: '@lobster/crypto', dir: 'packages/crypto/dist', match: /\.test\.js$/ },
  { name: '@lobster/fingerprint', dir: 'packages/fingerprint/dist', match: /\.test\.js$/ },
  { name: '@lobster/proxy', dir: 'packages/proxy/dist', match: /\.test\.js$/ },
  { name: '@lobster/cookies', dir: 'packages/cookies/dist', match: /\.test\.js$/ },
  { name: '@lobster/agent', dir: 'packages/agent/dist', match: /\.test\.js$/ },
  { name: '@lobster/engine-runner', dir: 'packages/engine-runner/dist', match: /\.test\.js$/ },
  {
    name: '@lobster/lobee-app',
    dir: 'packages/lobee-app/src',
    match: /\.test\.mjs$/,
    // Same flags the package's own `test` script uses: one suite imports './history.ts' directly, so
    // the runner has to strip types. Kept identical rather than trimmed, so this cannot pass here and
    // fail in the workspace script (or the reverse) on the Node version .nvmrc pins.
    nodeArgs: ['--experimental-strip-types', '--experimental-specifier-resolution=node'],
  },
  { name: '@lobster/local-api-sdk', dir: 'packages/local-api-sdk/js', match: /\.test\.js$/ },
];

function walk(dir) {
  const found = [];
  const absolute = join(ROOT, dir);
  if (!existsSync(absolute)) return found;
  for (const entry of readdirSync(absolute, { withFileTypes: true })) {
    const child = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(child));
    else found.push(child);
  }
  return found;
}

function run(command, args, label) {
  return new Promise((resolvePromise) => {
    console.log(`\n$ ${label ?? [command, ...args].join(' ')}`);
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', (error) => {
      console.error(`  spawn failed: ${error.message}`);
      resolvePromise(1);
    });
    child.on('close', (code) => resolvePromise(code ?? 1));
  });
}

/**
 * Can this platform create a symlink at all?
 *
 * On Windows, `CreateSymbolicLinkW` needs SeCreateSymbolicLinkPrivilege (an elevated administrator,
 * or Developer Mode) and fails with EPERM otherwise. Three suites use symlinks to prove a
 * fail-closed path, which is exactly the kind of test worth having — so we ask the runner rather
 * than guessing about the image.
 */
async function canCreateSymlink() {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-symlink-probe-'));
  try {
    const target = join(dir, 'target');
    await writeFile(target, 'probe');
    await symlink(target, join(dir, 'link'));
    return true;
  } catch (error) {
    // A non-Windows box that cannot symlink is a broken runner, not a platform limitation: refuse to
    // silently drop the coverage.
    if (PLATFORM !== 'win32') {
      throw new Error(`symlinks are unavailable on ${PLATFORM}: ${error.message}`);
    }
    console.log(
      `\n[probe] symlink creation is unavailable on this Windows runner: ${error.message}`,
    );
    return false;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/** A stale exclusion must fail loudly: a renamed test would otherwise stay un-run forever. */
function assertExclusionsStillMatch() {
  const stale = EXCLUSIONS.filter((entry) => !existsSync(join(ROOT, entry.file)));
  if (stale.length > 0) {
    console.error('\nStale exclusions in ci/validation/cross-platform-suite.mjs:');
    for (const entry of stale) console.error(`  ${entry.file} no longer exists — delete the entry`);
    return false;
  }
  return true;
}

async function main() {
  console.log(`cross-platform suite on ${PLATFORM} (${process.arch}), node ${process.version}`);

  const tsc = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    console.error('typescript is not installed — run npm install first');
    return 1;
  }
  const built = await run(
    process.execPath,
    [tsc, '-b', ...TS_PROJECTS],
    `tsc -b (${TS_PROJECTS.length} projects)`,
  );
  if (built !== 0) return built;

  if (!assertExclusionsStillMatch()) return 1;

  const symlinks = await canCreateSymlink();
  const capabilities = { symlink: symlinks };
  const skipped = [];
  const excluded = new Set();
  for (const entry of EXCLUSIONS) {
    const byPlatform = entry.platforms?.includes(PLATFORM) === true;
    const byCapability = entry.requires !== undefined && capabilities[entry.requires] === false;
    if (byPlatform || byCapability) {
      excluded.add(resolve(ROOT, entry.file));
      skipped.push(entry);
    }
  }

  const failures = [];
  for (const suite of SUITES) {
    const files = walk(suite.dir)
      .filter((file) => suite.match.test(file))
      .filter((file) => statSync(join(ROOT, file)).isFile())
      .filter((file) => !excluded.has(resolve(ROOT, file)))
      .sort();
    if (files.length === 0) {
      console.error(
        `\n${suite.name}: no test files under ${suite.dir} — the build did not produce any`,
      );
      failures.push(suite.name);
      continue;
    }
    const args = [...(suite.nodeArgs ?? []), '--test', ...files];
    const code = await run(
      process.execPath,
      args,
      `${suite.name}: node --test (${files.length} files)`,
    );
    if (code !== 0) failures.push(suite.name);
  }

  console.log('\n======== cross-platform suite ========');
  if (skipped.length === 0) {
    console.log('skipped: nothing — every suite in the list ran');
  } else {
    console.log(`skipped ${skipped.length} file(s) on ${PLATFORM}:`);
    for (const entry of skipped) {
      console.log(`  ${relative(ROOT, join(ROOT, entry.file))}`);
      console.log(`    ${entry.why}`);
    }
  }
  if (failures.length > 0) {
    console.log(`FAILED: ${failures.join(', ')}`);
    return 1;
  }
  console.log('PASS');
  return 0;
}

process.exitCode = await main();
