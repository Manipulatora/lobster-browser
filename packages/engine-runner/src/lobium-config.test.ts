import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Fingerprint, ProxyConfig } from '@lobster/shared-types';
import {
  LOBIUM_CONFIG_FILENAME,
  LOBIUM_MAX_RENDERER_CONFIG_BASE64_BYTES,
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
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      extensions: ['ANGLE_instanced_arrays', 'WEBGL_debug_renderer_info'],
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
  assert.equal(config.webgl.version, 'WebGL 1.0 (OpenGL ES 2.0 Chromium)');
  assert.deepEqual(config.webgl.extensions, [
    'ANGLE_instanced_arrays',
    'WEBGL_debug_renderer_info',
  ]);
  assert.equal(config.locale.timezone, 'Europe/Berlin');
  // The font list reaches the engine now. It was previously held back because the browser base64s
  // this whole document onto the renderer command line, where a large catalog trips the size guard
  // and the browser drops the config entirely — a total host leak caused by a field no renderer
  // reads. The engine now strips `fonts`/`fontPackDir` from the renderer copy, so the browser-side
  // font hooks get the full list while the renderer payload is unchanged.
  assert.deepEqual(config.fonts, ['Arial', 'Calibri']);
  // Absent, not empty, when no pack is provisioned: the engine treats a missing key as "no pack" and
  // an empty string would be a path it then tries to enumerate.
  assert.equal(config.fontPackDir, undefined);
  assert.deepEqual(config.policy.renderer, { mode: 'host' });
  assert.deepEqual(config.policy.hardwareNoise, {
    webgl: true,
    canvas: true,
    audio: true,
    clientRects: false,
  });
  assert.deepEqual(config.policy.mediaDevices, {
    cameras: 1,
    microphones: 1,
    speakers: 2,
    stableDeviceIds: true,
  });
  assert.equal(config.seeds.clientRects, 0, 'clientRects noise off by default → seed 0');
});

test('buildLobiumConfig round-trips the deep WebGL surfaces the native reader consumes (HC-4)', () => {
  // These are the surfaces a detector cross-checks against the spoofed renderer: gl.VERSION,
  // SHADING_LANGUAGE_VERSION, getSupportedExtensions(), getShaderPrecisionFormat(). The sidecar must
  // serialize them verbatim so the native config-channel reader (lobium_fp_config) can apply them and
  // close the host-leak the battle test confirmed. A host-calibrated fingerprint carries all of them.
  const precisionStage = {
    lowFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
    mediumFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
    highFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
    lowInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
    mediumInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
    highInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
  };
  const withDeep: Fingerprint = {
    ...fp(),
    webgl: {
      ...fp().webgl,
      shadingLanguageVersion: 'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)',
      shaderPrecision: { vertex: precisionStage, fragment: precisionStage },
    },
  };
  const config = buildLobiumConfig(withDeep, { seed: 'deep' });
  assert.equal(
    config.webgl.shadingLanguageVersion,
    'WebGL GLSL ES 3.00 (OpenGL ES GLSL ES 3.0 Chromium)',
  );
  assert.deepEqual(config.webgl.shaderPrecision, {
    vertex: precisionStage,
    fragment: precisionStage,
  });
  // The whole webgl block must survive JSON serialization unchanged (what the native reader parses).
  assert.deepEqual(JSON.parse(JSON.stringify(config.webgl)), config.webgl);
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
  assert.notEqual(a.mediaDevices, b.mediaDevices, 'stable media IDs remain distinct per profile');
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

test('buildLobiumConfig carries explicit profile launch policy', () => {
  const config = buildLobiumConfig(fp(), {
    seed: 'policy',
    osVersion: 'Windows 11 23H2',
    webrtcPolicy: 'proxy_only',
    proxy: { type: 'http', host: 'proxy.example', port: 8080 },
    rendererPolicy: { mode: 'normalized_host' },
    hardwareNoise: { canvas: false, clientRects: true },
    mediaDevices: { cameras: 2, microphones: 1, speakers: 3, stableDeviceIds: false },
  });

  assert.equal(config.policy.osVersion, 'Windows 11 23H2');
  assert.equal(config.net.webrtcPolicy, 'proxy_only');
  assert.equal(config.policy.webrtc, 'proxy_only');
  assert.deepEqual(config.policy.renderer, { mode: 'normalized_host' });
  assert.deepEqual(config.policy.hardwareNoise, {
    webgl: true,
    canvas: false,
    audio: true,
    clientRects: true,
  });
  assert.equal(config.seeds.canvas, 0, 'canvas noise off → seed gated to 0');
  assert.ok(config.seeds.webgl > 0, 'webgl noise on → non-zero seed');
  assert.ok(config.seeds.audio > 0, 'audio noise on → non-zero seed');
  assert.ok(config.seeds.clientRects > 0, 'clientRects noise on → non-zero seed');
  assert.deepEqual(config.policy.mediaDevices, {
    cameras: 2,
    microphones: 1,
    speakers: 3,
    stableDeviceIds: false,
  });
});

test('buildLobiumConfig rejects proxy_only without a proxy', () => {
  assert.throws(
    () => buildLobiumConfig(fp(), { webrtcPolicy: 'proxy_only' }),
    /proxy_only policy requires a configured proxy/,
  );
});

test('buildLobiumConfig rejects host-leaking default WebRTC policy with a proxy', () => {
  assert.throws(
    () =>
      buildLobiumConfig(fp(), {
        webrtcPolicy: 'default_public_interface_only',
        proxy: { type: 'http', host: 'proxy.example', port: 8080 },
      }),
    /unsafe with a proxy/,
  );
});

test('hardware noise checkboxes gate farbling seeds', () => {
  const allOff = buildLobiumConfig(fp(), {
    seed: 'noise-off',
    hardwareNoise: { webgl: false, canvas: false, audio: false },
  });
  assert.deepEqual(
    {
      canvas: allOff.seeds.canvas,
      webgl: allOff.seeds.webgl,
      audio: allOff.seeds.audio,
      clientRects: allOff.seeds.clientRects,
    },
    { canvas: 0, webgl: 0, audio: 0, clientRects: 0 },
  );
  assert.ok(
    allOff.seeds.mediaDevices > 0,
    'media identity stays per-profile even when all hardware-noise surfaces are off',
  );
});

test('writeLobiumConfig rejects an oversized renderer payload instead of silently leaking host values', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobium-cfg-large-'));
  try {
    const config = buildLobiumConfig(fp(), { seed: 'large' });
    config.webgl.extensions = [`EXT_${'x'.repeat(LOBIUM_MAX_RENDERER_CONFIG_BASE64_BYTES)}`];
    await assert.rejects(
      () => writeLobiumConfig(dir, config),
      /too large for the renderer channel/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeLobiumConfig writes owner-only JSON that round-trips, and the flag points at it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobium-cfg-'));
  try {
    const config = buildLobiumConfig(fp(), { seed: 'w' });
    const path = await writeLobiumConfig(dir, config);
    assert.equal(path, join(dir, LOBIUM_CONFIG_FILENAME));
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), config);
    // Owner-only (0600) — a leaked-readable config could expose the profile identity.
    const mode = (await stat(path)).mode & 0o777;
    if (process.platform === 'win32') {
      // Windows has no POSIX mode bits. Confidentiality there is an NTFS ACL, and Node maps `mode`
      // onto the single read-only ATTRIBUTE, so this always reads back 0o666 — asserting 0o600 would
      // assert nothing. The product does not set an ACL either, so owner-only is NOT enforced on
      // Windows; it is merely inherited from the user-profile directory. Proving the real property
      // would take an `icacls <path>` check that no broad principal (Everyone, BUILTIN\Users,
      // Authenticated Users) is granted read. What IS assertable — and worth pinning — is that the
      // 0o600 request did not clear owner-write: that would set FILE_ATTRIBUTE_READONLY and break the
      // next launch's rewrite of this config.
      assert.equal(mode & 0o200, 0o200, 'the config must stay writable for the next launch');
    } else {
      assert.equal(mode, 0o600);
    }
    assert.equal(lobiumConfigArg(path), `--lobium-fp-config=${path}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
