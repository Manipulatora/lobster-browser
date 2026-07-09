import type { EngineKind, OsFamily } from './engine.js';
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
}

/**
 * High-level launch from a profile's stored fields: the sidecar derives the fingerprint from the
 * seed (+ overrides + best-effort proxy-exit geo) and launches. This is what the Rust local API
 * sends, so the Rust core only forwards profile data — it never computes fingerprints.
 */
export interface StartProfileParams {
  profileId: string;
  engine: EngineKind;
  os: OsFamily;
  osVersion?: string;
  /**
   * Optional host snapshot captured by the desktop control plane. When present, the sidecar derives the
   * profile from the real host hardware instead of the fallback catalog. The snapshot OS must match
   * `os`; Android uses a separate runner path and never arrives here.
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
}

export interface StopParams {
  profileId: string;
}

export interface StatusParams {
  profileId?: string;
}

export interface StatusResult {
  running: Array<{ profileId: string; pid: number; ws: string; debuggerAddress: string }>;
}
