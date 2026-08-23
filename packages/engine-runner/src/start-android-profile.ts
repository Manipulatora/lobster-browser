import {
  coherentGpuIdentity,
  deriveAndroidFingerprint,
  resolveFingerprintPersonaModes,
  validateAndroidFingerprintCoherence,
} from '@lobster/fingerprint';
import { deriveGeoFromExitIp, toEnginePlaywrightProxy } from '@lobster/proxy';
import type {
  AndroidFingerprint,
  FingerprintOverrides,
  GeoInfo,
  HardwareNoisePolicy,
  LaunchResult,
  MediaDeviceProfile,
  StartProfileParams,
} from '@lobster/shared-types';
import {
  AndroidDeviceBridge,
  buildAndroidLaunchPlan,
  type AdbClient,
  type AndroidLaunchPlan,
} from './android-bridge.js';
import { buildAndroidLobiumConfig, writeAndroidLobiumConfig } from './android-config.js';
import { basedOnIpPersonaKnobs } from './based-on-ip.js';
import { assertUpstreamReachable } from './proxy-auth-adapter.js';
import { resolveWebRtcPolicy } from './launch-policy.js';
import {
  launchAndroidMirror,
  type AndroidMirrorHandle,
  type AndroidMirrorOptions,
} from './android-mirror.js';
import { resolveDesktopWorkArea } from './device-frame.js';
import { assertValidFingerprintSeed } from './fingerprint-seed.js';

const DEFAULT_HARDWARE_NOISE: HardwareNoisePolicy = {
  webgl: true,
  canvas: true,
  audio: true,
  clientRects: false,
};

const DEFAULT_MEDIA_DEVICES: MediaDeviceProfile = {
  cameras: 1,
  microphones: 1,
  speakers: 1,
  stableDeviceIds: true,
};

export interface StartAndroidProfileOptions {
  /** Injected ADB client (tests). Defaults to system `adb`. */
  adb?: AdbClient;
  /** Prefer this device serial when multiple are attached. */
  serial?: string;
  /** Local TCP port for CDP forward (default 9222+hash). */
  cdpLocalPort?: number;
  /** Interactive real-device presentation. Tests inject a no-op handle. */
  launchMirror?: (options: AndroidMirrorOptions) => Promise<AndroidMirrorHandle>;
}

interface RunningAndroidProfile {
  bridge: AndroidDeviceBridge;
  plan: AndroidLaunchPlan;
  result: LaunchResult;
  mirror: AndroidMirrorHandle;
}

const runningAndroidProfiles = new Map<string, RunningAndroidProfile>();
// Held from the first line of a launch until the profile is either running or failed. The sidecar
// dispatches requests concurrently, so the map alone cannot keep one device/profile to a single
// session: two starts would both pass the check, forward the same CDP port twice and strand the
// first mirror window with no handle left to close it.
const startingAndroidProfiles = new Set<string>();

export function androidProfileStatus(profileId?: string): LaunchResult[] {
  return [...runningAndroidProfiles.entries()]
    .filter(([id]) => profileId === undefined || id === profileId)
    .map(([, running]) => ({ ...running.result }));
}

export async function stopAndroidProfile(profileId: string): Promise<boolean> {
  const running = runningAndroidProfiles.get(profileId);
  if (!running) return false;
  let failure: PromiseRejectedResult | undefined;
  try {
    const results = await Promise.allSettled([
      running.mirror.close(),
      running.bridge.stop(running.plan),
    ]);
    failure = results.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
  } finally {
    await running.bridge.removeCdpForward(running.plan).catch(() => undefined);
    runningAndroidProfiles.delete(profileId);
  }
  if (failure) throw failure.reason;
  return true;
}

function applyAndroidOverrides(
  fp: AndroidFingerprint,
  overrides: FingerprintOverrides | undefined,
): AndroidFingerprint {
  if (!overrides) return fp;
  const webgl = overrides.webgl ? { ...fp.webgl, ...overrides.webgl } : fp.webgl;
  const next: AndroidFingerprint = {
    ...fp,
    navigator: { ...fp.navigator, ...overrides.navigator },
    screen: { ...fp.screen, ...overrides.screen },
    ...coherentGpuIdentity(webgl),
    locale: { ...fp.locale, ...overrides.locale },
    fonts: overrides.fonts ?? fp.fonts,
    android: { ...fp.android },
  };
  return next;
}

function hashProfile(id: string): number {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h | 0;
}

function androidNeedsGeo(params: StartProfileParams): boolean {
  const overrides = params.fingerprintOverrides;
  return [overrides?.languageMode, overrides?.timezoneMode, overrides?.geolocationMode].some(
    (mode) => mode === undefined || mode === 'based_ip',
  );
}

function androidExplicitlyNeedsGeo(params: StartProfileParams): boolean {
  return basedOnIpPersonaKnobs(params).length > 0;
}

/**
 * Launch an Android Lobium profile on a USB-connected device via ADB.
 *
 * ADR-correct path: APK + config push + CDP forward — never a desktop Chromium process with an
 * Android UA. Requires `adb` and a device in `device` state with the Lobium APK installed.
 */
export async function startAndroidProfile(
  params: StartProfileParams,
  opts: StartAndroidProfileOptions = {},
): Promise<LaunchResult> {
  assertValidFingerprintSeed(params.fingerprintSeed, params.profileId);
  if (
    runningAndroidProfiles.has(params.profileId) ||
    startingAndroidProfiles.has(params.profileId)
  ) {
    throw new Error(`profile ${params.profileId} is already running`);
  }
  startingAndroidProfiles.add(params.profileId);
  try {
    return await launchAndroidProfile(params, opts);
  } finally {
    startingAndroidProfiles.delete(params.profileId);
  }
}

async function launchAndroidProfile(
  params: StartProfileParams,
  opts: StartAndroidProfileOptions,
): Promise<LaunchResult> {
  if (params.engine !== 'lobium') {
    throw new Error(
      `refusing to launch Android profile ${params.profileId}: Lobium is the only supported engine`,
    );
  }
  if (params.os !== 'android') {
    throw new Error(
      `startAndroidProfile requires os=android (got "${String(params.os)}"); use startProfile for desktop`,
    );
  }
  // No proxy is not a reason to refuse: a direct profile exits from this machine's own IP,
  // and Based-on-IP resolves against that. Matches the desktop path in start-profile.ts.

  const bridge = new AndroidDeviceBridge(opts.adb);
  const devices = await bridge.listDevices();
  const ready = devices.filter((d) => d.state === 'device');
  if (ready.length === 0) {
    throw new Error(
      `refusing to launch Android profile ${params.profileId}: no ADB device in "device" state ` +
        `(found ${devices.length} listed). Connect a phone/emulator with USB debugging and install the Lobium APK.`,
    );
  }
  const serial = opts.serial ?? ready[0]?.serial;
  if (!serial) {
    throw new Error(
      `refusing to launch Android profile ${params.profileId}: missing device serial`,
    );
  }

  const baseFingerprint = deriveAndroidFingerprint(params.fingerprintSeed, {
    engine: 'lobium',
    ...(params.osVersion ? { osVersion: params.osVersion } : {}),
    ...(params.fingerprintOverrides?.androidDeviceType
      ? { deviceType: params.fingerprintOverrides.androidDeviceType }
      : {}),
    ...(params.fingerprintOverrides?.androidDeviceModel
      ? { deviceModel: params.fingerprintOverrides.androidDeviceModel }
      : {}),
  });
  const overriddenFingerprint = applyAndroidOverrides(baseFingerprint, params.fingerprintOverrides);
  let geo: GeoInfo | undefined;

  if (params.proxy) {
    await assertUpstreamReachable(toEnginePlaywrightProxy(params.proxy));
    try {
      if (androidNeedsGeo(params)) geo = await deriveGeoFromExitIp(params.proxy);
    } catch (error) {
      if (androidExplicitlyNeedsGeo(params)) {
        throw new Error(
          `refusing to launch Android profile ${params.profileId}: proxy geo is required by a ` +
            `Based on IP persona setting — ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      // Legacy profiles retain best-effort geo behavior.
    }
  }

  const fingerprint = resolveFingerprintPersonaModes(
    baseFingerprint,
    overriddenFingerprint,
    params.fingerprintOverrides,
    geo,
  );

  const issues = validateAndroidFingerprintCoherence(fingerprint);
  if (issues.length > 0) {
    throw new Error(
      `refusing to launch Android profile ${params.profileId}: incoherent fingerprint: ${issues.join('; ')}`,
    );
  }

  const config = buildAndroidLobiumConfig(fingerprint, {
    seed: params.fingerprintSeed,
    ...(params.proxy
      ? { proxy: { type: params.proxy.type, host: params.proxy.host, port: params.proxy.port } }
      : {}),
    webrtcPolicy: resolveWebRtcPolicy(params),
    ...(params.fingerprintOverrides?.renderer
      ? { rendererPolicy: params.fingerprintOverrides.renderer }
      : {}),
    hardwareNoise: {
      ...DEFAULT_HARDWARE_NOISE,
      ...params.fingerprintOverrides?.hardwareNoise,
    },
    mediaDevices: {
      ...DEFAULT_MEDIA_DEVICES,
      ...params.fingerprintOverrides?.mediaDevices,
    },
  });
  const localConfigPath = await writeAndroidLobiumConfig(params.userDataDir, config);

  const cdpLocalPort = opts.cdpLocalPort ?? 9222 + (Math.abs(hashProfile(params.profileId)) % 1000);
  const plan = buildAndroidLaunchPlan({
    serial,
    profileId: params.profileId,
    localConfigPath,
    cdpLocalPort,
  });

  try {
    await bridge.prepareLaunch(plan);
    await bridge.start(plan);
  } catch (error) {
    await bridge.removeCdpForward(plan).catch(() => undefined);
    throw error;
  }

  let mirror: AndroidMirrorHandle;
  try {
    // Measured, never assumed: the mirror window is centered and clamped against the real work area,
    // which on Windows comes from the display rather than the POSIX-only LOBSTER_DESKTOP_* variables.
    const workArea = await resolveDesktopWorkArea();
    mirror = await (opts.launchMirror ?? launchAndroidMirror)({
      serial,
      ...(params.profileName ? { profileName: params.profileName } : {}),
      width: fingerprint.screen.width,
      height: fingerprint.screen.height,
      desktopWidth: workArea.width,
      desktopHeight: workArea.height,
    });
  } catch (error) {
    await bridge.stop(plan).catch(() => undefined);
    await bridge.removeCdpForward(plan).catch(() => undefined);
    throw error;
  }

  // ADB `am start` does not return the app PID reliably; expose CDP for automation.
  const result: LaunchResult = {
    profileId: params.profileId,
    pid: 0,
    ws: `ws://127.0.0.1:${cdpLocalPort}/devtools/browser`,
    debuggerAddress: `127.0.0.1:${cdpLocalPort}`,
  };
  runningAndroidProfiles.set(params.profileId, { bridge, plan, result, mirror });
  return result;
}
