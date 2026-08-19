import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAndroidFingerprint } from '@lobster/fingerprint';
import type { ProxyConfig } from '@lobster/shared-types';
import {
  ANDROID_LOBIUM_CONFIG_FILENAME,
  ANDROID_LOBIUM_CONFIG_VERSION,
  buildAndroidLobiumConfig,
  writeAndroidLobiumConfig,
} from './lib.js';

test('buildAndroidLobiumConfig carries Android identity + mobile UA-CH model', () => {
  const fp = deriveAndroidFingerprint('android-config-shape', { engine: 'lobium' });
  const config = buildAndroidLobiumConfig(fp, { seed: 'profile-a' });

  assert.equal(config.version, ANDROID_LOBIUM_CONFIG_VERSION);
  assert.equal(config.target, 'android');
  assert.equal(config.arch, 'arm64');
  assert.equal(config.android.model, fp.android.model);
  assert.equal(config.android.buildFingerprint, fp.android.buildFingerprint);
  assert.equal(config.navigator.uaMobile, true);
  assert.equal(config.navigator.uaModel, fp.android.model);
  assert.equal(config.screen.width, fp.screen.width);
  assert.equal(config.webgl.renderer, fp.webgl.renderer);
  assert.ok(config.fonts.includes('Roboto'));
  assert.deepEqual(config.policy.renderer, {
    mode: 'validated_preset',
    presetId: `android:${fp.android.model}`,
  });
  assert.equal(config.policy.androidRunner.configDelivery, 'adb-external-app-files');
  assert.equal(config.policy.androidRunner.cdp, 'localabstract');
});

test('Android farbling seeds are stable per profile seed and differ across seeds', () => {
  const fp = deriveAndroidFingerprint('same-android-device', { engine: 'lobium' });
  const a = buildAndroidLobiumConfig(fp, { seed: 'profile-1' }).seeds;
  const a2 = buildAndroidLobiumConfig(fp, { seed: 'profile-1' }).seeds;
  const b = buildAndroidLobiumConfig(fp, { seed: 'profile-2' }).seeds;

  assert.deepEqual(a, a2);
  assert.notDeepEqual(a, b);
  assert.notEqual(a.canvas, a.webgl);
  assert.notEqual(a.webgl, a.audio);
});

test('Android hardware-noise switches gate their matching seeds without collapsing media identity', () => {
  const fp = deriveAndroidFingerprint('android-noise-gates', { engine: 'lobium' });
  const config = buildAndroidLobiumConfig(fp, {
    seed: 'profile-noise-off',
    hardwareNoise: { canvas: false, webgl: false, audio: false, clientRects: false },
  });
  assert.equal(config.seeds.canvas, 0);
  assert.equal(config.seeds.webgl, 0);
  assert.equal(config.seeds.audio, 0);
  assert.equal(config.seeds.clientRects, 0);
  assert.ok(config.seeds.mediaDevices > 0);
});

test('Android config is proxy-aware but never serializes proxy credentials', () => {
  const fp = deriveAndroidFingerprint('android-proxy-config', { engine: 'lobium' });
  const proxy: ProxyConfig = {
    id: 'p',
    type: 'socks5',
    host: 'proxy.example',
    port: 1080,
    username: 'u',
    password: 'secret',
  };
  const config = buildAndroidLobiumConfig(fp, { proxy });

  assert.equal(config.net.webrtcPolicy, 'disable_non_proxied_udp');
  assert.deepEqual(config.net.proxy, { type: 'socks5', host: 'proxy.example', port: 1080 });
  assert.ok(!JSON.stringify(config).includes('secret'));
  assert.ok(!JSON.stringify(config).includes('"username"'));
});

test('writeAndroidLobiumConfig writes owner-only JSON that round-trips', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'android-lobium-cfg-'));
  try {
    const config = buildAndroidLobiumConfig(
      deriveAndroidFingerprint('android-write-config', { engine: 'lobium' }),
      { seed: 'write' },
    );
    const path = await writeAndroidLobiumConfig(dir, config);

    assert.equal(path, join(dir, ANDROID_LOBIUM_CONFIG_FILENAME));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
    const mode = (await stat(path)).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows maps `mode` onto the read-only ATTRIBUTE only, so this always reads back 0o666 and
      // 0o600 would assert nothing. Owner-only is NOT enforced on Windows — that needs an NTFS ACL
      // the product never sets, verifiable only via `icacls <path>`. Assert what the platform does
      // express: the write bit survived, so the next launch can rewrite the config.
      assert.equal(mode & 0o200, 0o200, 'the config must stay writable for the next launch');
    } else {
      assert.equal(mode, 0o600);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
