import assert from 'node:assert/strict';
import test from 'node:test';
import { buildDevShmArgs, MIN_CHROMIUM_DEV_SHM_BYTES } from './dev-shm.js';

test('keeps renderer/GPU shared memory on a sufficiently large Linux tmpfs', () => {
  assert.deepEqual(
    buildDevShmArgs({ platform: 'linux', env: {}, availableBytes: 24 * 1024 ** 3 }),
    [],
  );
});

test('uses Chromium temporary-directory fallback for a small or unreadable shm mount', () => {
  assert.deepEqual(
    buildDevShmArgs({
      platform: 'linux',
      env: {},
      availableBytes: MIN_CHROMIUM_DEV_SHM_BYTES - 1,
    }),
    ['--disable-dev-shm-usage'],
  );
  assert.deepEqual(buildDevShmArgs({ platform: 'linux', env: {}, availableBytes: null }), [
    '--disable-dev-shm-usage',
  ]);
});

test('supports explicit operational overrides and never emits the Linux flag elsewhere', () => {
  assert.deepEqual(
    buildDevShmArgs({
      platform: 'linux',
      env: { LOBSTER_DISABLE_DEV_SHM_USAGE: '1' },
      availableBytes: 24 * 1024 ** 3,
    }),
    ['--disable-dev-shm-usage'],
  );
  assert.deepEqual(
    buildDevShmArgs({
      platform: 'linux',
      env: { LOBSTER_DISABLE_DEV_SHM_USAGE: '0' },
      availableBytes: 64 * 1024 ** 2,
    }),
    [],
  );
  assert.deepEqual(buildDevShmArgs({ platform: 'darwin', env: {}, availableBytes: 0 }), []);
});
