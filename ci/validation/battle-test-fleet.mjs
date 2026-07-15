#!/usr/bin/env node
/**
 * Fleet battle test: launches N real product profiles (varied OS/GPU/locale/hardware-noise/Android)
 * through the SAME production launch path the desktop app uses (CompositeRunner / startProfile /
 * startAndroidEmulatedProfile), then drives ci/validation/detector-matrix.mjs's live --capture against
 * each one, so every profile is scored by the reviewed 15-tool independent-provider panel.
 *
 * This is a senior-engineer breadth test of the ENGINE across configurations, not a replacement for the
 * matrix doc's required scenarios (proxied controls, stock-browser control, etc. — see
 * docs/ENGINEERING.md (§4)). No proxy is attached in this run (none is configured in
 * this environment); IP/WebRTC-focused tools therefore reflect direct host egress and are informational
 * only here, not a proxy-leak assertion.
 *
 * Usage:
 *   node ci/validation/battle-test-fleet.mjs --list                 # print the fixture list
 *   node ci/validation/battle-test-fleet.mjs --only <id,id,...>      # run a subset
 *   node ci/validation/battle-test-fleet.mjs                        # run the full fleet
 */
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { CompositeRunner, buildLaunchers, dispatch, startProfile } from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, '..', '..');
const REPORTS_DIR = join(here, 'reports', 'fleet');

// A synthetic geo overlay (NOT a real proxy — no proxy is configured in this environment) applied via
// fingerprintOverrides so a handful of profiles exercise locale/timezone/font coherence beyond the
// seed-default en-US, matching the pattern battle-test.mjs already uses for its own geo rotation.
const GEO = {
  DE: { timezone: 'Europe/Berlin', locale: 'de-DE', languages: ['de-DE', 'de', 'en'] },
  JP: { timezone: 'Asia/Tokyo', locale: 'ja-JP', languages: ['ja-JP', 'ja', 'en'] },
};

function localeOverride(key) {
  const g = GEO[key];
  return {
    languageMode: 'manual',
    timezoneMode: 'manual',
    navigator: { languages: g.languages },
    locale: { locale: g.locale, timezone: g.timezone },
  };
}

const NOISE_OFF = { canvas: false, webgl: false, audio: false, clientRects: false };

/**
 * 20 fixtures: 6 Windows (5 GPU vendors/tiers + 1 hardware-noise-off edge case), 5 macOS (3 Apple
 * Silicon + 2 Intel), 5 Linux (4 GPU vendors/tiers + 1 hardware-noise-off edge case), 2 non-US-locale
 * edge cases, 2 Android (phone + tablet, emulated — no ADB/hardware). Every seed is unique so
 * per-profile farbling distinctness is exercised across the whole fleet.
 */
export const FIXTURES = [
  // --- Windows (6) ---
  { id: 'win-nvidia-3080', os: 'windows', seed: 'fleet-win-nvidia-3080', renderer: 'win-nvidia-nvidia-geforce-rtx-3080-ti-20gb-2205' },
  { id: 'win-nvidia-1660', os: 'windows', seed: 'fleet-win-nvidia-1660', renderer: 'win-nvidia-nvidia-geforce-gtx-1660-super-1f09' },
  { id: 'win-amd-580', os: 'windows', seed: 'fleet-win-amd-580', renderer: 'win-amd-amd-radeon-rx-580-2048sp-6fdf' },
  { id: 'win-amd-6700', os: 'windows', seed: 'fleet-win-amd-6700', renderer: 'win-amd-amd-radeon-rx-6700-73df' },
  { id: 'win-intel-uhd', os: 'windows', seed: 'fleet-win-intel-uhd', renderer: 'win-intel-intel--uhd-graphics-46a1' },
  { id: 'win-noiseoff', os: 'windows', seed: 'fleet-win-noiseoff', renderer: 'win-nvidia-nvidia-geforce-gtx-1070-1b81', hardwareNoise: NOISE_OFF },
  // --- macOS (5) ---
  { id: 'mac-m1', os: 'macos', arch: 'arm64', seed: 'fleet-mac-m1', renderer: 'mac-apple-m1' },
  { id: 'mac-m2', os: 'macos', arch: 'arm64', seed: 'fleet-mac-m2', renderer: 'mac-apple-m2' },
  { id: 'mac-m3', os: 'macos', arch: 'arm64', seed: 'fleet-mac-m3', renderer: 'mac-apple-m3' },
  { id: 'mac-intel-iris', os: 'macos', arch: 'x86_64', seed: 'fleet-mac-intel-iris', renderer: 'mac-intel-intel--crystal-well-integrated-iris-pro-graphics-5200-0d22' },
  { id: 'mac-intel-radeon', os: 'macos', arch: 'x86_64', seed: 'fleet-mac-intel-radeon', renderer: 'mac-amd-amd-radeon-pro-66a0' },
  // --- Linux (5) ---
  { id: 'linux-nvidia-3060', os: 'linux', seed: 'fleet-linux-nvidia-3060', renderer: 'linux-nvidia-nvidia-geforce-rtx-3060-ti-2414' },
  { id: 'linux-amd-6600', os: 'linux', seed: 'fleet-linux-amd-6600', renderer: 'linux-amd-amd-radeon-rx-6600-73ff' },
  { id: 'linux-intel-uhd', os: 'linux', seed: 'fleet-linux-intel-uhd', renderer: 'linux-intel-intel--uhd-graphics-46a1' },
  { id: 'linux-nvidia-1080ti', os: 'linux', seed: 'fleet-linux-nvidia-1080ti', renderer: 'linux-nvidia-nvidia-geforce-gtx-1080-ti-1b06' },
  { id: 'linux-noiseoff', os: 'linux', seed: 'fleet-linux-noiseoff', renderer: 'linux-amd-amd-radeon-rx-6600-73ff', hardwareNoise: NOISE_OFF },
  // --- Non-US locale edge cases (2) ---
  { id: 'locale-de', os: 'windows', seed: 'fleet-locale-de', renderer: 'win-nvidia-nvidia-geforce-rtx-3080-ti-20gb-2205', overrides: localeOverride('DE') },
  { id: 'locale-ja', os: 'macos', arch: 'arm64', seed: 'fleet-locale-ja', renderer: 'mac-apple-m2', overrides: localeOverride('JP') },
  // --- Android, emulated (2) ---
  { id: 'android-phone', os: 'android', seed: 'fleet-android-phone', androidDeviceType: 'mobile', androidDeviceModel: 'Google Pixel 8 (Pixel 8)', osVersion: 'Android 15' },
  { id: 'android-tablet', os: 'android', seed: 'fleet-android-tablet', androidDeviceType: 'tablet', osVersion: 'Android 14' },
];

function argValue(name) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function requireEnv() {
  const bin = process.env.LOBSTER_LOBIUM_BIN;
  if (!bin || !existsSync(bin)) {
    throw new Error(
      `LOBSTER_LOBIUM_BIN must point to an existing Lobium binary (got: ${bin ?? '(unset)'})`,
    );
  }
}

async function launchDesktopFixture(fixture) {
  const userDataDir = await mkdtemp(join(tmpdir(), `fleet-${fixture.id}-`));
  const runner = new CompositeRunner(
    await buildLaunchers({ headless: false, extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'] }),
  );
  const fingerprintOverrides = {
    ...(fixture.renderer ? { renderer: { mode: 'validated_preset', presetId: fixture.renderer } } : {}),
    ...(fixture.hardwareNoise ? { hardwareNoise: fixture.hardwareNoise } : {}),
    ...(fixture.overrides ?? {}),
  };
  const launched = await startProfile(runner, {
    profileId: `fleet-${fixture.id}`,
    profileName: `Fleet ${fixture.id}`,
    engine: 'lobium',
    os: fixture.os,
    ...(fixture.arch ? { arch: fixture.arch } : {}),
    fingerprintSeed: fixture.seed,
    fingerprintOverrides,
    userDataDir,
    headless: false,
  });
  return { runner, userDataDir, launched, profileId: `fleet-${fixture.id}` };
}

async function launchAndroidFixture(fixture) {
  const userDataDir = await mkdtemp(join(tmpdir(), `fleet-${fixture.id}-`));
  const runner = new CompositeRunner(
    await buildLaunchers({ headless: false, extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'] }),
  );
  const req = {
    id: 1,
    method: 'startProfile',
    params: {
      profileId: `fleet-${fixture.id}`,
      profileName: `Fleet ${fixture.id}`,
      engine: 'lobium',
      os: 'android',
      osVersion: fixture.osVersion,
      fingerprintSeed: fixture.seed,
      fingerprintOverrides: {
        androidDeviceType: fixture.androidDeviceType,
        ...(fixture.androidDeviceModel ? { androidDeviceModel: fixture.androidDeviceModel } : {}),
      },
      userDataDir,
      headless: false,
    },
  };
  const res = await dispatch(runner, req);
  if (!res.ok) throw new Error(`android launch failed: ${res.error?.message}`);
  return { runner, userDataDir, launched: res.result, profileId: `fleet-${fixture.id}` };
}

async function runCapture(fixture, wsEndpoint, toolIds) {
  await mkdir(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `${fixture.id}.json`);
  const env = {
    ...process.env,
    LOBSTER_MATRIX_LIVE: '1',
    LOBSTER_MATRIX_CDP: wsEndpoint,
    LOBSTER_MATRIX_SCENARIO: 'proxy-headful-controlled',
    LOBSTER_MATRIX_OS: fixture.os,
    LOBSTER_MATRIX_PROFILE_ID: `fleet-${fixture.id}`,
    LOBSTER_MATRIX_PROFILE_SEED: fixture.seed,
    ...(toolIds ? { LOBSTER_MATRIX_TOOL_IDS: toolIds.join(',') } : {}),
  };
  const result = spawnSync('node', [join(here, 'detector-matrix.mjs'), '--capture', outPath], {
    cwd: ROOT,
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10 * 60 * 1000,
  });
  return {
    outPath,
    exitCode: result.status,
    stdout: result.stdout?.toString() ?? '',
    stderr: result.stderr?.toString() ?? '',
  };
}

async function runOne(fixture, toolIds) {
  process.stderr.write(`\n=== ${fixture.id} (${fixture.os}) ===\n`);
  // Launch failure (e.g. a fail-closed coherence rejection) must be caught and recorded per-fixture,
  // never allowed to escape and abort the remaining fleet — a single bad fixture previously killed the
  // whole run partway through (locale-de's coherence rejection took locale-ja/android-* down with it).
  let handle;
  try {
    handle = fixture.os === 'android' ? await launchAndroidFixture(fixture) : await launchDesktopFixture(fixture);
  } catch (error) {
    process.stderr.write(`LAUNCH ERROR: ${error?.stack || error}\n`);
    return { id: fixture.id, ok: false, error: String(error) };
  }
  const { runner, userDataDir, launched, profileId } = handle;
  try {
    process.stderr.write(`launched pid=${launched.pid} ws=${launched.ws}\n`);
    const capture = await runCapture(fixture, launched.ws, toolIds);
    process.stderr.write(capture.stderr.split('\n').filter(Boolean).slice(-30).join('\n') + '\n');
    return { id: fixture.id, ok: capture.exitCode === 0, reportPath: capture.outPath };
  } catch (error) {
    process.stderr.write(`ERROR: ${error?.stack || error}\n`);
    return { id: fixture.id, ok: false, error: String(error) };
  } finally {
    await runner.stop({ profileId }).catch(() => {});
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function main() {
  if (process.argv.includes('--list')) {
    for (const f of FIXTURES) process.stdout.write(`${f.id}\t${f.os}\t${f.seed}\n`);
    return;
  }
  requireEnv();
  const onlyArg = argValue('--only');
  const only = onlyArg ? new Set(onlyArg.split(',')) : undefined;
  const toolIdsArg = argValue('--tools');
  const toolIds = toolIdsArg ? toolIdsArg.split(',') : undefined;
  const fixtures = only ? FIXTURES.filter((f) => only.has(f.id)) : FIXTURES;
  if (fixtures.length === 0) throw new Error('no matching fixtures');

  const summary = [];
  for (const fixture of fixtures) {
    const result = await runOne(fixture, toolIds);
    summary.push(result);
    await mkdir(REPORTS_DIR, { recursive: true });
    await writeFile(join(REPORTS_DIR, '_summary.json'), `${JSON.stringify(summary, null, 2)}\n`);
  }
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
  if (summary.some((r) => !r.ok)) process.exitCode = 1;
}

main().catch((error) => {
  process.stderr.write(`${error?.stack || error}\n`);
  process.exitCode = 2;
});
