/**
 * Mobile machines — per-profile isolated Android emulators (AVD/QEMU), each a full Android OS.
 *
 * Distinct from a browser {@link Profile}: a machine is a provisioned virtual device with its own
 * userdata, Google Play, arbitrary APK install, and the built-in Island isolation service. Managed on
 * the user's machine (local execution); one AVD per machine, cloned copy-on-write from a golden image.
 */

import type { FingerprintOverrides, FingerprintSeed } from './fingerprint.js';
import type { ProxyConfig } from './proxy.js';

/** The "device class" the machine presents — real hardware + build.prop persona, not a random spoof. */
export const ANDROID_MACHINE_TYPES = [
  'pixel_8_pro',
  'pixel_8',
  'pixel_7',
  'pixel_6a',
  'samsung_galaxy_s23',
  'samsung_galaxy_s22',
  'samsung_galaxy_a54',
  'xiaomi_13',
  'oneplus_11',
  'generic_phone',
] as const;
export type AndroidMachineType = (typeof ANDROID_MACHINE_TYPES)[number];

/** Supported Android platform: API level ↔ release (34=14, 33=13, 32=12L, 31=12, 30=11). */
export const ANDROID_API_LEVELS = [34, 33, 32, 31, 30] as const;
export type AndroidApiLevel = (typeof ANDROID_API_LEVELS)[number];

/**
 * Built-in Island isolation. This ships as a **system app** in the golden image and is auto-provisioned
 * as **device owner** at first boot — it is NEVER installed by the user from Google Play. It provides
 * the "secure app install + account protection" capability: account-holding apps are placed into an
 * isolated managed profile so their data is sandboxed away from the main space and from each other.
 */
export interface IslandConfig {
  /** Always present — the isolation service is baked into every Lobium machine image. */
  builtIn: true;
  /**
   * App packages routed into the isolated container BY DEFAULT on install (e.g. mail/social/banking).
   * The user never has to configure this per machine; it is applied by the image's install router.
   */
  isolateOnInstall: string[];
  /** Freeze (hibernate) isolated apps when idle so they cannot run or phone home in the background. */
  freezeIdleApps: boolean;
}

export const DEFAULT_ISLAND_CONFIG: IslandConfig = {
  builtIn: true,
  isolateOnInstall: [],
  freezeIdleApps: true,
};

export type MobileMachineStatus =
  | 'stopped'
  | 'provisioning'
  | 'booting'
  | 'running'
  | 'stopping'
  | 'error';

export interface MobileMachineConfig {
  machineType: AndroidMachineType;
  apiLevel: AndroidApiLevel;
  /** Deterministic seed; build.prop, sensors, GPU/GL strings, IMEI/serial all derive from it. */
  fingerprintSeed: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  /** Per-machine egress; coherent with the fingerprint geo. */
  proxy?: ProxyConfig;
  proxyId?: string;
  /** Google Play (GApps) present in the image, vs. a sideload-only image. */
  playServices: boolean;
  /** Built-in Island isolation — always on. */
  island: IslandConfig;
}

export interface MobileMachine {
  id: string;
  name: string;
  config: MobileMachineConfig;
  status: MobileMachineStatus;
  /** ADB serial once booted (e.g. `emulator-5554`). */
  adbSerial?: string;
  /** CDP endpoint of the in-machine browser, for the app + Lob to drive. */
  cdpEndpoint?: string;
  tags: string[];
  notes?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CreateMobileMachineInput {
  name: string;
  machineType: AndroidMachineType;
  apiLevel: AndroidApiLevel;
  fingerprintSeed?: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  proxyId?: string;
  proxy?: ProxyConfig;
  /** Defaults to true (Play image). */
  playServices?: boolean;
  /** Overrides on top of {@link DEFAULT_ISLAND_CONFIG}; Island itself is never disable-able. */
  island?: Partial<Omit<IslandConfig, 'builtIn'>>;
  tags?: string[];
  notes?: string;
}
