import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprint, ProxyConfig } from '@lobster/shared-types';
import {
  LOBIUM_CONFIG_FILENAME,
  LOBIUM_CONFIG_VERSION,
  buildLobiumConfig,
  lobiumConfigArg,
  writeLobiumConfig,
} from './lib.js';

function fp(): Fingerprint {
  return {
    os: 'windows',
    arch: 'x86_64',
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['de-DE', 'de'],
      hardwareConcurrency: 12,
      deviceMemory: 8,
      maxTouchPoints: 0,
      uaBrands: [{ brand: 'Chromium', version: '131' }],
      uaPlatform: 'Windows',
      uaPlatformVersion: '15.0.0',
      uaMobile: false,
      uaFullVersion: '131.0.0.0',
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, RTX 3060 Direct3D11)',
      unmaskedVendor: 'Google Inc. (NVIDIA)',
      unmaskedRenderer: 'ANGLE (NVIDIA, RTX 3060 Direct3D11)',
    },
    locale: { timezone: 'Europe/Berlin', locale: 'de-DE', acceptLanguage: 'de-DE,de;q=0.9' },
    fonts: ['Arial', 'Calibri'],
  };
}

test('buildLobiumConfig carries the fingerprint surfaces + a version', () => {
  const config = buildLobiumConfig(fp(), { seed: 's' });
  assert.equal(config.version, LOBIUM_CONFIG_VERSION);
  assert.equal(config.navigator.userAgent, fp().navigator.userAgent);
  assert.equal(config.webgl.renderer, fp().webgl.renderer);
  assert.equal(config.locale.timezone, 'Europe/Berlin');
  assert.deepEqual(config.fonts, ['Arial', 'Calibri']);
});

test('farbling seeds are deterministic per (seed) and differ across seeds', () => {
  const a = buildLobiumConfig(fp(), { seed: 'profile-1' }).seeds;
  const a2 = buildLobiumConfig(fp(), { seed: 'profile-1' }).seeds;
  const b = buildLobiumConfig(fp(), { seed: 'profile-2' }).seeds;
  assert.deepEqual(a, a2, 'stable per profile across launches');
  assert.notDeepEqual(a, b, 'different profiles get different farbling');
  for (const v of [a.canvas, a.webgl, a.audio]) {
    assert.ok(Number.isInteger(v) && v >= 0, 'seeds are uint32');
  }
  assert.notEqual(a.canvas, a.webgl, 'per-surface seeds are independent');
});

test('WebRTC policy is proxy-aware, and proxy config carries NO credentials', () => {
  assert.equal(buildLobiumConfig(fp()).net.webrtcPolicy, 'default_public_interface_only');

  const proxy: ProxyConfig = {
    id: 'x',
    type: 'socks5',
    host: 'h.example',
    port: 1080,
    username: 'user',
    password: 'secret',
  };
  const withProxy = buildLobiumConfig(fp(), { proxy });
  assert.equal(withProxy.net.webrtcPolicy, 'disable_non_proxied_udp');
  assert.deepEqual(withProxy.net.proxy, { type: 'socks5', host: 'h.example', port: 1080 });
  // The credential must never reach the config document.
  assert.ok(!JSON.stringify(withProxy).includes('secret'), 'proxy password must not be serialized');
});

test('writeLobiumConfig writes owner-only JSON that round-trips, and the flag points at it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobium-cfg-'));
  try {
    const config = buildLobiumConfig(fp(), { seed: 'w' });
    const path = await writeLobiumConfig(dir, config);
    assert.equal(path, join(dir, LOBIUM_CONFIG_FILENAME));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
    // Owner-only (0600) — a leaked-readable config could expose the profile identity.
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(lobiumConfigArg(path), `--lobium-fp-config=${path}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
