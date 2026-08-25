import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import {
  MANAGED_ENGINE_BIN_ORIGIN_ENV,
  MANAGED_ENGINE_SHA256_ENV,
  MANAGED_ENGINE_VERSION_ENV,
  isManagedLobiumBinPublication,
  managedLobiumBinaryPath,
  resolveManagedLobiumBinary,
} from './managed-engine.js';

test('managed binary origin attestation is a Windows-only sidecar contract', () => {
  const env = { [MANAGED_ENGINE_BIN_ORIGIN_ENV]: 'managed' };
  assert.equal(isManagedLobiumBinPublication(env, 'win32'), true);
  assert.equal(isManagedLobiumBinPublication(env, 'linux'), false);
});

test('managed Windows runtime requires the exact desktop-attested source stamp', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobium-managed-'));
  const env: NodeJS.ProcessEnv = {
    LOCALAPPDATA: root,
    [MANAGED_ENGINE_VERSION_ENV]: '152.0.7977.42',
    [MANAGED_ENGINE_SHA256_ENV]: 'a'.repeat(64),
  };
  const binary = managedLobiumBinaryPath(env, root, 'win32');
  assert.ok(binary);
  await mkdir(dirname(binary), { recursive: true });
  await writeFile(binary, 'browser');
  const resolve = () => resolveManagedLobiumBinary({ env, homeDir: root, platform: 'win32' });

  try {
    assert.equal(resolve(), undefined, 'a binary without its source stamp is not provisioned');
    await writeFile(
      join(dirname(binary), '.lobium-engine-version'),
      `version=152.0.7977.42\nsha256=${'a'.repeat(64)}\n`,
    );
    assert.equal(resolve(), binary);

    await writeFile(
      join(dirname(binary), '.lobium-engine-version'),
      `version=152.0.7977.42\r\nsha256=${'a'.repeat(64)}\r\n`,
    );
    assert.equal(resolve(), undefined, 'CRLF is not byte-exact to the Rust source stamp');

    await writeFile(
      join(dirname(binary), '.lobium-engine-version'),
      `version=152.0.7977.42\nsha256=${'b'.repeat(64)}\n`,
    );
    assert.equal(
      resolve(),
      undefined,
      'same Chromium version with different archive bytes is stale',
    );

    delete env[MANAGED_ENGINE_VERSION_ENV];
    delete env[MANAGED_ENGINE_SHA256_ENV];
    assert.equal(resolve(), undefined, 'no Windows manifest expectation denies the canonical path');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('managed SHA expectation is lowercase canonical hex', () => {
  const env: NodeJS.ProcessEnv = {
    LOCALAPPDATA: 'C:\\managed-test',
    [MANAGED_ENGINE_VERSION_ENV]: '152.0.7977.42',
    [MANAGED_ENGINE_SHA256_ENV]: 'A'.repeat(64),
  };
  assert.equal(
    resolveManagedLobiumBinary({
      env,
      platform: 'win32',
      homeDir: 'C:\\home',
      isExecutableFile: () => true,
      readFile: () => Buffer.alloc(0),
    }),
    undefined,
  );
});
