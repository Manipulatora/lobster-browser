import {
  applyGeoToFingerprint,
  applyOverrides,
  deriveFingerprintFromHost,
  deriveFingerprint,
  validateHostCalibrationProfile,
  validateFingerprintCoherence,
} from '@lobster/fingerprint';
import { deriveGeoFromExitIp, toEnginePlaywrightProxy } from '@lobster/proxy';
import type {
  Fingerprint,
  FingerprintLaunchPolicy,
  HardwareNoisePolicy,
  LaunchParams,
  LaunchResult,
  MediaDeviceProfile,
  RendererPolicy,
  StartProfileParams,
  WebRtcPolicy,
} from '@lobster/shared-types';
import { assertUpstreamReachable } from './proxy-auth-adapter.js';
import type { EngineRunner } from './runner.js';
import { loadHostCalibration, resolveHostCalibrationPath } from './host-calibration-store.js';

/** True when a geo/proxy error means the upstream is dead — fail closed, do not launch. */
function isProxyUnreachableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unreachable|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|Proxy connection timed out|SOCKS geo lookup timed out|connect ETIMEDOUT|connect ECONNREFUSED/i.test(
    msg,
  );
}

const DEFAULT_HARDWARE_NOISE: HardwareNoisePolicy = {
  webgl: true,
  canvas: true,
  audio: true,
  clientRects: false,
};

const DEFAULT_MEDIA_DEVICES: MediaDeviceProfile = {
  cameras: 1,
  microphones: 1,
  speakers: 2,
  stableDeviceIds: true,
};

const DEFAULT_RENDERER_POLICY: RendererPolicy = { mode: 'host' };

function resolveWebRtcPolicy(params: StartProfileParams): WebRtcPolicy {
  const requested = params.fingerprintOverrides?.webrtc;
  if (requested) return requested;
  return params.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only';
}

function resolveLaunchPolicy(params: StartProfileParams): FingerprintLaunchPolicy {
  return {
    renderer: params.fingerprintOverrides?.renderer ?? DEFAULT_RENDERER_POLICY,
    webrtc: resolveWebRtcPolicy(params),
    hardwareNoise: {
      ...DEFAULT_HARDWARE_NOISE,
      ...params.fingerprintOverrides?.hardwareNoise,
    },
    mediaDevices: {
      ...DEFAULT_MEDIA_DEVICES,
      ...params.fingerprintOverrides?.mediaDevices,
    },
  };
}

/**
 * High-level launch used by the desktop core: derive the profile's fingerprint from its seed
 * (+ user overrides + best-effort proxy-exit geo), then launch it. Keeping derivation on the TS side
 * means the Rust core only forwards the profile's stored fields — it never computes fingerprints.
 */
export async function startProfile(
  runner: EngineRunner,
  params: StartProfileParams,
): Promise<LaunchResult> {
  if (params.engine !== 'lobium') {
    throw new Error(
      `refusing to launch profile ${params.profileId}: Lobium is the only supported engine`,
    );
  }
  if (params.os !== 'windows' && params.os !== 'macos' && params.os !== 'linux') {
    throw new Error(
      `refusing to launch profile ${params.profileId}: desktop sidecar cannot launch OS "${String(
        params.os,
      )}"`,
    );
  }
  // HC-3: host-calibrated derivation is the DEFAULT whenever a host profile has been captured. An
  // explicit `params.hostCalibration` (passed by the control plane) wins; otherwise, if a persisted
  // host profile exists (LOBSTER_HOST_CALIBRATION_FILE) and its OS matches this profile, use it. When
  // neither is present we fall back to the catalog path — unchanged behavior for CI/headless.
  let hostCalibration = params.hostCalibration;
  if (!hostCalibration) {
    const persisted = await loadHostCalibration(resolveHostCalibrationPath());
    if (persisted && persisted.os === params.os && (!params.arch || persisted.arch === params.arch)) {
      hostCalibration = persisted;
    }
  }

  let fingerprint: Fingerprint;
  if (hostCalibration) {
    if (hostCalibration.os !== params.os) {
      throw new Error(
        `refusing to launch profile ${params.profileId}: host calibration OS ` +
          `"${hostCalibration.os}" does not match profile OS "${params.os}"`,
      );
    }
    if (params.arch && hostCalibration.arch !== params.arch) {
      throw new Error(
        `refusing to launch profile ${params.profileId}: host calibration arch ` +
          `"${hostCalibration.arch}" does not match profile arch "${params.arch}"`,
      );
    }
    const hostIssues = validateHostCalibrationProfile(hostCalibration);
    if (hostIssues.length > 0) {
      throw new Error(
        `refusing to launch profile ${params.profileId}: invalid host calibration ` +
          `(${hostIssues.length} issue${hostIssues.length === 1 ? '' : 's'}) — ${hostIssues.join('; ')}`,
      );
    }
    fingerprint = deriveFingerprintFromHost(params.fingerprintSeed, hostCalibration, {
      engine: params.engine,
    });
  } else {
    fingerprint = deriveFingerprint(params.fingerprintSeed, {
      os: params.os,
      engine: params.engine,
      ...(params.arch ? { arch: params.arch } : {}),
    });
  }
  fingerprint = applyOverrides(fingerprint, params.fingerprintOverrides);

  if (params.proxy) {
    // Fail closed on a dead upstream before geo overlay / engine spawn — otherwise the UI warns
    // about geo and still opens a blank Lobium window that cannot egress.
    await assertUpstreamReachable(toEnginePlaywrightProxy(params.proxy));
    try {
      const geo = await deriveGeoFromExitIp(params.proxy);
      fingerprint = applyGeoToFingerprint(fingerprint, geo);
    } catch (err) {
      if (isProxyUnreachableError(err)) {
        throw new Error(
          `refusing to launch profile ${params.profileId}: proxy is unreachable — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      // Fail-open only on soft geo-API failures (bad JSON, rate limit, missing fields) when TCP to
      // the proxy already succeeded. Surface loudly — mismatched locale/tz is a bot signal.
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
    ...(typeof params.profileName === 'string' ? { profileName: params.profileName } : {}),
    engine: params.engine,
    ...(typeof params.osVersion === 'string' ? { osVersion: params.osVersion } : {}),
    userDataDir: params.userDataDir,
    fingerprint,
    fingerprintPolicy: resolveLaunchPolicy(params),
    webrtcPolicy: resolveWebRtcPolicy(params),
    // Thread the seed so native farbling seeds are unique per profile (not per device class).
    fingerprintSeed: params.fingerprintSeed,
    ...(params.proxy ? { proxy: params.proxy } : {}),
    ...(params.cookiesImport ? { cookiesImport: params.cookiesImport } : {}),
    ...(Array.isArray(params.extensions) ? { extensions: params.extensions } : {}),
    ...(params.headless !== undefined ? { headless: params.headless } : {}),
  };
  return runner.launch(launchParams);
}
