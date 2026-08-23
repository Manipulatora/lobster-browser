import assert from 'node:assert/strict';
import test from 'node:test';
import type { LaunchParams, LaunchResult, StartProfileParams } from '@lobster/shared-types';
import type { EngineRunner } from './runner.js';
import { webgpuIdentityFor } from '@lobster/fingerprint';
import {
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
  type LobiumBuildCapabilities,
} from './lobium-capabilities.js';
import { startAndroidEmulatedProfile } from './start-android-emulated-profile.js';

/** Records launch() calls without spawning a browser, so the resolved policy is testable in isolation. */
class RecordingRunner implements EngineRunner {
  launched: LaunchParams[] = [];
  async getLobiumBuildCapabilities(): Promise<LobiumBuildCapabilities> {
    return {
      contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
      product: 'Lobium',
      capabilities: [...LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES],
    };
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
  profileId: 'android-1',
  fingerprintSeed: '0123456789abcdef0123456789abcdef',
  os: 'android',
  engine: 'lobium',
  userDataDir: '/tmp/does-not-matter',
};

test('the emulated Android path launches a mobile profile with the catalog renderer', async () => {
  const runner = new RecordingRunner();
  const result = await startAndroidEmulatedProfile(runner, base);
  assert.equal(result.profileId, 'android-1');
  const launched = runner.launched[0];
  assert.ok(launched);
  assert.equal(launched.isMobileProfile, true);
  assert.deepEqual(launched.fingerprintPolicy?.renderer, {
    mode: 'validated_preset',
    presetId: 'android-device-catalog',
  });
  assert.equal(launched.webrtcPolicy, 'default_public_interface_only');
  assert.deepEqual(launched.fingerprint.webgpu, webgpuIdentityFor(launched.fingerprint.webgl));
});

test('persona WebRTC, hardware-noise and media-device choices reach the Android launch', async () => {
  const runner = new RecordingRunner();
  await startAndroidEmulatedProfile(runner, {
    ...base,
    fingerprintOverrides: {
      webrtc: 'disabled',
      hardwareNoise: { canvas: false, clientRects: true },
      mediaDevices: { cameras: 0, speakers: 1 },
    },
  });

  const launched = runner.launched[0];
  assert.ok(launched);
  assert.equal(launched.webrtcPolicy, 'disabled');
  assert.equal(launched.fingerprintPolicy?.webrtc, 'disabled');
  assert.equal(launched.fingerprintPolicy?.hardwareNoise.webgl, true, 'default preserved');
  assert.equal(launched.fingerprintPolicy?.hardwareNoise.canvas, false);
  assert.equal(launched.fingerprintPolicy?.hardwareNoise.clientRects, true);
  assert.deepEqual(launched.fingerprintPolicy?.mediaDevices, {
    cameras: 0,
    microphones: 1,
    speakers: 1,
    stableDeviceIds: true,
  });
});

test('a desktop renderer override cannot replace the Android device-catalog GPU', async () => {
  const runner = new RecordingRunner();
  await startAndroidEmulatedProfile(runner, {
    ...base,
    fingerprintOverrides: { renderer: { mode: 'host' } },
  });
  assert.deepEqual(runner.launched[0]?.fingerprintPolicy?.renderer, {
    mode: 'validated_preset',
    presetId: 'android-device-catalog',
  });
});

test('the emulated Android path rejects unsafe media-device counts before launch', async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    startAndroidEmulatedProfile(runner, {
      ...base,
      fingerprintOverrides: { mediaDevices: { cameras: 9_999 } },
    }),
    /mediaDevices\.cameras must be an integer in 0-16/,
  );
  assert.equal(runner.launched.length, 0);
});
