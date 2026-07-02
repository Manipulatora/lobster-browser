import { applyGeoToFingerprint, applyOverrides, deriveFingerprint } from '@lobster/fingerprint';
import { deriveGeoFromExitIp } from '@lobster/proxy';
import type { LaunchParams, LaunchResult, StartProfileParams } from '@lobster/shared-types';
import type { EngineRunner } from './runner.js';

/**
 * High-level launch used by the desktop core: derive the profile's fingerprint from its seed
 * (+ user overrides + best-effort proxy-exit geo), then launch it. Keeping derivation on the TS side
 * means the Rust core only forwards the profile's stored fields — it never computes fingerprints.
 */
export async function startProfile(
  runner: EngineRunner,
  params: StartProfileParams,
): Promise<LaunchResult> {
  let fingerprint = deriveFingerprint(params.fingerprintSeed, {
    os: params.os,
    engine: params.engine,
  });
  fingerprint = applyOverrides(fingerprint, params.fingerprintOverrides);

  if (params.proxy) {
    try {
      const geo = await deriveGeoFromExitIp(params.proxy);
      fingerprint = applyGeoToFingerprint(fingerprint, geo);
    } catch {
      // Best-effort: if the proxy exit-IP geo lookup fails, launch with the seed-derived locale
      // rather than failing the launch. Proxy quality is surfaced separately (testProxy).
    }
  }

  const launchParams: LaunchParams = {
    profileId: params.profileId,
    engine: params.engine,
    userDataDir: params.userDataDir,
    fingerprint,
    ...(params.proxy ? { proxy: params.proxy } : {}),
    ...(params.headless !== undefined ? { headless: params.headless } : {}),
  };
  return runner.launch(launchParams);
}
