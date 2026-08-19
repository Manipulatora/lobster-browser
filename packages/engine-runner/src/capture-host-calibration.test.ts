import assert from 'node:assert/strict';
import test from 'node:test';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { captureHostCalibrationRawSnapshot } from './capture-host-calibration.js';

/** Temp directories this probe would have created, so an aborted capture is visibly leak-free. */
async function probeTempDirs(): Promise<string[]> {
  const entries = await readdir(tmpdir());
  return entries.filter((entry) => entry.startsWith('lobium-host-calibration-'));
}

test('the probe refuses before spawning anything when no engine is provisioned', async () => {
  const previousBin = process.env.LOBSTER_LOBIUM_BIN;
  const previousDiscover = process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
  const before = await probeTempDirs();
  try {
    delete process.env.LOBSTER_LOBIUM_BIN;
    process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = '0';
    await assert.rejects(
      captureHostCalibrationRawSnapshot(),
      /cannot capture host calibration: Lobium binary is unavailable/,
    );
    // The desktop first run calls this on a machine that may not have the engine yet; refusing must
    // cost nothing, least of all a temp profile directory nobody will ever clean up.
    assert.deepEqual(await probeTempDirs(), before);
  } finally {
    if (previousBin === undefined) delete process.env.LOBSTER_LOBIUM_BIN;
    else process.env.LOBSTER_LOBIUM_BIN = previousBin;
    if (previousDiscover === undefined) delete process.env.LOBSTER_LOBIUM_AUTO_DISCOVER;
    else process.env.LOBSTER_LOBIUM_AUTO_DISCOVER = previousDiscover;
  }
});
