#!/usr/bin/env node
/**
 * Minimal, observable "can a profile launch here?" probe.
 *
 *   LOBSTER_LOBIUM_BIN=<chrome.exe> node ci/validation/launch-probe.mjs [--preset]
 *
 * WHY NOT product-e2e.mjs. That harness proves much more (cookie import, real navigation, persona
 * application) and is the right tool once launching works. But it buffers its output and has no step
 * timeout, so when the launch path blocks it produces a silent hang with nothing to diagnose - which
 * is exactly what happened on this host. This probe writes each step synchronously to stderr before
 * attempting it, and bounds the whole run, so a hang names the step it hung in.
 *
 * `--preset` selects a validated renderer preset instead of the default `host` policy. That is the
 * difference between "needs measured host GPU evidence" and "uses a catalog GPU", and on a machine
 * with no real GPU it is the difference between refusing to launch and launching correctly.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { generateSeed, WINDOWS_RENDERER_PRESETS } from '@lobster/fingerprint';
import {
  CompositeRunner,
  buildLaunchers,
  isLobiumAvailable,
  resolveLobiumBinary,
  probeLobiumBuildCapabilities,
  startProfile,
} from '@lobster/engine-runner';

const usePreset = process.argv.includes('--preset');
const step = (m) => process.stderr.write(`[probe] ${m}\n`);

// Any real entry from the validated catalog; the specific card is irrelevant to what this probes.
const PRESET_ID = WINDOWS_RENDERER_PRESETS[0].id;

/** Bound every step so a hang reports WHERE, instead of producing a silent timeout. */
function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, reject) => {
      t = setTimeout(() => reject(new Error(`timed out after ${ms}ms in: ${what}`)), ms);
    }),
  ]);
}

const bin = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
step(`engine binary: ${bin ?? '(none found)'}`);
step(`isLobiumAvailable(): ${isLobiumAvailable()}`);
if (!bin) {
  step('FAIL: no engine binary resolved');
  process.exit(2);
}

step('probing native capabilities...');
const caps = await withTimeout(probeLobiumBuildCapabilities(bin), 30_000, 'capability probe');
step(`capabilities: ${caps.capabilities.length}`);

const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-probe-'));
const seed = generateSeed();

// The exact shape the Rust core sends for a Launch click, minus the parts that need a DB.
const params = {
  profileId: 'probe-profile',
  userDataDir,
  engine: 'lobium',
  os: 'windows',
  osVersion: 'Windows 11',
  fingerprintSeed: seed,
  fingerprintOverrides: usePreset
    ? { renderer: { mode: 'validated_preset', presetId: PRESET_ID } }
    : undefined,
};

step(`renderer policy: ${usePreset ? `validated_preset ${PRESET_ID}` : 'host (default)'}`);
step('calling startProfile...');

let runner;
let session;
try {
  // buildLaunchers is ASYNC. Passing the un-awaited promise gives CompositeRunner a registry with no
  // `lobium` key, which surfaces as "registered Lobium launcher does not expose an exact-build
  // capability probe" — a message that points at the launcher rather than at the missing await.
  //
  // headless on purpose: this probe answers "does the launch path complete", and a headful window
  // depends on the desktop session the probe happens to run in. The app itself launches headful.
  const launchers = await withTimeout(
    buildLaunchers({ headless: true, extraArgs: [] }),
    30_000,
    'buildLaunchers',
  );
  runner = new CompositeRunner(launchers);
  session = await withTimeout(startProfile(runner, params), 120_000, 'startProfile');
  step(`LAUNCHED: pid=${session.pid} ws=${session.ws ? 'yes' : 'no'}`);
} catch (err) {
  step(`REFUSED: ${err instanceof Error ? err.message : String(err)}`);
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  process.exit(1);
}

try {
  // startProfile returns a LaunchResult (a plain record), not a session handle — stopping goes back
  // through the runner. Leaving this wrong once leaked 29 Chrome processes across probe runs.
  await withTimeout(runner.stop({ profileId: params.profileId }), 30_000, 'stop');
  step('stopped cleanly');
} catch (err) {
  step(`stop failed: ${err instanceof Error ? err.message : String(err)}`);
} finally {
  await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
}
step('OK');
