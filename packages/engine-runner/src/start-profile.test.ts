import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  HostCalibrationProfile,
  LaunchParams,
  LaunchResult,
  StartProfileParams,
} from '@lobster/shared-types';
import type { EngineRunner } from './runner.js';
import { startProfile } from './start-profile.js';

/** Records launch() calls without spawning a browser, so the coherence gate is testable in isolation. */
class RecordingRunner implements EngineRunner {
  launched: LaunchParams[] = [];
  async launch(params: LaunchParams): Promise<LaunchResult> {
    this.launched.push(params);
    return { profileId: params.profileId, pid: 0, ws: 'ws://x', debuggerAddress: '127.0.0.1:1' };
  }
  async stop(): Promise<void> {}
  async status(): Promise<{ running: never[] }> {
    return { running: [] };
  }
}

const base: StartProfileParams = {
  profileId: 'p1',
  fingerprintSeed: 'seed-coherence',
  os: 'windows',
  engine: 'lobium',
  userDataDir: '/tmp/does-not-matter',
};

function hostCalibration(): HostCalibrationProfile {
  return {
    version: 1,
    capturedAt: '2026-07-08T12:00:00.000Z',
    os: 'windows',
    arch: 'x86_64',
    browserVersion: '152.0.7928.0',
    navigator: {
      platform: 'Win32',
      hardwareConcurrency: 12,
      deviceMemory: 64,
      maxTouchPoints: 0,
    },
    screen: {
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: 1400,
      availLeft: 0,
      availTop: 0,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unmaskedVendor: 'Google Inc. (NVIDIA)',
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      extensions: ['WEBGL_debug_renderer_info', 'ANGLE_instanced_arrays'],
    },
    fonts: ['Arial', 'Calibri', 'Segoe UI'],
    timezone: 'America/New_York',
  };
}

test('startProfile launches a coherent (unmodified) persona', async () => {
  const runner = new RecordingRunner();
  const res = await startProfile(runner, base);
  assert.equal(res.profileId, 'p1');
  assert.equal(runner.launched.length, 1, 'the coherent persona is launched');
});

test('startProfile carries UI launch policy fields to the runner', async () => {
  const runner = new RecordingRunner();
  await startProfile(runner, {
    ...base,
    osVersion: 'Windows 11 23H2',
    fingerprintOverrides: {
      webrtc: 'proxy_only',
      renderer: { mode: 'normalized_host' },
      hardwareNoise: { canvas: false, clientRects: true },
      mediaDevices: { cameras: 2, microphones: 1, speakers: 3, stableDeviceIds: false },
    },
    cookiesImport: { mode: 'merge', source: 'plain_text', rawText: 'cookie text', parsedCount: 1 },
    extensions: [{ source: 'chrome_web_store', enabled: true, url: 'https://example.test/ext' }],
  });

  const launched = runner.launched[0];
  assert.ok(launched);
  assert.equal(launched.osVersion, 'Windows 11 23H2');
  assert.equal(launched.webrtcPolicy, 'proxy_only');
  assert.deepEqual(launched.fingerprintPolicy?.renderer, { mode: 'normalized_host' });
  assert.equal(launched.fingerprintPolicy?.hardwareNoise.webgl, true, 'default preserved');
  assert.equal(launched.fingerprintPolicy?.hardwareNoise.canvas, false);
  assert.equal(launched.fingerprintPolicy?.hardwareNoise.clientRects, true);
  assert.deepEqual(launched.fingerprintPolicy?.mediaDevices, {
    cameras: 2,
    microphones: 1,
    speakers: 3,
    stableDeviceIds: false,
  });
  assert.equal(launched.cookiesImport?.parsedCount, 1);
  assert.equal(launched.extensions?.[0]?.source, 'chrome_web_store');
});

test('startProfile derives from host calibration when one is supplied', async () => {
  const runner = new RecordingRunner();
  await startProfile(runner, {
    ...base,
    hostCalibration: hostCalibration(),
  });

  const launched = runner.launched[0];
  assert.ok(launched);
  assert.equal(launched.fingerprint.webgl.renderer, hostCalibration().webgl.renderer);
  assert.deepEqual(launched.fingerprint.webgl.extensions, [
    'WEBGL_debug_renderer_info',
    'ANGLE_instanced_arrays',
  ]);
  assert.equal(launched.fingerprint.navigator.hardwareConcurrency, 12);
  assert.equal(launched.fingerprint.navigator.deviceMemory, 8, 'host RAM is spec-capped');
  assert.equal(launched.fingerprint.navigator.uaFullVersion, '152.0.7928.0');
});

test('startProfile uses a PERSISTED host profile as the default when captured (HC-3)', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'hc-store-'));
  const file = join(dir, 'host-calibration.json');
  await writeFile(file, JSON.stringify(hostCalibration()));
  const prev = process.env.LOBSTER_HOST_CALIBRATION_FILE;
  process.env.LOBSTER_HOST_CALIBRATION_FILE = file;
  try {
    const runner = new RecordingRunner();
    // No explicit hostCalibration in params — the persisted file must become the default source.
    await startProfile(runner, base);
    const launched = runner.launched[0];
    assert.ok(launched);
    assert.equal(launched.fingerprint.webgl.renderer, hostCalibration().webgl.renderer);
    assert.deepEqual(launched.fingerprint.webgl.extensions, [
      'WEBGL_debug_renderer_info',
      'ANGLE_instanced_arrays',
    ]);
  } finally {
    if (prev === undefined) delete process.env.LOBSTER_HOST_CALIBRATION_FILE;
    else process.env.LOBSTER_HOST_CALIBRATION_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('startProfile ignores a persisted host profile whose OS differs (falls back to catalog)', async () => {
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'hc-store-'));
  const file = join(dir, 'host-calibration.json');
  const host = hostCalibration();
  host.os = 'linux'; // profile is windows → must NOT use this host profile
  await writeFile(file, JSON.stringify(host));
  const prev = process.env.LOBSTER_HOST_CALIBRATION_FILE;
  process.env.LOBSTER_HOST_CALIBRATION_FILE = file;
  try {
    const runner = new RecordingRunner();
    await startProfile(runner, base); // windows profile
    const launched = runner.launched[0];
    assert.ok(launched, 'falls back to the catalog path and still launches');
  } finally {
    if (prev === undefined) delete process.env.LOBSTER_HOST_CALIBRATION_FILE;
    else process.env.LOBSTER_HOST_CALIBRATION_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('startProfile rejects a host calibration for the wrong desktop OS', async () => {
  const runner = new RecordingRunner();
  const host = hostCalibration();
  host.os = 'linux';

  await assert.rejects(
    startProfile(runner, { ...base, hostCalibration: host }),
    /host calibration OS "linux" does not match profile OS "windows"/,
  );
  assert.equal(runner.launched.length, 0);
});

test('startProfile rejects invalid host calibration before launch', async () => {
  const runner = new RecordingRunner();
  const host = hostCalibration();
  host.webgl.vendor = 'Mesa';
  host.webgl.renderer = 'llvmpipe (LLVM 20.1.2, 256 bits)';

  await assert.rejects(
    startProfile(runner, { ...base, hostCalibration: host }),
    /invalid host calibration.*software renderer/s,
  );
  assert.equal(runner.launched.length, 0);
});

test('startProfile REFUSES an incoherent persona from user overrides (fail-closed)', async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    // maxTouchPoints=5 on a desktop OS is an impossible device — a trivial bot tell.
    startProfile(runner, { ...base, fingerprintOverrides: { navigator: { maxTouchPoints: 5 } } }),
    /incoherent fingerprint.*maxTouchPoints/s,
  );
  assert.equal(runner.launched.length, 0, 'an incoherent persona must never reach the engine');
});
