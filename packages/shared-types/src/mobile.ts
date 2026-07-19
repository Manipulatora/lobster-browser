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
 * Island — the OS-embedded app-sandboxing capability. This is NOT an app: it lives in the Lobium
 * Android framework (an AOSP fork, `aosp/`) as a system service that sandboxes apps at install time by
 * default. There is nothing to install or provision — the OS itself, on every third-party install,
 * places the app into an isolated Android profile so its storage/accounts/cookies are walled off from
 * other apps and from the main space ("secure app install + account protection").
 *
 * This object is the per-machine policy the OS reads: a baked default (`aosp/config/sandbox-policy.xml`)
 * overlaid by a per-machine file staged at boot. It cannot turn the capability off — only shape it.
 */
export type IslandSandboxMode = 'all' | 'selected';

export interface IslandConfig {
  /** Always true — the capability is compiled into the OS framework, never user-installed. */
  builtIn: true;
  /**
   * `all` (OS default): every third-party app is sandboxed on install. `selected`: only the packages in
   * {@link sandboxedApps} are sandboxed; everything else installs normally.
   */
  mode: IslandSandboxMode;
  /** Packages always sandboxed when `mode === 'selected'` (ignored when `mode === 'all'`). */
  sandboxedApps: string[];
  /** `per-app` = a dedicated isolated profile per app (strongest); `shared` = one sandbox profile. */
  isolation: 'per-app' | 'shared';
  /** Freeze (force-stop) sandboxed apps when idle so they cannot run or phone home in the background. */
  freezeIdleApps: boolean;
}

export const DEFAULT_ISLAND_CONFIG: IslandConfig = {
  builtIn: true,
  mode: 'all',
  sandboxedApps: [],
  isolation: 'per-app',
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
