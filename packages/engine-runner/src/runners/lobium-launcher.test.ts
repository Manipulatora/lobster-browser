import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveFingerprint } from '@lobster/fingerprint';
import { LOBIUM_CONFIG_FILENAME } from '../lobium-config.js';
import {
  buildLobiumLaunchArgs,
  createLobiumLauncher,
  isLobiumAvailable,
  proxySummaryFromServer,
  resolveLobiumBinary,
} from './lobium-launcher.js';
import type { LaunchContext } from './types.js';

const fp = deriveFingerprint('seed-lobium-test', { os: 'windows', engine: 'lobium' });

function ctxWith(userDataDir: string, proxy?: { server: string }): LaunchContext {
  return {
    profileId: 'p',
    engine: 'lobium',
    fingerprint: fp,
    options: { userDataDir, headless: false, args: [], ...(proxy ? { proxy } : {}) },
    emulation: {},
    initScript: '',
  } as unknown as LaunchContext;
}

test('resolveLobiumBinary / isLobiumAvailable follow LOBSTER_LOBIUM_BIN', async () => {
  const prev = process.env.LOBSTER_LOBIUM_BIN;
  try {
    delete process.env.LOBSTER_LOBIUM_BIN;
    assert.equal(resolveLobiumBinary(), undefined);
    assert.equal(isLobiumAvailable(), false);

    process.env.LOBSTER_LOBIUM_BIN = '/no/such/lobium/binary';
    assert.equal(resolveLobiumBinary(), undefined, 'a non-existent path is not "available"');

    // Point at a real file (this test file) to prove the existsSync gate.
    const real = await mkdtemp(join(tmpdir(), 'lobium-bin-'));
    const binPath = join(real, 'chrome');
    await writeFile(binPath, '#!/bin/true\n', { mode: 0o755 });
    process.env.LOBSTER_LOBIUM_BIN = binPath;
    assert.equal(resolveLobiumBinary(), binPath);
    assert.equal(isLobiumAvailable(), true);
    await rm(real, { recursive: true, force: true });
  } finally {
    if (prev === undefined) delete process.env.LOBSTER_LOBIUM_BIN;
    else process.env.LOBSTER_LOBIUM_BIN = prev;
  }
});

test('createLobiumLauncher throws when the binary is not provisioned', () => {
  const prev = process.env.LOBSTER_LOBIUM_BIN;
  try {
    delete process.env.LOBSTER_LOBIUM_BIN;
    assert.throws(() => createLobiumLauncher(), /LOBSTER_LOBIUM_BIN/);
  } finally {
    if (prev !== undefined) process.env.LOBSTER_LOBIUM_BIN = prev;
  }
});

test('proxySummaryFromServer parses type/host/port and rejects garbage', () => {
  assert.deepEqual(proxySummaryFromServer('http://1.2.3.4:8080'), {
    type: 'http',
    host: '1.2.3.4',
    port: 8080,
  });
  assert.deepEqual(proxySummaryFromServer('socks5://proxy.example:1080'), {
    type: 'socks5',
    host: 'proxy.example',
    port: 1080,
  });
  assert.equal(proxySummaryFromServer('not-a-url'), undefined);
  assert.equal(proxySummaryFromServer('http://host-without-port'), undefined);
});

test('buildLobiumLaunchArgs writes lobium-fp.json and returns the --lobium-fp-config flag', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-udd-'));
  try {
    const args = await buildLobiumLaunchArgs(ctxWith(userDataDir));
    const configPath = join(userDataDir, LOBIUM_CONFIG_FILENAME);
    assert.deepEqual(args, [`--lobium-fp-config=${configPath}`]);

    const written = JSON.parse(await readFile(configPath, 'utf8'));
    assert.equal(written.version, 1);
    // The native surfaces the config drives are present + match the resolved fingerprint.
    assert.equal(written.navigator.userAgent, fp.navigator.userAgent);
    assert.equal(written.screen.width, fp.screen.width);
    assert.equal(written.webgl.renderer, fp.webgl.renderer);
    // Farbling seeds are present (uint32) and deterministic across builds of the same fingerprint.
    for (const k of ['canvas', 'webgl', 'audio'] as const) {
      assert.equal(typeof written.seeds[k], 'number');
    }
    const again = JSON.parse(await readFile(configPath, 'utf8'));
    assert.deepEqual(again.seeds, written.seeds, 'seeds are stable per profile');
    // No proxy → default WebRTC policy, no proxy summary.
    assert.equal(written.net.webrtcPolicy, 'default_public_interface_only');
    assert.equal(written.net.proxy, undefined);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('buildLobiumLaunchArgs records the proxy WebRTC policy + non-secret summary (no creds)', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-udd-'));
  try {
    await buildLobiumLaunchArgs(
      ctxWith(userDataDir, { server: 'socks5://10.0.0.9:1080' }),
    );
    const written = JSON.parse(await readFile(join(userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8'));
    assert.equal(written.net.webrtcPolicy, 'disable_non_proxied_udp', 'proxied → suppress non-proxied UDP');
    assert.deepEqual(written.net.proxy, { type: 'socks5', host: '10.0.0.9', port: 1080 });
    // The config file must never carry proxy credentials.
    const raw = await readFile(join(userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8');
    assert.ok(!/username|password/.test(raw), 'no credentials in the config file');
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
