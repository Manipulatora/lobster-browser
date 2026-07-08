import type {
  EngineKind,
  Fingerprint,
  FingerprintLaunchPolicy,
  WebRtcPolicy,
} from '@lobster/shared-types';
import type { CdpEmulation, PersistentLaunchOptions } from '../launch.js';

/** Everything a concrete engine launcher needs — prepared by the CompositeRunner from a profile. */
export interface LaunchContext {
  profileId: string;
  engine: EngineKind;
  /** Profile-selected OS build/version label, when present. */
  osVersion?: string;
  /** The fully-resolved fingerprint — used to apply CDP overrides on each page. */
  fingerprint: Fingerprint;
  /** Native policy fields resolved from profile overrides and proxy state. */
  fingerprintPolicy?: FingerprintLaunchPolicy;
  /** Final WebRTC policy used by launch flags and native config. */
  webrtcPolicy?: WebRtcPolicy;
  /** The profile's fingerprint seed — the native launcher derives per-profile farbling seeds from it. */
  fingerprintSeed?: string;
  options: PersistentLaunchOptions;
  emulation: CdpEmulation;
  initScript: string;
}

/** A live engine instance the runner tracks. */
export interface LaunchHandle {
  pid: number;
  /** CDP websocket URL for `connectOverCDP`. */
  ws: string;
  /** host:port for Selenium `debuggerAddress`. */
  debuggerAddress: string;
  close(): Promise<void>;
  /**
   * Register a listener fired when the browser closes for ANY reason — explicit `close()`, a crash, or
   * the user closing the window externally. The CompositeRunner uses it to evict the profile from its
   * running map so a stale entry can't block relaunch after a crash. Optional so fakes/tests can omit it.
   */
  onClose?(listener: () => void): void;
}

/**
 * Launches one engine family. The real implementation wraps patchright driving a patched Chromium
 * (chromium/lobium); it is injected so the orchestration is fully testable with a fake.
 */
export type Launcher = (ctx: LaunchContext) => Promise<LaunchHandle>;

/** Maps each engine to its launcher. Missing entries mean "engine not available". */
export type LauncherRegistry = Partial<Record<EngineKind, Launcher>>;
