import assert from 'node:assert/strict';
import { link, mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { executeAction } from './executor.js';
import { resolveConfig } from './loop.js';
import type { RawPerception } from './types.js';

/**
 * Upload is the only action that moves data OFF the machine, and it had no test coverage at all.
 * These cover the specific bypasses an audit of this path turned up, so a future refactor cannot
 * quietly reopen them.
 */

const element = {
  index: 0,
  tag: 'input',
  role: 'button',
  name: 'Attach',
  x: 10,
  y: 10,
  w: 80,
  h: 24,
};
const perception = (): RawPerception => ({
  url: 'https://upload.test/form',
  title: 'Upload',
  scrollY: 0,
  viewportH: 720,
  docH: 720,
  canScrollUp: false,
  canScrollDown: false,
  truncated: 0,
  elements: [element],
});

/** A driver that records what it was asked to upload and satisfies the staleness probe. */
function fakeDriver(): { uploaded: string[][]; evaluate: unknown; uploadFiles: unknown } {
  const uploaded: string[][] = [];
  return {
    uploaded,
    async evaluate() {
      // The point-verification probe: report the element the model expected, so the guard passes.
      return { name: 'Attach', role: 'button' };
    },
    async uploadFiles(_point: unknown, paths: string[]) {
      uploaded.push(paths);
    },
    async waitForSettle() {},
  } as never;
}

async function attempt(paths: string[], roots: string[], driver = fakeDriver()) {
  const outcome = await executeAction(
    { kind: 'upload', id: 0, paths },
    perception(),
    driver as never,
    { config: resolveConfig({ allowedUploadRoots: roots }), sleep: async () => {} },
  );
  return {
    outcome: outcome.outcome,
    uploaded: (driver as unknown as { uploaded: string[][] }).uploaded,
  };
}

test('a file inside an approved root uploads', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'up-'));
  try {
    const root = join(dir, 'uploads');
    await mkdir(root);
    const file = join(root, 'cv.pdf');
    await writeFile(file, '%PDF-1.4\n');
    const { outcome, uploaded } = await attempt([file], [root]);
    assert.match(outcome, /uploaded 1 approved/);
    assert.deepEqual(uploaded, [[file]]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a symlink out of an approved root is refused', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'up-'));
  try {
    const root = join(dir, 'uploads');
    const secrets = join(dir, 'secret');
    await mkdir(root);
    await mkdir(secrets);
    await writeFile(join(secrets, 'id_rsa'), 'KEY');
    await symlink(join(secrets, 'id_rsa'), join(root, 'innocent.pdf'));
    const { outcome, uploaded } = await attempt([join(root, 'innocent.pdf')], [root]);
    assert.match(outcome, /not permitted/);
    assert.deepEqual(uploaded, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a HARD link out of an approved root is refused (realpath cannot see it)', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'up-'));
  try {
    const root = join(dir, 'uploads');
    const secrets = join(dir, 'secret');
    await mkdir(root);
    await mkdir(secrets);
    const secret = join(secrets, 'payroll.xlsx');
    await writeFile(secret, 'salaries');
    await link(secret, join(root, 'harmless.xlsx'));
    const { outcome, uploaded } = await attempt([join(root, 'harmless.xlsx')], [root]);
    assert.match(outcome, /not permitted/);
    assert.deepEqual(uploaded, []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a private key is refused even when it sits inside an approved root', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'up-'));
  try {
    const root = join(dir, 'uploads');
    await mkdir(root);
    // Deliberately innocuous name: only the CONTENT gives it away.
    const planted = join(root, 'holiday-photo.txt');
    await writeFile(planted, '-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n');
    const { outcome, uploaded } = await attempt([planted], [root]);
    assert.match(outcome, /not permitted/);
    assert.deepEqual(uploaded, [], 'a key must never leave, wherever it is stored');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every refusal is the same message, so the action is not a filesystem oracle', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'up-'));
  try {
    const root = join(dir, 'uploads');
    await mkdir(root);
    await writeFile(join(dir, 'outside.txt'), 'x');
    const results = await Promise.all([
      attempt([join(dir, 'does-not-exist-at-all')], [root]),
      attempt([join(dir, 'outside.txt')], [root]),
      attempt([dir], [root]),
      attempt(['/etc/shadow'], [root]),
    ]);
    const messages = new Set(results.map((r) => r.outcome));
    assert.equal(
      messages.size,
      1,
      `a missing file, an existing file outside the root, a directory and an unreadable system file must be indistinguishable; got ${[...messages].join(' | ')}`,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a root that would defeat the allowlist is rejected at config time', () => {
  assert.throws(
    () => resolveConfig({ allowedUploadRoots: ['/'] }),
    /filesystem root or the home directory/,
  );
  assert.throws(() => resolveConfig({ allowedUploadRoots: ['relative/path'] }), /absolute/);
});

test('uploads are disabled when no root is configured', async () => {
  const { outcome } = await attempt(['/tmp/anything'], []);
  assert.match(outcome, /disabled for this run/);
});
