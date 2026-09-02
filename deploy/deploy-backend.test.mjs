/**
 * deploy/deploy-backend.sh against a fixture box.
 *
 * The script is exercised for real — rsync, cp -al, ln -sfn, git — inside a temporary checkout and
 * a temporary /opt/lobster, with only the parts that need a real box replaced by shims on PATH:
 * `sudo` runs its command as the current user, `systemctl` records what it was asked and fails when
 * the live dist/ carries a NOSTART marker, `curl` answers 503 on /health/ready while the live dist/
 * carries a BROKEN marker, `npm` records the build order, and `prisma` records its arguments and
 * the DATABASE_URL it was handed. That is enough to prove the four things a deploy script must
 * get right: what it ships, where it puts it, that it comes back when a release does not serve,
 * and that it touches nothing it should not.
 *
 * Run: `node --test deploy/deploy-backend.test.mjs`
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const here = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(here, 'deploy-backend.sh');
const OLD_RELEASE = '20260101000000';

const write = (file, content) => {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
};
const read = (file) => readFileSync(file, 'utf8');
const shim = (file, body) => {
  write(file, `#!/usr/bin/env bash\n${body}\n`);
  chmodSync(file, 0o755);
};
const manifest = (name, extra = {}) =>
  JSON.stringify({ name, version: '0.0.0', main: './dist/index.js', ...extra });
const thirdParty = (name, version) => JSON.stringify({ name, version });

/** The tree the box holds before a deploy: an older build of everything the script refreshes. */
function oldRuntimeTree(dir) {
  write(join(dir, 'dist/main.js'), 'old main');
  write(join(dir, 'prisma/schema.prisma'), 'old schema');
  write(join(dir, 'prisma/migrations/0001_init/migration.sql'), 'CREATE');
  write(
    join(dir, 'node_modules/@lobster/shared-types/package.json'),
    manifest('@lobster/shared-types'),
  );
  write(join(dir, 'node_modules/@lobster/shared-types/dist/index.js'), 'old shared-types');
  write(
    join(dir, 'node_modules/@lobster/shared-types/src/stale.ts'),
    'a src/ copy nobody meant to ship',
  );
  write(
    join(dir, 'node_modules/@nestjs/common/package.json'),
    thirdParty('@nestjs/common', '1.0.0'),
  );
  write(join(dir, 'node_modules/@noble/hashes/package.json'), thirdParty('@noble/hashes', '2.0.0'));
  write(
    join(dir, 'node_modules/@prisma/client/package.json'),
    thirdParty('@prisma/client', '5.0.0'),
  );
  write(join(dir, 'node_modules/.prisma/client/index.js'), 'old generated client');
}

/**
 * A checkout plus a box. `layout` is what /opt/lobster/backend is on that box: a symlink into
 * releases/, the pre-script directory, or nothing at all.
 */
function fixture({ layout }) {
  const tmp = mkdtempSync(join(tmpdir(), 'deploy-backend-'));
  const repo = join(tmp, 'repo');
  const box = join(tmp, 'box');
  const bin = join(tmp, 'bin');
  const calls = join(tmp, 'calls.log');
  const live = join(box, 'backend');

  // --- the checkout: two workspace packages the backend uses, one it does not ------------------
  write(
    join(repo, 'package.json'),
    JSON.stringify({
      name: 'fixture',
      workspaces: ['packages/shared-types', 'packages/crypto', 'packages/unused', 'apps/backend'],
    }),
  );
  write(join(repo, '.gitignore'), 'node_modules\ndist\n');
  write(
    join(repo, 'apps/backend/package.json'),
    JSON.stringify({
      name: '@lobster/backend',
      dependencies: {
        '@lobster/crypto': '*',
        '@lobster/shared-types': '*',
        '@nestjs/common': '^1',
        '@prisma/client': '^5',
      },
    }),
  );
  write(join(repo, 'apps/backend/dist/main.js'), 'new main');
  write(join(repo, 'apps/backend/prisma/schema.prisma'), 'new schema');
  write(join(repo, 'apps/backend/prisma/migrations/0001_init/migration.sql'), 'CREATE');
  write(join(repo, 'apps/backend/prisma/migrations/0002_column/migration.sql'), 'ALTER');
  write(join(repo, 'packages/shared-types/package.json'), manifest('@lobster/shared-types'));
  write(join(repo, 'packages/shared-types/dist/index.js'), 'new shared-types');
  write(join(repo, 'packages/shared-types/src/index.ts'), 'source, never shipped');
  write(
    join(repo, 'packages/crypto/package.json'),
    manifest('@lobster/crypto', {
      dependencies: { '@lobster/shared-types': '*', '@noble/hashes': '^2' },
    }),
  );
  write(join(repo, 'packages/crypto/dist/index.js'), 'new crypto');
  write(join(repo, 'packages/unused/package.json'), manifest('@lobster/unused'));
  write(join(repo, 'packages/unused/dist/index.js'), 'must not ship');
  write(
    join(repo, 'node_modules/@nestjs/common/package.json'),
    thirdParty('@nestjs/common', '1.0.0'),
  );
  write(
    join(repo, 'node_modules/@noble/hashes/package.json'),
    thirdParty('@noble/hashes', '2.0.0'),
  );
  write(
    join(repo, 'node_modules/@prisma/client/package.json'),
    thirdParty('@prisma/client', '5.0.0'),
  );
  write(join(repo, 'node_modules/@prisma/client/default.js'), 'new prisma runtime');
  write(join(repo, 'node_modules/.prisma/client/index.js'), 'new generated client');
  mkdirSync(join(repo, 'node_modules/@lobster'), { recursive: true });
  symlinkSync('../../packages/shared-types', join(repo, 'node_modules/@lobster/shared-types'));
  shim(
    join(repo, 'node_modules/.bin/prisma'),
    [
      `printf 'prisma %s DATABASE_URL=%s\\n' "$*" "\${DATABASE_URL:-unset}" >> "$FAKE_LOG"`,
      'case "$1 $2" in',
      '  "migrate status") exit "${FAKE_MIGRATE_STATUS:-0}" ;;',
      '  "migrate deploy") exit "${FAKE_MIGRATE_DEPLOY:-0}" ;;',
      'esac',
      'exit 0',
    ].join('\n'),
  );
  mkdirSync(join(repo, 'deploy'));
  cpSync(SCRIPT, join(repo, 'deploy/deploy-backend.sh'));
  chmodSync(join(repo, 'deploy/deploy-backend.sh'), 0o755);
  const git = (...args) =>
    execFileSync(
      'git',
      ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args],
      { cwd: repo, stdio: 'pipe' },
    );
  git('init', '-q');
  git('add', '-A');
  git('commit', '-q', '-m', 'fixture');

  // --- the box ----------------------------------------------------------------------------------
  write(join(box, 'backend.env'), 'PORT=8080\nDATABASE_URL="postgresql://fake/db"\n');
  if (layout === 'directory') oldRuntimeTree(live);
  if (layout === 'symlink') {
    oldRuntimeTree(join(box, 'releases', OLD_RELEASE));
    symlinkSync(join(box, 'releases', OLD_RELEASE), live);
  }

  // --- what stands in for the box's privileged surface ------------------------------------------
  shim(
    join(bin, 'sudo'),
    [
      `printf 'sudo %s\\n' "$*" >> "$FAKE_LOG"`,
      'while [[ $# -gt 0 && $1 == -* ]]; do shift; done',
      '[[ $# -eq 0 ]] && exit 0',
      'exec "$@"',
    ].join('\n'),
  );
  shim(
    join(bin, 'systemctl'),
    [
      `printf 'systemctl %s\\n' "$*" >> "$FAKE_LOG"`,
      'if [[ $1 == restart && -e "$FAKE_LIVE/dist/NOSTART" ]]; then echo "Job for $2.service failed." >&2; exit 1; fi',
      'exit 0',
    ].join('\n'),
  );
  shim(
    join(bin, 'curl'),
    [
      'url=${*: -1}',
      'code=200',
      'if [[ $url == */health/ready && -e "$FAKE_LIVE/dist/BROKEN" ]]; then code=503; fi',
      `if [[ " $* " == *" -w "* ]]; then printf '%s' "$code"; else printf '{"code":0,"data":{"status":"ready"}}'; fi`,
    ].join('\n'),
  );
  shim(join(bin, 'npm'), `printf 'npm %s\\n' "$*" >> "$FAKE_LOG"`);

  const run = (args = [], env = {}) => {
    const result = spawnSync('bash', [join(repo, 'deploy/deploy-backend.sh'), ...args], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${bin}:${process.env.PATH}`,
        LOBSTER_DEPLOY_ROOT: box,
        LOBSTER_BACKEND_ENV_FILE: join(box, 'backend.env'),
        LOBSTER_HEALTH_ORIGIN: 'http://127.0.0.1:1',
        LOBSTER_READY_TIMEOUT: '1',
        FAKE_LOG: calls,
        FAKE_LIVE: live,
        ...env,
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      calls: existsSync(calls) ? read(calls) : '',
    };
  };
  const releases = () =>
    existsSync(join(box, 'releases')) ? readdirSync(join(box, 'releases')).sort() : [];
  const newest = () => releases().at(-1);
  return { repo, box, live, run, releases, newest };
}

test('--dry-run prints the whole plan, in dependency order, and changes nothing', () => {
  const f = fixture({ layout: 'directory' });
  const { status, stdout, calls } = f.run(['--dry-run', '--migrate']);
  assert.equal(status, 0, stdout);
  assert.match(stdout, /DRY RUN/);
  // Dependencies before dependents, the backend last; a workspace the backend does not use is not
  // built and not shipped.
  const at = (needle) => {
    const i = stdout.indexOf(needle);
    assert.ok(i >= 0, `expected ${needle} in:\n${stdout}`);
    return i;
  };
  assert.ok(at('--workspace @lobster/shared-types') < at('--workspace @lobster/crypto'));
  assert.ok(at('--workspace @lobster/crypto') < at('--workspace @lobster/backend'));
  assert.doesNotMatch(stdout, /@lobster\/unused/);
  assert.match(stdout, /prisma generate --schema/);
  assert.match(stdout, /migrate deploy --schema/);
  assert.match(stdout, /systemctl stop lobster-backend/);
  assert.match(stdout, /systemctl restart lobster-backend/);
  assert.match(stdout, /poll http:\/\/127\.0\.0\.1:1\/health\/ready/);
  // Nothing ran and nothing moved: no shim was invoked, the box still holds the old build.
  assert.equal(calls, '');
  assert.equal(read(join(f.live, 'dist/main.js')), 'old main');
  assert.deepEqual(f.releases(), []);
});

test('symlink layout: a release is a complete tree and the flip is one symlink', () => {
  const f = fixture({ layout: 'symlink' });
  const { status, stdout, stderr, calls } = f.run();
  assert.equal(status, 0, stdout + stderr);

  const release = join(f.box, 'releases', f.newest());
  assert.notEqual(f.newest(), OLD_RELEASE);
  assert.equal(readlinkSync(f.live), release);
  // What the release holds: this build's dist and prisma tree, the manifest, every workspace
  // package the backend depends on (transitively: crypto pulls shared-types) as package.json +
  // dist and nothing from src/, and the generated Prisma client with its runtime.
  assert.equal(read(join(release, 'dist/main.js')), 'new main');
  assert.equal(read(join(release, 'prisma/schema.prisma')), 'new schema');
  assert.ok(existsSync(join(release, 'prisma/migrations/0002_column/migration.sql')));
  assert.ok(existsSync(join(release, 'package.json')));
  assert.equal(
    read(join(release, 'node_modules/@lobster/shared-types/dist/index.js')),
    'new shared-types',
  );
  assert.equal(read(join(release, 'node_modules/@lobster/crypto/dist/index.js')), 'new crypto');
  assert.ok(existsSync(join(release, 'node_modules/@lobster/crypto/package.json')));
  assert.ok(
    !existsSync(join(release, 'node_modules/@lobster/shared-types/src')),
    'src/ is not shipped',
  );
  assert.ok(!existsSync(join(release, 'node_modules/@lobster/unused')));
  assert.equal(read(join(release, 'node_modules/.prisma/client/index.js')), 'new generated client');
  assert.equal(read(join(release, 'node_modules/@prisma/client/default.js')), 'new prisma runtime');
  // Third-party packages are the live release's inodes, not copies — and the live release itself
  // is untouched by the overlay, which is what makes it a rollback target.
  const old = join(f.box, 'releases', OLD_RELEASE);
  assert.equal(
    statSync(join(release, 'node_modules/@nestjs/common/package.json')).ino,
    statSync(join(old, 'node_modules/@nestjs/common/package.json')).ino,
  );
  assert.equal(
    read(join(old, 'node_modules/@lobster/shared-types/dist/index.js')),
    'old shared-types',
  );
  assert.equal(read(join(old, 'dist/main.js')), 'old main');
  assert.ok(existsSync(join(old, 'node_modules/@lobster/shared-types/src/stale.ts')));
  // The record of what is running.
  const record = read(join(release, 'RELEASE'));
  assert.match(record, /^revision=[0-9a-f]{12}$/m);
  assert.match(record, /^layout=symlink$/m);
  assert.match(record, /^packages=@lobster\/shared-types,@lobster\/crypto$/m);
  assert.match(read(join(f.box, 'deploy.log')), /deployed .*rev=[0-9a-f]{12} layout=symlink/);
  // Migrations were checked, not applied; the unit was restarted, never stopped.
  assert.match(
    calls,
    /prisma migrate status --schema .*\/prisma\/schema\.prisma DATABASE_URL=postgresql:\/\/fake\/db/,
  );
  assert.doesNotMatch(calls, /migrate deploy/);
  assert.match(calls, /systemctl restart lobster-backend/);
  assert.doesNotMatch(calls, /systemctl stop/);
});

test('symlink layout: a release that never becomes ready is flipped back', () => {
  const f = fixture({ layout: 'symlink' });
  write(join(f.repo, 'apps/backend/dist/BROKEN'), '');
  const { status, stderr, calls } = f.run();
  assert.notEqual(status, 0);
  assert.equal(readlinkSync(f.live), join(f.box, 'releases', OLD_RELEASE));
  assert.match(stderr, /rolling back/);
  assert.match(stderr, /reverted to /);
  // Lines the systemctl shim wrote, not the sudo shim's echo of the same command.
  assert.equal(calls.match(/^systemctl restart lobster-backend$/gm).length, 2);
  // The failed release is kept for inspection and the failure is on the record.
  assert.ok(existsSync(join(f.box, 'releases', f.newest(), 'dist/BROKEN')));
  assert.match(read(join(f.box, 'deploy.log')), /FAILED .*rolled back to /);
});

test('directory layout: the release is synced into the directory and the replaced set is kept', () => {
  const f = fixture({ layout: 'directory' });
  const { status, stdout, stderr, calls } = f.run();
  assert.equal(status, 0, stdout + stderr);
  assert.ok(!lstatSync(f.live).isSymbolicLink(), 'the layout is not converted behind the operator');
  assert.equal(read(join(f.live, 'dist/main.js')), 'new main');
  assert.equal(read(join(f.live, 'prisma/schema.prisma')), 'new schema');
  assert.equal(
    read(join(f.live, 'node_modules/@lobster/shared-types/dist/index.js')),
    'new shared-types',
  );
  assert.ok(
    !existsSync(join(f.live, 'node_modules/@lobster/shared-types/src')),
    'the stale src/ copy is gone',
  );
  assert.equal(read(join(f.live, 'node_modules/@lobster/crypto/dist/index.js')), 'new crypto');
  assert.equal(read(join(f.live, 'node_modules/.prisma/client/index.js')), 'new generated client');
  assert.ok(
    existsSync(join(f.live, 'node_modules/@nestjs/common/package.json')),
    'third-party tree untouched',
  );
  assert.match(read(join(f.live, 'RELEASE')), /^layout=directory$/m);
  // What was replaced is beside it, whole, for rollback.
  const previous = join(f.box, 'backend.previous');
  assert.equal(read(join(previous, 'dist/main.js')), 'old main');
  assert.equal(read(join(previous, 'prisma/schema.prisma')), 'old schema');
  assert.equal(
    read(join(previous, 'node_modules/@lobster/shared-types/dist/index.js')),
    'old shared-types',
  );
  assert.equal(
    read(join(previous, 'node_modules/.prisma/client/index.js')),
    'old generated client',
  );
  // Stopped before the sync, restarted after it.
  assert.ok(
    calls.indexOf('systemctl stop lobster-backend') <
      calls.indexOf('systemctl restart lobster-backend'),
  );
});

test('directory layout: a restart that fails puts the previous set back', () => {
  const f = fixture({ layout: 'directory' });
  write(join(f.repo, 'apps/backend/dist/NOSTART'), '');
  const { status, stderr, calls } = f.run();
  assert.notEqual(status, 0);
  assert.match(stderr, /systemctl restart lobster-backend failed/);
  assert.match(stderr, /reverted to /);
  assert.equal(read(join(f.live, 'dist/main.js')), 'old main');
  assert.ok(!existsSync(join(f.live, 'dist/NOSTART')));
  assert.equal(
    read(join(f.live, 'node_modules/@lobster/shared-types/dist/index.js')),
    'old shared-types',
  );
  // Lines the systemctl shim wrote, not the sudo shim's echo of the same command.
  assert.equal(calls.match(/^systemctl restart lobster-backend$/gm).length, 2);
});

test('--migrate applies the release migrations with DATABASE_URL from the env file, before the switch', () => {
  const f = fixture({ layout: 'symlink' });
  const { status, stdout, stderr, calls } = f.run(['--migrate']);
  assert.equal(status, 0, stdout + stderr);
  const release = join(f.box, 'releases', f.newest());
  // The release's own schema (so the migrations dir beside it is this build's), the URL exactly
  // as the env file holds it minus the quotes systemd would strip, and the deploy before the flip.
  assert.match(
    calls,
    new RegExp(
      `prisma migrate deploy --schema ${release}/prisma/schema\\.prisma DATABASE_URL=postgresql://fake/db`,
    ),
  );
  assert.doesNotMatch(calls, /migrate status/);
  assert.ok(calls.indexOf('migrate deploy') < calls.indexOf('ln -sfn'));
});

test('pending migrations stop the deploy before anything is published', () => {
  const f = fixture({ layout: 'symlink' });
  const { status, stderr, calls } = f.run([], { FAKE_MIGRATE_STATUS: '1' });
  assert.notEqual(status, 0);
  assert.match(stderr, /--migrate/);
  assert.equal(readlinkSync(f.live), join(f.box, 'releases', OLD_RELEASE));
  assert.doesNotMatch(calls, /systemctl/);
});

test('a runtime tree missing a package the backend loads stops the deploy before staging', () => {
  const f = fixture({ layout: 'directory' });
  execFileSync('rm', ['-r', join(f.live, 'node_modules/@noble/hashes')]);
  const { status, stderr } = f.run();
  assert.notEqual(status, 0);
  assert.match(stderr, /@noble\/hashes is not in /);
  assert.deepEqual(f.releases(), []);
  assert.equal(read(join(f.live, 'dist/main.js')), 'old main');
});

test('uncommitted changes are refused unless --allow-dirty, which marks the release', () => {
  const f = fixture({ layout: 'symlink' });
  write(join(f.repo, 'packages/shared-types/src/index.ts'), 'edited, not committed');
  const refused = f.run();
  assert.notEqual(refused.status, 0);
  assert.match(refused.stderr, /--allow-dirty/);
  assert.equal(readlinkSync(f.live), join(f.box, 'releases', OLD_RELEASE));
  const allowed = f.run(['--allow-dirty']);
  assert.equal(allowed.status, 0, allowed.stdout + allowed.stderr);
  assert.match(
    read(join(f.box, 'releases', f.newest(), 'RELEASE')),
    /^revision=[0-9a-f]{12}-dirty$/m,
  );
});

test('--check reports liveness and readiness and changes nothing', () => {
  const f = fixture({ layout: 'symlink' });
  const ok = f.run(['--check']);
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /\/health\s+200/);
  assert.match(ok.stdout, /\/health\/ready\s+200/);
  assert.match(ok.stdout, new RegExp(`live release: ${join(f.box, 'releases', OLD_RELEASE)}`));
  assert.equal(ok.calls, '');
  write(join(f.live, 'dist/BROKEN'), '');
  const broken = f.run(['--check']);
  assert.notEqual(broken.status, 0);
  assert.match(broken.stdout, /\/health\/ready\s+503/);
});

test('--rollback re-points a symlink layout at the release before the live one', () => {
  const f = fixture({ layout: 'symlink' });
  assert.equal(f.run().status, 0);
  const deployed = f.newest();
  const back = f.run(['--rollback']);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(readlinkSync(f.live), join(f.box, 'releases', OLD_RELEASE));
  assert.ok(existsSync(join(f.box, 'releases', deployed)), 'the release rolled away from is kept');
  assert.match(back.calls, /systemctl restart lobster-backend/);
  // Nothing older than the oldest: refuse rather than guess.
  const nothing = f.run(['--rollback']);
  assert.notEqual(nothing.status, 0);
  assert.match(nothing.stderr, /no release older than/);
});

test('--rollback restores backend.previous in the directory layout', () => {
  const f = fixture({ layout: 'directory' });
  assert.equal(f.run().status, 0);
  assert.equal(read(join(f.live, 'dist/main.js')), 'new main');
  const back = f.run(['--rollback']);
  assert.equal(back.status, 0, back.stdout + back.stderr);
  assert.equal(read(join(f.live, 'dist/main.js')), 'old main');
  assert.equal(
    read(join(f.live, 'node_modules/@lobster/shared-types/dist/index.js')),
    'old shared-types',
  );
  assert.ok(back.calls.indexOf('systemctl stop') < back.calls.indexOf('systemctl restart'));
});

test('old releases are pruned to LOBSTER_KEEP_RELEASES, never the live one or the one it replaced', () => {
  const f = fixture({ layout: 'symlink' });
  for (const stamp of ['20250101000000', '20250201000000', '20250301000000']) {
    write(join(f.box, 'releases', stamp, 'dist/main.js'), 'ancient');
  }
  const { status, stdout, stderr } = f.run([], { LOBSTER_KEEP_RELEASES: '2' });
  assert.equal(status, 0, stdout + stderr);
  // Two newest by name would be the new release and the old live one; the old live one is also
  // the rollback target, and both survive while everything older goes.
  assert.deepEqual(f.releases(), [OLD_RELEASE, f.newest()]);
});
