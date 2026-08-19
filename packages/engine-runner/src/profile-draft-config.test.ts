import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { WINDOWS_RENDERER_PRESETS } from '@lobster/fingerprint';
import type {
  FingerprintOverrides,
  LaunchParams,
  LaunchResult,
  StartProfileParams,
} from '@lobster/shared-types';
import {
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
  type LobiumBuildCapabilities,
} from './lobium-capabilities.js';
import { LOBIUM_CONFIG_FILENAME } from './lobium-config.js';
import { buildLobiumLaunchArgs } from './runners/lobium-launcher.js';
import type { LaunchContext } from './runners/types.js';
import type { EngineRunner } from './runner.js';
import { startProfile } from './start-profile.js';

/**
 * The whole path a profile-editor knob travels: the overrides the editor serializes → `startProfile`
 * → the native config document the engine actually reads. Every knob the editor offers is asserted in
 * the emitted `lobium-fp.json`, because a control that never reaches this file is decorative and
 * nothing else in the suite can tell the difference — the editor's own tests stop at the override
 * object, and the config tests start from an already-resolved fingerprint.
 */

const preset = WINDOWS_RENDERER_PRESETS[0]!;

/** Exactly the shape `serializeFingerprintOverrides` produces for a fully-filled Windows draft. */
const draftOverrides: FingerprintOverrides = {
  navigator: { languages: ['fr-FR', 'fr', 'en-US'], hardwareConcurrency: 8, deviceMemory: 8 },
  screen: {
    width: 1536,
    height: 864,
    availWidth: 1536,
    availHeight: 824,
    availLeft: 0,
    availTop: 0,
    devicePixelRatio: 1.25,
  },
  locale: {
    timezone: 'Europe/Paris',
    geolocation: { latitude: 48.8566, longitude: 2.3522, accuracy: 50 },
  },
  fontsMode: 'manual',
  fonts: ['Arial', 'Calibri', 'Consolas', 'Segoe UI', 'Tahoma'],
  renderer: { mode: 'validated_preset', presetId: preset.id },
  webgl: preset.webgl,
  languageMode: 'manual',
  timezoneMode: 'manual',
  geolocationMode: 'manual',
  webrtcMode: 'manual',
  webrtc: 'disabled',
  hardwareNoise: { webgl: true, canvas: true, audio: false, clientRects: true },
  mediaDevices: { cameras: 2, microphones: 3, speakers: 1, stableDeviceIds: false },
};

const params: StartProfileParams = {
  profileId: 'draft-1',
  engine: 'lobium',
  os: 'windows',
  osVersion: 'Windows 11 23H2',
  fingerprintSeed: 'seed-draft-to-config',
  userDataDir: '/tmp/replaced-per-test',
  fingerprintOverrides: draftOverrides,
};

class RecordingRunner implements EngineRunner {
  launched: LaunchParams[] = [];
  async getLobiumBuildCapabilities(): Promise<LobiumBuildCapabilities> {
    return {
      contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
      product: 'Lobium',
      capabilities: [...LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES],
    };
  }
  async launch(launchParams: LaunchParams): Promise<LaunchResult> {
    this.launched.push(launchParams);
    return {
      profileId: launchParams.profileId,
      pid: 0,
      ws: 'ws://x',
      debuggerAddress: '127.0.0.1:1',
    };
  }
  async stop(): Promise<void> {}
  async status(): Promise<{ running: never[] }> {
    return { running: [] };
  }
  async exportCookies(profileId: string): Promise<{ profileId: string; json: string }> {
    return { profileId, json: '[]' };
  }
}

/** Mirrors what `CompositeRunner` hands the Lobium launcher, so the document is the shipped one. */
async function emitNativeConfig(userDataDir: string) {
  const runner = new RecordingRunner();
  await startProfile(runner, { ...params, userDataDir });
  const launched = runner.launched[0];
  assert.ok(launched, 'the draft persona must reach the launcher');
  const ctx = {
    profileId: launched.profileId,
    engine: launched.engine,
    fingerprint: launched.fingerprint,
    ...(launched.fingerprintPolicy ? { fingerprintPolicy: launched.fingerprintPolicy } : {}),
    ...(launched.webrtcPolicy ? { webrtcPolicy: launched.webrtcPolicy } : {}),
    ...(launched.fingerprintSeed ? { fingerprintSeed: launched.fingerprintSeed } : {}),
    options: { userDataDir, headless: false, args: [] },
    emulation: {},
    initScript: '',
  } as unknown as LaunchContext;
  await buildLobiumLaunchArgs(ctx);
  return JSON.parse(await readFile(join(userDataDir, LOBIUM_CONFIG_FILENAME), 'utf8'));
}

test('every profile-editor knob reaches the native config document', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobster-draft-'));
  try {
    const written = await emitNativeConfig(userDataDir);

    // Identity: UA and the UA-CH set derived from it, plus the editor's OS-version selection.
    assert.match(written.navigator.userAgent, /Windows NT 10\.0; Win64; x64/);
    assert.equal(written.navigator.platform, 'Win32');
    assert.equal(written.navigator.uaPlatform, 'Windows');
    assert.equal(written.navigator.uaPlatformVersion, '15.0.0', 'Windows 11 → UA-CH 15.0.0');
    assert.ok(written.navigator.uaBrands.length > 0);
    assert.equal(written.arch, 'x86_64');

    // Hardware knobs.
    assert.equal(written.navigator.hardwareConcurrency, 8);
    assert.equal(written.navigator.deviceMemory, 8);

    // Screen — including devicePixelRatio, the knob with a native hook but no UI for the longest.
    assert.equal(written.screen.width, 1536);
    assert.equal(written.screen.height, 864);
    assert.equal(written.screen.availHeight, 824);
    assert.equal(written.screen.devicePixelRatio, 1.25);

    // Renderer: the editor stores the chosen catalog GPU, and the launch re-resolves it from the
    // sourced catalog rather than trusting the persisted copy.
    assert.deepEqual(written.policy.renderer, { mode: 'validated_preset', presetId: preset.id });
    assert.equal(written.webgl.renderer, preset.webgl.renderer);
    assert.equal(written.webgl.unmaskedRenderer, preset.webgl.unmaskedRenderer);
    assert.deepEqual(written.webgl.caps, preset.webgl.caps);
    assert.equal(written.webgpu.vendor.length > 0, true, 'WebGPU names the same GPU');

    // Locale trio: languages drive navigator.languages, locale and Accept-Language together.
    assert.deepEqual(written.navigator.languages, ['fr-FR', 'fr', 'en-US']);
    assert.equal(written.locale.locale, 'fr-FR');
    assert.match(written.locale.acceptLanguage, /^fr-FR/);
    assert.equal(written.locale.timezone, 'Europe/Paris');
    assert.deepEqual(written.locale.geolocation, {
      latitude: 48.8566,
      longitude: 2.3522,
      accuracy: 50,
    });

    // Fonts: the browser-side list the DirectWrite/Local Font Access filters enforce.
    assert.deepEqual(written.fonts, ['Arial', 'Calibri', 'Consolas', 'Segoe UI', 'Tahoma']);

    // WebRTC, hardware noise (via the seed gate) and media devices.
    assert.equal(written.net.webrtcPolicy, 'disabled');
    assert.equal(written.policy.webrtc, 'disabled');
    assert.deepEqual(written.policy.hardwareNoise, {
      webgl: true,
      canvas: true,
      audio: false,
      clientRects: true,
    });
    assert.ok(written.seeds.canvas > 0);
    assert.ok(written.seeds.webgl > 0);
    assert.equal(written.seeds.audio, 0, 'audio noise off → no native audio farbling');
    assert.ok(written.seeds.clientRects > 0);
    assert.ok(written.seeds.mediaDevices > 0);
    assert.deepEqual(written.policy.mediaDevices, {
      cameras: 2,
      microphones: 3,
      speakers: 1,
      stableDeviceIds: false,
    });
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('a changed editor knob changes the native config document', async () => {
  // Guards the other direction: an assertion above could pass on a value the seed happens to derive.
  const first = await mkdtemp(join(tmpdir(), 'lobster-draft-a-'));
  const second = await mkdtemp(join(tmpdir(), 'lobster-draft-b-'));
  try {
    const written = await emitNativeConfig(first);
    const runner = new RecordingRunner();
    await startProfile(runner, {
      ...params,
      userDataDir: second,
      fingerprintOverrides: {
        ...draftOverrides,
        navigator: { ...draftOverrides.navigator, hardwareConcurrency: 16 },
        screen: { ...draftOverrides.screen, devicePixelRatio: 1 },
      },
    });
    const launched = runner.launched[0];
    assert.ok(launched);
    assert.equal(launched.fingerprint.navigator.hardwareConcurrency, 16);
    assert.equal(launched.fingerprint.screen.devicePixelRatio, 1);
    assert.equal(written.navigator.hardwareConcurrency, 8, 'the first document is unaffected');
  } finally {
    await rm(first, { recursive: true, force: true });
    await rm(second, { recursive: true, force: true });
  }
});
