import assert from 'node:assert/strict';
import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { FingerprintLaunchPolicy } from '@lobster/shared-types';
import {
  assertLobiumBuildCapabilities,
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
  probeLobiumBuildCapabilities,
  requiredLobiumCapabilities,
} from './lobium-capabilities.js';

const policy: FingerprintLaunchPolicy = {
  renderer: { mode: 'host' },
  webrtc: 'disabled',
  hardwareNoise: { canvas: true, webgl: true, audio: false, clientRects: true },
  mediaDevices: { cameras: 1, microphones: 1, speakers: 2, stableDeviceIds: true },
};

test('required capability set follows selected native policies', () => {
  const required = requiredLobiumCapabilities(policy, true);
  assert.ok(required.includes('native-geolocation'));
  assert.ok(required.includes('canvas-farbling'));
  assert.ok(required.includes('webgl-farbling'));
  assert.ok(required.includes('client-rects'));
  assert.ok(!required.includes('audio-farbling'));
});

test('exact executable capability probe parses the native contract', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobium-capabilities-'));
  const executable = join(dir, 'lobium');
  const manifest = {
    contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
    product: 'Lobium',
    capabilities: LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
  };
  await writeFile(executable, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(manifest)}'\n`);
  await chmod(executable, 0o700);
  try {
    const observed = await probeLobiumBuildCapabilities(executable);
    assert.deepEqual(observed, manifest);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('missing native hooks fail closed with an exact list', () => {
  assert.throws(
    () =>
      assertLobiumBuildCapabilities(
        {
          contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
          product: 'Lobium',
          capabilities: ['config-channel-v1'],
        },
        ['config-channel-v1', 'webrtc-policy', 'media-devices'],
      ),
    /webrtc-policy, media-devices/,
  );
});
