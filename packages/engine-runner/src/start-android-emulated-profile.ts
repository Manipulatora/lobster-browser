import {
  deriveAndroidFingerprint,
  resolveFingerprintPersonaModes,
  validateAndroidFingerprintCoherence,
} from '@lobster/fingerprint';
import { deriveGeoFromExitIp, toEnginePlaywrightProxy } from '@lobster/proxy';
import type {
  Fingerprint,
  GeoInfo,
  LaunchParams,
  LaunchResult,
  StartProfileParams,
} from '@lobster/shared-types';
import { assertUpstreamReachable } from './proxy-auth-adapter.js';
import { resolveLaunchPolicy } from './launch-policy.js';
import type { EngineRunner } from './runner.js';
import {
  assertLobiumBuildCapabilities,
  requiredLobiumCapabilities,
} from './lobium-capabilities.js';
import { assertValidFingerprintSeed } from './fingerprint-seed.js';

/** True for the codes `deriveGeoFromExitIp`/upstream checks raise when the proxy is genuinely dead. */
function isProxyUnreachableError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /unreachable|ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|Proxy connection timed out|SOCKS geo lookup timed out|connect ETIMEDOUT|connect ECONNREFUSED|HTTP 407|proxy authentication|authentication failed|invalid credentials|Socks5 Authentication/i.test(
    msg,
  );
}

/**
 * Launch an Android persona as an EMULATED mobile Chrome: native Lobium (the same engine, config
 * channel, farbling, proxy, cookie-import, and font pipeline every desktop profile uses), in a real,
 * centered, native rectangle device stage inside the normal Lobium window with CDP touch/device-metrics
 * emulation — not a physical device/APK.
 *
 * This is the default Android path (see `rpc.ts` dispatch); `startAndroidProfile` (ADB/APK, a real
 * connected device) remains available via `params.androidTransport === 'adb'` for anyone who wants
 * to test against real hardware, but a normal profile launch no longer requires one.
 *
 * Deliberately independent from `startProfile` (the desktop windows/macos/linux path): that function's
 * host-calibration and validated-GPU-preset machinery models a REAL host GPU being calibrated against,
 * which has no Android equivalent (there is no "the host's phone GPU" to calibrate) — reusing it here
 * would either misfire or require threading Android through every desktop-only branch. `AndroidFingerprint`
 * and `Fingerprint` are structurally identical (`navigator`/`screen`/`webgl`/`locale`/`fonts`; `os`/`arch`
 * differ only in their literal-type tag, which native code and `buildLobiumConfig` never branch on — see
 * `lobium-config.ts` and `lobium_fp_config.cc`), so the derived persona is projected into a `Fingerprint`
 * or the native launcher and every OS/proxy/coherence/policy step downstream is standard.
 */
export async function startAndroidEmulatedProfile(
  runner: EngineRunner,
  params: StartProfileParams,
): Promise<LaunchResult> {
  assertValidFingerprintSeed(params.fingerprintSeed, params.profileId);
  if (params.engine !== 'lobium') {
    throw new Error(
      `refusing to launch profile ${params.profileId}: Lobium is the only supported engine`,
    );
  }
  // No proxy is not a reason to refuse: a direct profile exits from this machine's own IP,
  // and Based-on-IP resolves against that. Matches the desktop path in start-profile.ts.
  // Resolved before any proxy probe or persona derivation so an unsafe/invalid persona policy refuses
  // the launch immediately, exactly as it does on the desktop path.
  const launchPolicy = resolveLaunchPolicy(params, {
    // The WebGL identity below always comes from Android's own device catalog (Adreno/Mali-class),
    // never a host GPU capture — 'validated_preset' is the policy mode that means exactly that
    // ("a pre-validated catalog persona, not host calibration"), even though no
    // `resolveSourcedRendererPreset` lookup runs; native code never reads this mode (only the JS
    // launch-policy bookkeeping and the required-capability list below do). A desktop renderer
    // override cannot apply to a phone, so it is deliberately not honored here.
    renderer: { mode: 'validated_preset', presetId: 'android-device-catalog' },
  });
  const deviceType = params.fingerprintOverrides?.androidDeviceType ?? 'mobile';
  const deviceModel = params.fingerprintOverrides?.androidDeviceModel;
  const base = deriveAndroidFingerprint(params.fingerprintSeed, {
    engine: params.engine,
    deviceType,
    ...(deviceModel ? { deviceModel } : {}),
    ...(params.osVersion ? { osVersion: params.osVersion } : {}),
  });

  let geo: GeoInfo | undefined;
  if (params.proxy) {
    // Fail closed on a dead upstream before geo overlay / engine spawn — same as the desktop path:
    // otherwise the UI warns about geo and still opens a phone window that cannot egress.
    await assertUpstreamReachable(toEnginePlaywrightProxy(params.proxy));
    try {
      geo = await deriveGeoFromExitIp(params.proxy);
    } catch (err) {
      if (isProxyUnreachableError(err)) {
        throw new Error(
          `refusing to launch profile ${params.profileId}: proxy is unreachable — ` +
            (err instanceof Error ? err.message : String(err)),
        );
      }
      console.warn(
        `[startAndroidEmulatedProfile] proxy exit-IP geo derivation failed for profile ` +
          `${params.profileId}; launching with the seed-derived locale/timezone, which may not match ` +
          `the proxy exit — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // No separate "overridden" persona for Android v1 (font/language/timezone manual overrides on top
  // of the derived device are not yet exposed for Android in the UI) — base and overridden are the
  // same value, so `resolveFingerprintPersonaModes` just applies proxy-geo (based_ip, the default) or
  // keeps the derived persona (manual, when there is no proxy).
  const android = resolveFingerprintPersonaModes(base, base, params.fingerprintOverrides, geo);

  const coherenceIssues = validateAndroidFingerprintCoherence(android);
  if (coherenceIssues.length > 0) {
    throw new Error(
      `refusing to launch profile ${params.profileId}: incoherent Android persona ` +
        `(${coherenceIssues.length} issue${coherenceIssues.length === 1 ? '' : 's'}) — ` +
        coherenceIssues.join('; '),
    );
  }

  // Project onto the desktop `Fingerprint` shape the native launcher/config-channel pipeline is typed
  // for. `os`/`arch` are carried as literal tags only (see the capability comment above); every other
  // field is copied verbatim from the derived, geo-resolved Android persona.
  const fingerprint: Fingerprint = {
    os: 'linux',
    arch: 'arm64',
    navigator: android.navigator,
    screen: android.screen,
    webgl: android.webgl,
    webgpu: android.webgpu,
    locale: android.locale,
    fonts: android.fonts,
  };

  const buildCapabilities = await runner.getLobiumBuildCapabilities();
  assertLobiumBuildCapabilities(
    buildCapabilities,
    requiredLobiumCapabilities(
      launchPolicy,
      fingerprint.locale.geolocation !== undefined,
      process.platform,
      true,
    ),
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
    fingerprintSeed: params.fingerprintSeed,
    ...(params.proxy ? { proxy: params.proxy } : {}),
    ...(params.cookiesImport ? { cookiesImport: params.cookiesImport } : {}),
    ...(Array.isArray(params.extensions) ? { extensions: params.extensions } : {}),
    ...(params.headless !== undefined ? { headless: params.headless } : {}),
    isMobileProfile: true,
    mobileFormFactor: android.android.formFactor,
  };
  return runner.launch(launchParams);
}
