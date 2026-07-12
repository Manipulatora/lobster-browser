import type { CpuArch, EngineKind, OsFamily } from './engine.js';
import type {
  Fingerprint,
  FingerprintLaunchPolicy,
  FingerprintOverrides,
  FingerprintSeed,
  HostCalibrationProfile,
  WebRtcPolicy,
} from './fingerprint.js';
import type { BrowserExtensionRef, CookieImportDraft } from './profile.js';
import type { ProxyConfig } from './proxy.js';

/**
 * The stable local IPC contract between the Rust desktop core (control plane) and the
 * Node engine-runner sidecar. Newline-delimited JSON over stdio. The Rust side owns
 * privilege/auth; the sidecar only launches and controls engines.
 *
 * See docs/contracts/sidecar-ipc.md for the full spec.
 */

export type SidecarMethod =
  | 'startProfile'
  | 'launch'
  | 'stop'
  | 'status'
  | 'exportCookies'
  | 'ping'
  | 'ensureHostCalibration';

export interface SidecarRequest<M extends SidecarMethod = SidecarMethod, P = unknown> {
  /** Correlation id echoed back in the response. */
  id: string;
  method: M;
  params: P;
}

export interface SidecarResponse<R = unknown> {
  id: string;
  ok: boolean;
  result?: R;
  error?: { code: string; message: string };
}

export interface LaunchParams {
  profileId: string;
  /** Human-readable Lobster profile name for NTP / chrome profile labeling. */
  profileName?: string;
  engine: EngineKind;
  /** Profile-selected OS build/version label, when present. */
  osVersion?: string;
  /** Absolute path to the per-profile persistent user-data-dir. */
  userDataDir: string;
  /** Fully-resolved coherent fingerprint (deep surfaces handled natively by the engine). */
  fingerprint: Fingerprint;
  /** Native launch policy resolved from profile overrides and proxy state. */
  fingerprintPolicy?: FingerprintLaunchPolicy;
  /** Final WebRTC policy used by launch flags and native config. */
  webrtcPolicy?: WebRtcPolicy;
  /**
   * The profile's fingerprint seed. Threaded to the native config so per-profile farbling seeds
   * (canvas/WebGL/audio) derive from the UNIQUE profile seed rather than the device signature —
   * otherwise two profiles that derive the same device class share farbling seeds and produce
   * identical, linkable canvas/audio hashes (violating the distinct-per-profile requirement, §5).
   */
  fingerprintSeed?: string;
  proxy?: ProxyConfig;
  cookiesImport?: CookieImportDraft;
  extensions?: BrowserExtensionRef[];
  headless?: boolean;
  /**
   * True for an Android persona launched as an emulated mobile Chrome (native Lobium, a real window,
   * no ADB/APK) — see `start-android-emulated-profile.ts`. The launcher centers the window and
   * applies CDP touch/device-metrics emulation so the window behaves like a phone viewport instead
   * of a plain desktop window that merely claims a mobile UA.
   */
  isMobileProfile?: boolean;
}

/**
 * High-level launch from a profile's stored fields: the sidecar derives the fingerprint from the
 * seed (+ overrides + best-effort proxy-exit geo) and launches. This is what the Rust local API
 * sends, so the Rust core only forwards profile data — it never computes fingerprints.
 */
export interface StartProfileParams {
  profileId: string;
  /** Human-readable Lobster profile name for NTP / chrome profile labeling. */
  profileName?: string;
  engine: EngineKind;
  /**
   * Launch OS. Desktop targets are `windows`/`macos`/`linux`. `android` defaults to an EMULATED
   * mobile Chrome — native Lobium, a real phone-sized window, no hardware required (see
   * `start-android-emulated-profile.ts`); set `androidTransport: 'adb'` to instead route to the
   * ADB/APK real-device runner.
   */
  os: OsFamily | 'android';
  /** Optional architecture requested by a user-facing target such as macOS Intel vs macOS Arm. */
  arch?: CpuArch;
  osVersion?: string;
  /**
   * How an `os: 'android'` profile launches. Default (omitted) is the emulated native path. `'adb'`
   * requires a connected device/emulator with the Lobium APK installed. Ignored for non-Android OS.
   */
  androidTransport?: 'adb';
  /**
   * Optional host snapshot captured by the desktop control plane. When present, the sidecar derives the
   * profile from the real host hardware instead of the fallback catalog. The snapshot OS must match
   * `os`; Android (either transport) never arrives here.
   */
  hostCalibration?: HostCalibrationProfile;
  fingerprintSeed: FingerprintSeed;
  fingerprintOverrides?: FingerprintOverrides;
  proxy?: ProxyConfig;
  cookiesImport?: CookieImportDraft;
  extensions?: BrowserExtensionRef[];
  /** Absolute path to the per-profile persistent user-data-dir. */
  userDataDir: string;
  headless?: boolean;
}

export interface LaunchResult {
  profileId: string;
  pid: number;
  /** CDP websocket URL for connectOverCDP. */
  ws: string;
  /** host:port for Selenium debuggerAddress. */
  debuggerAddress: string;
  /** True only after the pending one-shot import completed successfully over CDP. */
  cookieImportApplied?: boolean;
}

export interface StopParams {
  profileId: string;
}

export interface StatusParams {
  profileId?: string;
}

export interface StatusResult {
  running: Array<{ profileId: string; pid: number; ws: string; debuggerAddress: string }>;
  /** Recent out-of-band exits caused by a fail-closed network/upstream error. */
  errors?: Array<{ profileId: string; message: string }>;
}

export interface ExportCookiesParams {
  profileId: string;
}

export interface ExportCookiesResult {
  profileId: string;
  /** Playwright/CDP-style JSON. This is a local, explicit secret export. */
  json: string;
}
