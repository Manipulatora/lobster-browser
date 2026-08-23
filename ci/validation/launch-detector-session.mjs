#!/usr/bin/env node
/**
 * Launch one fixed-seed headful product profile for controlled detector-matrix capture.
 * The process stays alive until SIGINT/SIGTERM so detector-matrix.mjs can attach over the supported
 * product CDP endpoint. This script never loads detector pages itself.
 */
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';

import { CompositeRunner, buildLaunchers, startProfile } from '@lobster/engine-runner';
import {
  assertCanonicalFingerprintSeed,
  canonicalFingerprintSeed,
} from './canonical-seed.mjs';

const output = resolve(
  process.env.LOBSTER_MATRIX_SESSION_FILE || 'ci/validation/reports/detector-session-current.json',
);
const userDataDir = resolve(
  process.env.LOBSTER_MATRIX_USER_DATA_DIR || 'ci/validation/reports/detector-profile-current',
);
const seed = process.env.LOBSTER_MATRIX_PROFILE_SEED
  ? assertCanonicalFingerprintSeed(
      process.env.LOBSTER_MATRIX_PROFILE_SEED,
      'LOBSTER_MATRIX_PROFILE_SEED',
    )
  : canonicalFingerprintSeed('lobster-matrix-fixed-alpha-20260711');
const profileId = process.env.LOBSTER_MATRIX_PROFILE_ID || 'matrix-fixed-alpha';
const profileOs = process.env.LOBSTER_MATRIX_PROFILE_OS || 'linux';
const fontPackDir = process.env.LOBSTER_FONTS_DIR;

if (!fontPackDir) throw new Error('LOBSTER_FONTS_DIR is required');
const fontManifest = JSON.parse(
  await readFile(resolve(fontPackDir, 'font-pack.manifest.json'), 'utf8'),
);
const fonts = fontManifest.personas?.[profileOs]?.families;
if (!Array.isArray(fonts) || fonts.length === 0) {
  throw new Error(`open-font pack has no ${profileOs} persona`);
}

await mkdir(userDataDir, { recursive: true });
const runner = new CompositeRunner(
  await buildLaunchers({
    headless: false,
    extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
  }),
);
const launched = await startProfile(runner, {
  profileId,
  profileName: `Detector ${profileId}`,
  engine: 'lobium',
  os: profileOs,
  osVersion: profileOs === 'linux' ? 'Ubuntu 24.04' : undefined,
  fingerprintSeed: seed,
  fingerprintOverrides: {
    fontsMode: 'manual',
    fonts,
    languageMode: 'real',
    timezoneMode: 'real',
    geolocationMode: 'real',
  },
  userDataDir,
  headless: false,
});

const session = {
  capturedAt: new Date().toISOString(),
  profileId,
  profileSeed: seed,
  profileOs,
  userDataDir,
  ws: launched.ws,
  debuggerAddress: launched.debuggerAddress,
  pid: launched.pid,
  fontPackId: fontManifest.packId,
  provisional: true,
  provisionalReason: 'QEMU/llvmpipe host; never satisfies a real-GPU release gate',
};
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(session, null, 2)}\n`);
process.stdout.write(`READY ${output}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await runner.stop({ profileId }).catch(() => {});
  if (process.env.LOBSTER_MATRIX_PURGE_PROFILE === '1') {
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
  process.exit(0);
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
setInterval(() => {}, 60_000);
