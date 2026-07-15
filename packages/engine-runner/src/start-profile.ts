import {
  applyOverrides,
  deriveFingerprintFromHost,
  deriveFingerprint,
  normalizeHostWebglIdentity,
  resolveSourcedRendererPreset,
  resolveFingerprintPersonaModes,
  validateFingerprintCoherence,
  validateHostCalibrationProfile,
} from '@lobster/fingerprint';
import { deriveGeoFromExitIp, toEnginePlaywrightProxy } from '@lobster/proxy';
import type {
  Fingerprint,
  FingerprintOverrides,
  FingerprintLaunchPolicy,
  GeoInfo,
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
import { allowProvisionalSoftwareGpu } from './gpu.js';
import {
  assertLobiumBuildCapabilities,
  requiredLobiumCapabilities,
} from './lobium-capabilities.js';
import { ensureHostCalibration } from './ensure-host-calibration.js';
import { captureHostCalibrationRawSnapshot } from './capture-host-calibration.js';

/** True when a geo/proxy error means the upstream is dead — fail closed, do not launch. */
function isProxyUnreachableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unreachable|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|Proxy connection timed out|SOCKS geo lookup timed out|connect ETIMEDOUT|connect ECONNREFUSED|HTTP 407|proxy authentication|authentication failed|invalid credentials|Socks5 Authentication/i.test(
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

function runtimeHostOs(): Fingerprint['os'] {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
}

function resolveWebRtcPolicy(params: StartProfileParams): WebRtcPolicy {
  const requested = params.fingerprintOverrides?.webrtc;
  const mode = params.fingerprintOverrides?.webrtcMode;
  if (mode === 'based_ip') {
    return params.proxy ? 'proxy_only' : 'default_public_interface_only';
  }
  if (mode === 'real') return 'default_public_interface_only';
  if (requested) {
    if (
      requested !== 'default_public_interface_only' &&
      requested !== 'disable_non_proxied_udp' &&
      requested !== 'proxy_only' &&
      requested !== 'disabled'
    ) {
      throw new Error(`invalid WebRTC policy "${String(requested)}"`);
    }
    return requested;
  }
  return params.proxy ? 'disable_non_proxied_udp' : 'default_public_interface_only';
}

function validateLaunchPolicy(policy: FingerprintLaunchPolicy): void {
  const renderer = policy.renderer;
  if (
    renderer.mode !== 'host' &&
    renderer.mode !== 'normalized_host' &&
    renderer.mode !== 'validated_preset'
  ) {
    throw new Error(`invalid renderer policy "${String((renderer as RendererPolicy).mode)}"`);
  }
  if (renderer.mode === 'validated_preset' && renderer.presetId.trim() === '') {
    throw new Error('validated renderer preset requires a non-empty presetId');
  }
  for (const [surface, enabled] of Object.entries(policy.hardwareNoise)) {
    if (typeof enabled !== 'boolean') {
      throw new Error(`hardware-noise policy ${surface} must be boolean`);
    }
  }
  for (const [kind, count] of Object.entries({
    cameras: policy.mediaDevices.cameras,
    microphones: policy.mediaDevices.microphones,
    speakers: policy.mediaDevices.speakers,
  })) {
    // Very large values can make the native enumerateDevices hook allocate thousands of objects and
    // are never a plausible consumer machine. Validate at the untyped IPC boundary.
    if (!Number.isInteger(count) || count < 0 || count > 16) {
      throw new Error(`mediaDevices.${kind} must be an integer in 0-16 (got ${String(count)})`);
    }
  }
  if (typeof policy.mediaDevices.stableDeviceIds !== 'boolean') {
    throw new Error('mediaDevices.stableDeviceIds must be boolean');
  }
}

function resolveLaunchPolicy(params: StartProfileParams): FingerprintLaunchPolicy {
  const policy: FingerprintLaunchPolicy = {
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
  validateLaunchPolicy(policy);
  if (policy.webrtc === 'proxy_only' && !params.proxy) {
    throw new Error('WebRTC proxy_only policy requires a configured proxy');
  }
  if (policy.webrtc === 'default_public_interface_only' && params.proxy) {
    throw new Error(
      'WebRTC default_public_interface_only is unsafe with a proxy because host ICE may bypass it',
    );
  }
  return policy;
}

/** Make the persisted OS-version selection authoritative for the UA-CH platform version. */
export function applyProfileOsVersion(fp: Fingerprint, osVersion: string | undefined): Fingerprint {
  if (!osVersion) return fp;
  let uaPlatformVersion: string | undefined;
  if (fp.os === 'windows') {
    if (/Windows\s+10\b/i.test(osVersion)) uaPlatformVersion = '10.0.0';
    else if (/Windows\s+11\b/i.test(osVersion)) uaPlatformVersion = '15.0.0';
  } else if (fp.os === 'macos') {
    const major = /macOS\s+(\d+)/i.exec(osVersion)?.[1];
    if (major) uaPlatformVersion = `${major}.0.0`;
  }
  return uaPlatformVersion ? { ...fp, navigator: { ...fp.navigator, uaPlatformVersion } } : fp;
}

function requiresProxyGeo(params: StartProfileParams): boolean {
  const overrides = params.fingerprintOverrides;
  return [overrides?.languageMode, overrides?.timezoneMode, overrides?.geolocationMode].some(
    (mode) => mode === undefined || mode === 'based_ip',
  );
}

function explicitlyRequiresProxyGeo(params: StartProfileParams): boolean {
  const overrides = params.fingerprintOverrides;
  return [overrides?.languageMode, overrides?.timezoneMode, overrides?.geolocationMode].some(
    (mode) => mode === 'based_ip',
  );
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
  const launchPolicy = resolveLaunchPolicy(params);
  // HC-3: host-calibrated derivation is the DEFAULT whenever a host profile has been captured. An
  // explicit `params.hostCalibration` (passed by the control plane) wins; otherwise, if a persisted
  // host profile exists (LOBSTER_HOST_CALIBRATION_FILE) and its OS matches this profile, use it. When
  // neither is present we fall back to the catalog path — unchanged behavior for CI/headless.
  const rendererWantsHostCalibration =
    launchPolicy.renderer.mode === 'host' || launchPolicy.renderer.mode === 'normalized_host';
  let hostCalibration = rendererWantsHostCalibration ? params.hostCalibration : undefined;
  if (!hostCalibration && rendererWantsHostCalibration) {
    // Gated on rendererWantsHostCalibration: a `validated_preset` profile has explicitly chosen a
    // SPECIFIC catalog GPU and must never be silently overridden by whatever this host happens to be
    // calibrated as (e.g. a dev box's real SwiftShader software renderer next to a claimed NVIDIA/AMD/
    // Intel persona — a severe, obvious coherence violation). Confirmed via a 20-profile fleet battle
    // test: every Linux fixture reported the host's real SwiftShader renderer on Sannysoft instead of
    // its requested preset, because this block used to run unconditionally whenever a persisted
    // calibration existed for the profile's OS, regardless of the requested renderer mode.
    const persisted = await loadHostCalibration(resolveHostCalibrationPath());
    if (
      persisted &&
      persisted.os === params.os &&
      (!params.arch || persisted.arch === params.arch)
    ) {
      hostCalibration = persisted;
    }
  }
  if (
    !hostCalibration &&
    rendererWantsHostCalibration &&
    params.os === runtimeHostOs() &&
    process.env.LOBSTER_AUTO_HOST_CALIBRATION !== '0'
  ) {
    const calibrationPath = resolveHostCalibrationPath();
    const captured = await ensureHostCalibration({
      ...(calibrationPath ? { path: calibrationPath } : {}),
      os: params.os,
      arch: process.arch === 'arm64' ? 'arm64' : 'x86_64',
      probe: captureHostCalibrationRawSnapshot,
    });
    hostCalibration = captured.profile;
  }

  const rendererPolicy = launchPolicy.renderer;
  if (
    (rendererPolicy.mode === 'host' || rendererPolicy.mode === 'normalized_host') &&
    !hostCalibration
  ) {
    // A CROSS-OS persona (e.g. a Windows/macOS profile on a Linux host) can NEVER be host-calibrated —
    // the host runs a different OS, so its real GPU is incoherent with the persona anyway. In that case
    // fall through to the persona's own catalog GPU (deriveFingerprint below): config.webgl is
    // authoritative for the reported renderer (verified — the engine reports config.webgl, not the real
    // backend), so the launch stays coherent instead of being refused. Only a SAME-OS "host" profile
    // that still lacks calibration is a genuine misconfiguration worth refusing.
    if (params.os === runtimeHostOs()) {
      throw new Error(
        `refusing to launch profile ${params.profileId}: renderer policy "${rendererPolicy.mode}" ` +
          'requires a complete compatible host calibration',
      );
    }
    console.warn(
      `[lobium] profile ${params.profileId}: renderer "${rendererPolicy.mode}" cannot be host-calibrated ` +
        `on a ${runtimeHostOs()} host for a ${params.os} persona — using the persona's catalog GPU instead.`,
    );
  }
  // Renderer policy owns the complete WebGL surface. Legacy profiles may still contain the old
  // ad-hoc `webgl` object; strip it at the launch boundary so it cannot overwrite host calibration or
  // a provenance-backed capture. Saving the profile through the unified editor removes it permanently.
  const launchOverrides: FingerprintOverrides | undefined = params.fingerprintOverrides
    ? { ...params.fingerprintOverrides }
    : undefined;
  if (launchOverrides) delete launchOverrides.webgl;
  const selectedPreset =
    rendererPolicy.mode === 'validated_preset'
      ? resolveSourcedRendererPreset(rendererPolicy.presetId)
      : undefined;
  if (rendererPolicy.mode === 'validated_preset' && !selectedPreset) {
    throw new Error(
      `refusing to launch profile ${params.profileId}: renderer preset ` +
        `"${rendererPolicy.presetId}" is not present in the sourced GPU catalog`,
    );
  }

  let baseFingerprint: Fingerprint;
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
    const hostIssues = validateHostCalibrationProfile(hostCalibration, {
      allowSoftwareRenderer: allowProvisionalSoftwareGpu(),
    });
    if (hostIssues.length > 0) {
      throw new Error(
        `refusing to launch profile ${params.profileId}: invalid host calibration ` +
          `(${hostIssues.length} issue${hostIssues.length === 1 ? '' : 's'}) — ${hostIssues.join('; ')}`,
      );
    }
    baseFingerprint = deriveFingerprintFromHost(params.fingerprintSeed, hostCalibration, {
      engine: params.engine,
    });
    if (rendererPolicy.mode === 'normalized_host') {
      baseFingerprint = {
        ...baseFingerprint,
        webgl: normalizeHostWebglIdentity(baseFingerprint.webgl),
      };
    }
  } else {
    baseFingerprint = deriveFingerprint(params.fingerprintSeed, {
      os: params.os,
      engine: params.engine,
      ...(params.arch ? { arch: params.arch } : {}),
    });
    if (selectedPreset) {
      if (selectedPreset.os !== params.os) {
        throw new Error(
          `refusing to launch profile ${params.profileId}: renderer preset OS ` +
            `"${selectedPreset.os}" does not match profile OS "${params.os}"`,
        );
      }
      baseFingerprint = {
        ...baseFingerprint,
        webgl: {
          ...selectedPreset.webgl,
          ...(selectedPreset.webgl.extensions
            ? { extensions: [...selectedPreset.webgl.extensions] }
            : {}),
        },
      };
    }
  }
  baseFingerprint = applyProfileOsVersion(baseFingerprint, params.osVersion);
  const overriddenFingerprint = applyOverrides(baseFingerprint, launchOverrides);
  let geo: GeoInfo | undefined;

  if (params.proxy) {
    // Fail closed on a dead upstream before geo overlay / engine spawn — otherwise the UI warns
    // about geo and still opens a blank Lobium window that cannot egress.
    await assertUpstreamReachable(toEnginePlaywrightProxy(params.proxy));
    if (requiresProxyGeo(params)) {
      try {
        geo = await deriveGeoFromExitIp(params.proxy);
      } catch (err) {
        if (isProxyUnreachableError(err) || explicitlyRequiresProxyGeo(params)) {
          const reason = explicitlyRequiresProxyGeo(params)
            ? 'proxy geo is required by a Based on IP persona setting'
            : 'proxy is unreachable';
          throw new Error(
            `refusing to launch profile ${params.profileId}: ${reason} — ` +
              (err instanceof Error ? err.message : String(err)),
          );
        }
        // Legacy profiles (no explicit modes) retain the old best-effort behavior for transient geo
        // provider errors. The persona resolver restores seed/host values instead of retaining stale
        // manual fields.
        console.warn(
          `[startProfile] proxy exit-IP geo derivation failed for profile ${params.profileId}; ` +
            'launching with the seed/host-derived locale/timezone, which may not match the proxy exit — ' +
            (err instanceof Error ? err.message : String(err)),
        );
      }
    }
  }

  let fingerprint = resolveFingerprintPersonaModes(
    baseFingerprint,
    overriddenFingerprint,
    launchOverrides,
    geo,
  );

  if (params.proxy && !geo && explicitlyRequiresProxyGeo(params)) {
    // Defensive invariant: the catch path above should already throw. Keep this guard next to the
    // resolved fingerprint so a future refactor cannot silently launch a Based-on-IP profile unbound.
    throw new Error(
      `refusing to launch profile ${params.profileId}: Based on IP persona settings require resolved proxy geo`,
    );
  }

  // Fail-closed coherence gate. The derived persona is always coherent, but user overrides (or a
  // failed geo overlay) can produce an IMPOSSIBLE device — e.g. macOS carrying a Direct3D renderer, or
  // a timezone that contradicts the locale. Launching such an identity defeats the entire anti-detect
  // purpose (it is trivially flagged), so refuse it with the specific violations instead.
  const issues = validateFingerprintCoherence(fingerprint).filter(
    (issue) =>
      !(allowProvisionalSoftwareGpu() && /software renderer|SwiftShader|llvmpipe/i.test(issue)),
  );
  if (issues.length > 0) {
    throw new Error(
      `refusing to launch profile ${params.profileId}: incoherent fingerprint ` +
        `(${issues.length} issue${issues.length === 1 ? '' : 's'}) — ${issues.join('; ')}`,
    );
  }

  const buildCapabilities = await runner.getLobiumBuildCapabilities();
  assertLobiumBuildCapabilities(
    buildCapabilities,
    requiredLobiumCapabilities(launchPolicy, fingerprint.locale.geolocation !== undefined),
  );
  const launchParams: LaunchParams = {
    profileId: params.profileId,
    ...(typeof params.profileName === 'string' ? { profileName: params.profileName } : {}),
    engine: params.engine,
    ...(typeof params.osVersion === 'string' ? { osVersion: params.osVersion } : {}),
    userDataDir: params.userDataDir,
    fingerprint,
    fingerprintPolicy: launchPolicy,
    webrtcPolicy: launchPolicy.webrtc,
    // Thread the seed so native farbling seeds are unique per profile (not per device class).
    fingerprintSeed: params.fingerprintSeed,
    ...(params.proxy ? { proxy: params.proxy } : {}),
    ...(params.cookiesImport ? { cookiesImport: params.cookiesImport } : {}),
    ...(Array.isArray(params.extensions) ? { extensions: params.extensions } : {}),
    ...(params.headless !== undefined ? { headless: params.headless } : {}),
  };
  return runner.launch(launchParams);
}
