import {
  applyOverrides,
  coherentGpuIdentity,
  deriveFingerprintFromHost,
  deriveFingerprint,
  normalizeHostWebglIdentity,
  resolveSourcedRendererPreset,
  resolveFingerprintPersonaModes,
  validateFingerprintCoherence,
} from '@lobster/fingerprint';
import {
  deriveGeoFromDirectIp,
  deriveGeoFromExitIp,
  toEnginePlaywrightProxy,
} from '@lobster/proxy';
import type {
  Fingerprint,
  FingerprintOverrides,
  GeoInfo,
  LaunchParams,
  LaunchResult,
  StartProfileParams,
} from '@lobster/shared-types';
import { basedOnIpPersonaKnobs } from './based-on-ip.js';
import { assertUpstreamReachable } from './proxy-auth-adapter.js';
import { resolveLaunchPolicy } from './launch-policy.js';
import type { EngineRunner } from './runner.js';
import {
  hostCalibrationIssues,
  loadHostCalibration,
  resolveHostCalibrationPath,
} from './host-calibration-store.js';
import { allowProvisionalSoftwareGpu } from './gpu.js';
import {
  assertLobiumBuildCapabilities,
  requiredLobiumCapabilities,
} from './lobium-capabilities.js';
import { ensureHostCalibration } from './ensure-host-calibration.js';
import { captureHostCalibrationRawSnapshot } from './capture-host-calibration.js';
import { assertValidFingerprintSeed } from './fingerprint-seed.js';

/** True when a geo/proxy error means the upstream is dead — fail closed, do not launch. */
function isProxyUnreachableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unreachable|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|Proxy connection timed out|SOCKS geo lookup timed out|connect ETIMEDOUT|connect ECONNREFUSED|HTTP 407|proxy authentication|authentication failed|invalid credentials|Socks5 Authentication/i.test(
    msg,
  );
}

function runtimeHostOs(): Fingerprint['os'] {
  if (process.platform === 'darwin') return 'macos';
  if (process.platform === 'win32') return 'windows';
  return 'linux';
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
  return basedOnIpPersonaKnobs(params).length > 0;
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
  assertValidFingerprintSeed(params.fingerprintSeed, params.profileId);
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
  // Why the capture failure is context and not the thrown error: this step is opportunistic (it only
  // runs when the persona's OS matches this machine's, and `LOBSTER_AUTO_HOST_CALIBRATION=0` turns it
  // off entirely), so letting it own the launch failure made the reported error depend on the HOST
  // OS — a Windows persona on Linux reported the actionable renderer-policy refusal below, while the
  // very same profile on a Windows host reported "cannot capture host calibration: Lobium binary is
  // unavailable". Both describe the same missing evidence. Keep the reason, let the policy gate speak.
  let hostCalibrationCaptureFailure: string | undefined;
  if (
    !hostCalibration &&
    rendererWantsHostCalibration &&
    params.os === runtimeHostOs() &&
    process.env.LOBSTER_AUTO_HOST_CALIBRATION !== '0'
  ) {
    const calibrationPath = resolveHostCalibrationPath();
    try {
      const captured = await ensureHostCalibration({
        ...(calibrationPath ? { path: calibrationPath } : {}),
        os: params.os,
        arch: process.arch === 'arm64' ? 'arm64' : 'x86_64',
        probe: captureHostCalibrationRawSnapshot,
      });
      hostCalibration = captured.profile;
    } catch (err) {
      hostCalibrationCaptureFailure = err instanceof Error ? err.message : String(err);
    }
  }

  const rendererPolicy = launchPolicy.renderer;
  // Was "host" a deliberate choice, or just the default nobody picked? `resolveLaunchPolicy` falls
  // back to DEFAULT_RENDERER_POLICY = { mode: 'host' } whenever the profile carries no renderer
  // override, which is every seed-derived profile. The distinction decides whether a missing
  // calibration is a refusal or a fallback.
  const rendererWasChosen = params.fingerprintOverrides?.renderer !== undefined;
  if (
    (rendererPolicy.mode === 'host' || rendererPolicy.mode === 'normalized_host') &&
    !hostCalibration
  ) {
    if (rendererWasChosen) {
      // An EXPLICIT host policy asserts measured evidence. Substituting a catalog renderer would
      // silently change what the user asked for and can create a detectable GPU/OS mismatch, so it
      // still fails closed. Any first-run capture attempt that just failed is appended so the root
      // cause is not lost.
      throw new Error(
        `refusing to launch profile ${params.profileId}: renderer policy "${rendererPolicy.mode}" ` +
          'requires a complete compatible host calibration' +
          (hostCalibrationCaptureFailure ? ` (${hostCalibrationCaptureFailure})` : ''),
      );
    }
    // DEFAULTED policy with no usable calibration — the ordinary case for a cross-OS persona, e.g. a
    // Windows profile on a Linux machine, where a host capture can never match by construction.
    // Refusing here made the product's core use case unlaunchable. Fall through to the catalog path
    // instead: `deriveFingerprint` pairs the seed with a REAL renderer from that OS's own catalog
    // (deriveCoherentDevice), which is coherent for the persona rather than borrowed from this host.
    hostCalibration = undefined;
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
    const hostIssues = hostCalibrationIssues(hostCalibration, {
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
      const webgl = normalizeHostWebglIdentity(baseFingerprint.webgl);
      baseFingerprint = {
        ...baseFingerprint,
        ...coherentGpuIdentity(webgl),
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
      const webgl = {
        ...selectedPreset.webgl,
        ...(selectedPreset.webgl.extensions
          ? { extensions: [...selectedPreset.webgl.extensions] }
          : {}),
      };
      baseFingerprint = {
        ...baseFingerprint,
        ...coherentGpuIdentity(webgl),
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
  } else if (requiresProxyGeo(params)) {
    // NO PROXY IS NOT A REASON TO REFUSE. A direct profile still has an exit IP — this machine's —
    // so "Based on IP" resolves against that instead of being treated as unanswerable. This is what
    // keeps the persona coherent: locale, timezone and geolocation all agree with the address the
    // traffic actually leaves from. The launcher previously threw here (`assertBasedOnIpHasProxy`),
    // which made a profile created with the editor's own defaults unlaunchable until a proxy was
    // attached.
    //
    // Best-effort by design: if the lookup fails there is nothing dishonest about falling back to
    // the seed-derived locale, because no proxy means no claim about a foreign exit was ever made.
    try {
      geo = await deriveGeoFromDirectIp();
    } catch (err) {
      console.warn(
        `[startProfile] direct exit-IP geo derivation failed for profile ${params.profileId}; ` +
          'launching with the seed-derived locale/timezone — ' +
          (err instanceof Error ? err.message : String(err)),
      );
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
