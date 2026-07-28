import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { StartProfileParams } from '@lobster/shared-types';
import { CompositeRunner } from './runners/composite.js';
import { probeLobiumBuildCapabilities } from './lobium-capabilities.js';
import { buildLaunchers } from './runners/default-launchers.js';
import { isLobiumAvailable, resolveLobiumBinary } from './runners/lobium-launcher.js';
import { startProfile } from './start-profile.js';

// Runs only where native Lobium is installed; skipped (green) elsewhere.
const binary = resolveLobiumBinary();
const capabilityReady =
  binary && process.env.LOBSTER_HOST_CALIBRATION_FILE
    ? await probeLobiumBuildCapabilities(binary).then(
        () => true,
        () => false,
      )
    : false;
const lobiumReady = isLobiumAvailable() && capabilityReady;

test(
  'startProfile derives a fingerprint from the seed and launches native Lobium (no proxy)',
  {
    skip: lobiumReady
      ? false
      : 'requires capability-contract Lobium and a complete LOBSTER_HOST_CALIBRATION_FILE',
  },
  async () => {
    const runner = new CompositeRunner(
      await buildLaunchers({
        headless: true,
        extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
      }),
    );
    const userDataDir = await mkdtemp(join(tmpdir(), 'lobster-sp-'));
    const params: StartProfileParams = {
      profileId: 'sp1',
      engine: 'lobium',
      os: 'windows',
      fingerprintSeed: 'abc123def456abc1',
      userDataDir,
      headless: true,
    };

    try {
      const res = await startProfile(runner, params);
      assert.equal(res.profileId, 'sp1');
      assert.match(res.ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//, 'real CDP endpoint');
      const status = await runner.status({});
      assert.equal(status.running.length, 1, 'the launched profile is tracked');
    } finally {
      await runner.stop({ profileId: 'sp1' }).catch(() => {});
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
);
