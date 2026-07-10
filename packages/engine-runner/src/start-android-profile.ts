import {
  applyGeoToFingerprint,
  deriveAndroidFingerprint,
  validateAndroidFingerprintCoherence,
} from '@lobster/fingerprint';
import { deriveGeoFromExitIp } from '@lobster/proxy';
import type {
  AndroidFingerprint,
  FingerprintOverrides,
  HardwareNoisePolicy,
  LaunchResult,
  MediaDeviceProfile,
  StartProfileParams,
} from '@lobster/shared-types';
import {
  AndroidDeviceBridge,
  buildAndroidLaunchPlan,
  type AdbClient,
} from './android-bridge.js';
import {
  buildAndroidLobiumConfig,
  writeAndroidLobiumConfig,
} from './android-config.js';

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
}

function applyAndroidOverrides(
  fp: AndroidFingerprint,
  overrides: FingerprintOverrides | undefined,
): AndroidFingerprint {
  if (!overrides) return fp;
  const next: AndroidFingerprint = {
    ...fp,
    navigator: { ...fp.navigator, ...overrides.navigator },
    screen: { ...fp.screen, ...overrides.screen },
    webgl: { ...fp.webgl, ...overrides.webgl },
    locale: { ...fp.locale, ...overrides.locale },
    fonts: overrides.fonts ?? fp.fonts,
    android: { ...fp.android },
  };
  if (overrides.androidDeviceModel) {
    next.android = { ...next.android, model: overrides.androidDeviceModel };
    next.navigator = { ...next.navigator, uaModel: overrides.androidDeviceModel };
  }
  if (overrides.androidDeviceCode) {
    next.android = { ...next.android, device: overrides.androidDeviceCode };
  }
  if (overrides.androidDeviceType) {
    next.android = {
      ...next.android,
      formFactor: overrides.androidDeviceType === 'tablet' ? 'tablet' : 'phone',
    };
  }
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
    throw new Error(`refusing to launch Android profile ${params.profileId}: missing device serial`);
  }

  let fingerprint = deriveAndroidFingerprint(params.fingerprintSeed, { engine: 'lobium' });
  fingerprint = applyAndroidOverrides(fingerprint, params.fingerprintOverrides);

  if (params.proxy) {
    try {
      const geo = await deriveGeoFromExitIp(params.proxy);
      fingerprint = applyGeoToFingerprint(fingerprint, geo);
    } catch {
      // Best-effort geo; Android launch still proceeds without proxy-exit locale.
    }
  }

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

  await bridge.prepareLaunch(plan);
  await bridge.start(plan);

  // ADB `am start` does not return the app PID reliably; expose CDP for automation.
  return {
    profileId: params.profileId,
    pid: 0,
    ws: `ws://127.0.0.1:${cdpLocalPort}/devtools/browser`,
    debuggerAddress: `127.0.0.1:${cdpLocalPort}`,
  };
}
