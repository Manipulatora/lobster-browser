import {
  applyGeoToFingerprint,
  applyOverrides,
  deriveFingerprint,
  validateFingerprintCoherence,
} from '@lobster/fingerprint';
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
    } catch (err) {
      // Fail-open on a transient exit-IP lookup — but NOT silently. A proxied profile whose
      // locale/timezone don't match the exit IP is a top-tier bot signal, so surface it loudly (the
      // sidecar forwards stderr) rather than quietly shipping a mismatched persona.
      console.warn(
        `[startProfile] proxy exit-IP geo derivation failed for profile ${params.profileId}; ` +
          'launching with the seed-derived locale/timezone, which may not match the proxy exit — ' +
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  // Fail-closed coherence gate. The derived persona is always coherent, but user overrides (or a
  // failed geo overlay) can produce an IMPOSSIBLE device — e.g. macOS carrying a Direct3D renderer, or
  // a timezone that contradicts the locale. Launching such an identity defeats the entire anti-detect
  // purpose (it is trivially flagged), so refuse it with the specific violations instead.
  const issues = validateFingerprintCoherence(fingerprint);
  if (issues.length > 0) {
    throw new Error(
      `refusing to launch profile ${params.profileId}: incoherent fingerprint ` +
        `(${issues.length} issue${issues.length === 1 ? '' : 's'}) — ${issues.join('; ')}`,
    );
  }

  const launchParams: LaunchParams = {
    profileId: params.profileId,
    engine: params.engine,
    userDataDir: params.userDataDir,
    fingerprint,
    // Thread the seed so native farbling seeds are unique per profile (not per device class).
    fingerprintSeed: params.fingerprintSeed,
    ...(params.proxy ? { proxy: params.proxy } : {}),
    ...(params.headless !== undefined ? { headless: params.headless } : {}),
  };
  return runner.launch(launchParams);
}
