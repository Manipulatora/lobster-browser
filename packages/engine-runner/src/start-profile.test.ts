import assert from 'node:assert/strict';
import test from 'node:test';
import type {
  HostCalibrationProfile,
  LaunchParams,
  LaunchResult,
  StartProfileParams,
} from '@lobster/shared-types';
import type { EngineRunner } from './runner.js';
import { WINDOWS_RENDERER_PRESETS } from '@lobster/fingerprint';
import {
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
  type LobiumBuildCapabilities,
} from './lobium-capabilities.js';
import { startProfile } from './start-profile.js';

/** Records launch() calls without spawning a browser, so the coherence gate is testable in isolation. */
class RecordingRunner implements EngineRunner {
  launched: LaunchParams[] = [];
  capabilities: LobiumBuildCapabilities = {
    contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
    product: 'Lobium',
    capabilities: [...LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES],
  };
  async getLobiumBuildCapabilities(): Promise<LobiumBuildCapabilities> {
    return this.capabilities;
  }
  async launch(params: LaunchParams): Promise<LaunchResult> {
    this.launched.push(params);
    return { profileId: params.profileId, pid: 0, ws: 'ws://x', debuggerAddress: '127.0.0.1:1' };
  }
  async stop(): Promise<void> {}
  async status(): Promise<{ running: never[] }> {
    return { running: [] };
  }
  async exportCookies(profileId: string): Promise<{ profileId: string; json: string }> {
    return { profileId, json: '[]' };
  }
}

const base: StartProfileParams = {
  profileId: 'p1',
  fingerprintSeed: 'seed-coherence',
  os: 'windows',
  engine: 'lobium',
  userDataDir: '/tmp/does-not-matter',
  hostCalibration: hostCalibration(),
};

function withoutHostCalibration(
  params: StartProfileParams = base,
): Omit<StartProfileParams, 'hostCalibration'> {
  const clone = { ...params };
  delete clone.hostCalibration;
  return clone;
}

function precisionStage() {
  const float = { rangeMin: 127, rangeMax: 127, precision: 23 };
  const integer = { rangeMin: 31, rangeMax: 30, precision: 0 };
  return {
    lowFloat: { ...float },
    mediumFloat: { ...float },
    highFloat: { ...float },
    lowInt: { ...integer },
    mediumInt: { ...integer },
    highInt: { ...integer },
  };
}

function hostCalibration(
  os: 'windows' | 'macos' | 'linux' = 'windows',
  arch: 'x86_64' | 'arm64' = 'x86_64',
): HostCalibrationProfile {
  const isMac = os === 'macos';
  const renderer = isMac
    ? 'ANGLE (Apple, ANGLE Metal Renderer: Apple M2, Unspecified Version)'
    : 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  const vendor = isMac ? 'Google Inc. (Apple)' : 'Google Inc. (NVIDIA)';
  return {
    version: 1,
    capturedAt: '2026-07-08T12:00:00.000Z',
    os,
    arch,
    browserVersion: '152.0.7977.42',
    navigator: {
      platform: isMac ? 'MacIntel' : os === 'linux' ? 'Linux x86_64' : 'Win32',
      languages: ['en-US', 'en'],
      locale: 'en-US',
      hardwareConcurrency: 12,
      deviceMemory: 64,
      maxTouchPoints: 0,
    },
    screen: {
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: isMac ? 1415 : 1400,
      availLeft: 0,
      availTop: isMac ? 25 : 0,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: {
      vendor,
      renderer,
      unmaskedVendor: vendor,
      unmaskedRenderer: renderer,
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      extensions: ['WEBGL_debug_renderer_info', 'ANGLE_instanced_arrays'],
      caps: {
        maxTextureSize: 16384,
        maxCubeMapTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDims: [16384, 16384],
        maxVertexAttribs: 16,
        maxVertexUniformVectors: 4096,
        maxFragmentUniformVectors: 1024,
        maxVaryingVectors: 30,
        maxTextureImageUnits: 16,
        maxVertexTextureImageUnits: 16,
        maxCombinedTextureImageUnits: 32,
        aliasedLineWidthRange: [1, 1],
        aliasedPointSizeRange: [1, 1024],
      },
      shaderPrecision: { vertex: precisionStage(), fragment: precisionStage() },
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
      webrtc: 'disabled',
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
  assert.equal(launched.webrtcPolicy, 'disabled');
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
  assert.equal(
    launched.fingerprint.navigator.uaPlatformVersion,
    '15.0.0',
    'persisted Windows 11 selection is authoritative for UA-CH',
  );
});

test('startProfile applies edited Windows/macOS version labels even without a matching override', async () => {
  const windows = new RecordingRunner();
  await startProfile(windows, { ...base, osVersion: 'Windows 10' });
  assert.equal(windows.launched[0]?.fingerprint.navigator.uaPlatformVersion, '10.0.0');

  const mac = new RecordingRunner();
  await startProfile(mac, {
    ...base,
    os: 'macos',
    arch: 'arm64',
    osVersion: 'macOS 15 Sequoia',
    hostCalibration: hostCalibration('macos', 'arm64'),
  });
  assert.equal(mac.launched[0]?.fingerprint.navigator.uaPlatformVersion, '15.0.0');
});

test('WebRTC Based on IP does not accidentally block direct profiles without a proxy', async () => {
  const runner = new RecordingRunner();
  await startProfile(runner, {
    ...base,
    fingerprintOverrides: { webrtcMode: 'based_ip', webrtc: 'proxy_only' },
  });
  assert.equal(runner.launched[0]?.webrtcPolicy, 'default_public_interface_only');
});

test('startProfile rejects proxy_only WebRTC without a proxy before launch', async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    startProfile(runner, {
      ...base,
      fingerprintOverrides: { webrtc: 'proxy_only' },
    }),
    /proxy_only policy requires a configured proxy/,
  );
  assert.equal(runner.launched.length, 0);
});

test('startProfile rejects host-leaking default WebRTC policy on a proxied profile', async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    startProfile(runner, {
      ...base,
      proxy: { id: 'p', type: 'http', host: 'proxy.example', port: 8080 },
      fingerprintOverrides: { webrtc: 'default_public_interface_only' },
    }),
    /unsafe with a proxy/,
  );
  assert.equal(runner.launched.length, 0);
});

test('renderer policies fail closed without complete evidence', async () => {
  // An EXPLICIT host policy is an assertion of measured evidence, so a missing calibration is still
  // a refusal. (The DEFAULTED policy no longer refuses — see the test below.)
  const hostRunner = new RecordingRunner();
  await assert.rejects(
    startProfile(hostRunner, {
      ...withoutHostCalibration(),
      fingerprintOverrides: { renderer: { mode: 'host' } },
    }),
    /renderer policy "host" requires a complete compatible host calibration/,
  );

  const presetRunner = new RecordingRunner();
  await assert.rejects(
    startProfile(presetRunner, {
      ...withoutHostCalibration(),
      fingerprintOverrides: {
        renderer: { mode: 'validated_preset', presetId: 'windows-nvidia-10de-2503' },
      },
    }),
    /is not present in the sourced GPU catalog/,
  );
});

test('a DEFAULTED host policy falls back to the catalog instead of refusing', async () => {
  // The product's core case: a Windows persona on a Linux machine, where a host capture can never
  // match by construction. Refusing here made every seed-derived cross-OS profile unlaunchable,
  // which is what users hit as "I cannot open any created profiles".
  const runner = new RecordingRunner();
  const params = withoutHostCalibration();
  assert.equal(
    params.fingerprintOverrides?.renderer,
    undefined,
    'this test is only meaningful while the renderer policy is defaulted, not chosen',
  );
  await startProfile(runner, params);
  const launched = runner.launched.at(-1);
  assert.ok(launched, 'the launch must proceed');
  assert.ok(
    launched.fingerprint.webgl.renderer.length > 0,
    'it must carry a real catalog renderer for the persona OS, not an empty surface',
  );
});

test('a restored sourced renderer preset launches with its complete WebGL surface', async () => {
  const preset = WINDOWS_RENDERER_PRESETS[0];
  assert.ok(preset);
  const runner = new RecordingRunner();
  await startProfile(runner, {
    ...withoutHostCalibration(),
    fingerprintOverrides: {
      renderer: { mode: 'validated_preset', presetId: preset.id },
      webgl: preset.webgl,
    },
  });
  assert.equal(runner.launched.length, 1);
  assert.equal(runner.launched[0]?.fingerprint.webgl.renderer, preset.webgl.renderer);
  assert.deepEqual(runner.launched[0]?.fingerprint.webgl.caps, preset.webgl.caps);
});

test('startProfile rejects a selected native policy when the exact build lacks its hook', async () => {
  const runner = new RecordingRunner();
  runner.capabilities = {
    ...runner.capabilities,
    capabilities: runner.capabilities.capabilities.filter(
      (capability) => capability !== 'client-rects',
    ),
  };
  await assert.rejects(
    startProfile(runner, {
      ...base,
      fingerprintOverrides: { hardwareNoise: { clientRects: true } },
    }),
    /lacks required native fingerprint hooks: client-rects/,
  );
  assert.equal(runner.launched.length, 0);
});

test('startProfile rejects unsafe media-device counts from untyped persisted JSON', async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    startProfile(runner, {
      ...base,
      fingerprintOverrides: { mediaDevices: { cameras: 50_000 } },
    }),
    /mediaDevices\.cameras must be an integer in 0-16/,
  );
  assert.equal(runner.launched.length, 0);
});

test('startProfile honors a requested macOS architecture from complete host calibration', async () => {
  const runner = new RecordingRunner();
  await startProfile(runner, {
    ...base,
    os: 'macos',
    arch: 'arm64',
    hostCalibration: hostCalibration('macos', 'arm64'),
  });

  const launched = runner.launched[0];
  assert.ok(launched);
  assert.equal(launched.fingerprint.arch, 'arm64');
  assert.match(launched.fingerprint.webgl.renderer, /Apple M\d/);
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
  assert.equal(
      launched.fingerprint.navigator.deviceMemory,
      32,
      'a large host clamps to the DESKTOP maximum of 32, not the retired cap of 8',
    );
  assert.equal(launched.fingerprint.navigator.uaFullVersion, '152.0.7977.42');
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
    await startProfile(runner, withoutHostCalibration());
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

test('a persisted host calibration must NOT override an explicitly requested validated_preset (regression)', async () => {
  // Found by a 20-profile fleet battle test: every Linux fixture reported the real host SwiftShader
  // renderer on Sannysoft instead of its requested NVIDIA/AMD/Intel preset. Root cause: the persisted-
  // calibration auto-load ran whenever a compatible file existed for the profile's OS, regardless of
  // the requested renderer mode, so a `validated_preset` profile silently took the host-derived
  // fingerprint's webgl instead of the chosen preset's.
  const { mkdtemp, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'hc-preset-'));
  const file = join(dir, 'host-calibration.json');
  await writeFile(file, JSON.stringify(hostCalibration()));
  const prev = process.env.LOBSTER_HOST_CALIBRATION_FILE;
  process.env.LOBSTER_HOST_CALIBRATION_FILE = file;
  try {
    const preset = WINDOWS_RENDERER_PRESETS[0];
    assert.ok(preset);
    const runner = new RecordingRunner();
    await startProfile(runner, {
      ...withoutHostCalibration(),
      fingerprintOverrides: {
        renderer: { mode: 'validated_preset', presetId: preset.id },
        webgl: preset.webgl,
      },
    });
    const launched = runner.launched[0];
    assert.ok(launched);
    assert.equal(launched.fingerprint.webgl.renderer, preset.webgl.renderer);
    assert.notEqual(launched.fingerprint.webgl.renderer, hostCalibration().webgl.renderer);
  } finally {
    if (prev === undefined) delete process.env.LOBSTER_HOST_CALIBRATION_FILE;
    else process.env.LOBSTER_HOST_CALIBRATION_FILE = prev;
    await rm(dir, { recursive: true, force: true });
  }
});

test('startProfile refuses host renderer mode when persisted calibration is incompatible', async () => {
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
    // The invariant is that an incompatible host profile is never USED — a Linux capture must not
    // dress a Windows persona. It used to be expressed as a refusal; with a defaulted policy the
    // launch now proceeds on the catalog instead, so assert the property rather than the throw.
    await startProfile(runner, withoutHostCalibration());
    const launched = runner.launched.at(-1);
    assert.ok(launched, 'a defaulted policy launches rather than refusing');
    assert.notEqual(
      launched.fingerprint.webgl.renderer,
      host.webgl.renderer,
      'the incompatible Linux host renderer must never reach a Windows persona',
    );
    assert.equal(launched.fingerprint.os, 'windows');
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

test('startProfile fail-closes when the proxy TCP endpoint is unreachable', async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    startProfile(runner, {
      ...base,
      proxy: {
        id: 'dead-proxy',
        type: 'socks5',
        host: '127.0.0.1',
        port: 1,
        username: 'u',
        password: 'p',
      },
    }),
    /proxy 127\.0\.0\.1:1 is unreachable/,
  );
  assert.equal(runner.launched.length, 0, 'unreachable proxy must never reach the engine');
});

test('a Based on IP persona with no proxy resolves against the DIRECT exit IP', async () => {
  // Replaces a refusal. The editor defaults language/timezone/geolocation to Based on IP, so the old
  // gate made a profile created with default settings unlaunchable until a proxy was attached — the
  // single most common failure users hit. A direct profile does have an exit IP: this machine's.
  //
  // The lookup is networked, so this asserts the LAUNCH is no longer blocked rather than asserting a
  // particular country; whether geo resolves is environment-dependent and best-effort by design.
  const runner = new RecordingRunner();
  await startProfile(runner, {
    ...base,
    fingerprintOverrides: {
      languageMode: 'based_ip',
      timezoneMode: 'based_ip',
      geolocationMode: 'manual',
    },
  });
  assert.equal(runner.launched.length, 1, 'no proxy must no longer prevent a launch');

  const one = new RecordingRunner();
  await startProfile(one, { ...base, fingerprintOverrides: { geolocationMode: 'based_ip' } });
  assert.equal(one.launched.length, 1);
});

test('startProfile still launches a fully manual persona without a proxy', async () => {
  const runner = new RecordingRunner();
  await startProfile(runner, {
    ...base,
    fingerprintOverrides: {
      languageMode: 'manual',
      timezoneMode: 'manual',
      geolocationMode: 'manual',
    },
  });
  assert.equal(runner.launched.length, 1);
});

test('startProfile refuses a build without the navigator/UA-CH hook', async () => {
  // The worst failure mode this gate exists for: the config channel is present, the launch looks
  // healthy, and every navigator surface reports the host.
  const runner = new RecordingRunner();
  runner.capabilities = {
    ...runner.capabilities,
    capabilities: runner.capabilities.capabilities.filter(
      (capability) => capability !== 'navigator-ua-ch',
    ),
  };
  await assert.rejects(
    startProfile(runner, base),
    /lacks required native fingerprint hooks: navigator-ua-ch/,
  );
  assert.equal(runner.launched.length, 0);
});
