import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { HostCalibrationProfile } from '@lobster/shared-types';
import {
  hostCalibrationIssues,
  loadHostCalibration,
  persistHostCalibration,
  resolveHostCalibrationPath,
} from './host-calibration-store.js';

test('an absent, unreadable or corrupt store degrades to the catalog instead of throwing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-hc-store-'));
  try {
    assert.equal(await loadHostCalibration(undefined), undefined);
    assert.equal(await loadHostCalibration(join(dir, 'never-written.json')), undefined);

    // A launch interrupted mid-write leaves a truncated file. Every profile on the machine would
    // fail to start if reading it threw, so it must read exactly like "not calibrated yet".
    const truncated = join(dir, 'truncated.json');
    await writeFile(truncated, '{"version":1,"os":"linu', 'utf8');
    assert.equal(await loadHostCalibration(truncated), undefined);

    const directory = join(dir, 'a-directory.json');
    await mkdir(directory);
    assert.equal(await loadHostCalibration(directory), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed host profile reads as invalid rather than crashing the caller', () => {
  // The validator assumes a complete profile, so a half-written capture makes it throw from deep
  // inside. Every launch reads this file; a throw here used to fail them all with an opaque message.
  const issues = hostCalibrationIssues(
    { version: 1, os: 'linux', arch: 'x86_64' } as unknown as HostCalibrationProfile,
    { allowSoftwareRenderer: true },
  );
  assert.equal(issues.length > 0, true);
  assert.match(issues.join('; '), /malformed host calibration/);
});

test('an invalid host profile is refused and leaves no file behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-hc-store-'));
  const path = join(dir, 'nested', 'host-calibration.json');
  try {
    await assert.rejects(
      persistHostCalibration(path, {
        version: 1,
        os: 'linux',
        arch: 'x86_64',
      } as unknown as HostCalibrationProfile),
      /refusing to persist an invalid host calibration/,
    );
    await assert.rejects(stat(path));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('the store path comes from the environment and an empty value means uncalibrated', () => {
  assert.equal(
    resolveHostCalibrationPath({ LOBSTER_HOST_CALIBRATION_FILE: ' /var/lib/lobster/hc.json ' }),
    '/var/lib/lobster/hc.json',
  );
  assert.equal(resolveHostCalibrationPath({ LOBSTER_HOST_CALIBRATION_FILE: '   ' }), undefined);
  assert.equal(resolveHostCalibrationPath({}), undefined);
});
