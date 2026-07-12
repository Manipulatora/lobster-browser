import type {
  BrowserExtensionRef,
  CookieImportDraft,
  EngineKind,
  Fingerprint,
  FingerprintLaunchPolicy,
  WebRtcPolicy,
} from '@lobster/shared-types';
import type { CdpEmulation, PersistentLaunchOptions } from '../launch.js';
import type { LobiumBuildCapabilities } from '../lobium-capabilities.js';

/** Everything a concrete engine launcher needs — prepared by the CompositeRunner from a profile. */
export interface LaunchContext {
  profileId: string;
  /** Human-readable Lobster profile name (NTP chip + Chromium profile prefs). */
  profileName?: string;
  engine: EngineKind;
  /** Profile-selected OS build/version label, when present. */
  osVersion?: string;
  /** The fully-resolved fingerprint — serialized into Lobium's native config channel. */
  fingerprint: Fingerprint;
  /** Native policy fields resolved from profile overrides and proxy state. */
  fingerprintPolicy?: FingerprintLaunchPolicy;
  /** Final WebRTC policy used by launch flags and native config. */
  webrtcPolicy?: WebRtcPolicy;
  /** The profile's fingerprint seed — the native launcher derives per-profile farbling seeds from it. */
  fingerprintSeed?: string;
  /** Imported cookies to load into the launched context so the profile opens logged-in (PROX-1/2). */
  cookiesImport?: CookieImportDraft;
  /** Extension refs are resolved fail-closed into profile-owned unpacked directories before spawn. */
  extensions?: BrowserExtensionRef[];
  /**
   * True for an emulated Android persona (native Lobium, real window, no ADB/APK). The native
   * launcher centers the window and applies CDP touch/device-metrics emulation so it behaves like a
   * phone viewport.
   */
  isMobileProfile?: boolean;
  options: PersistentLaunchOptions;
  /** Internal/test CDP shape; production Lobium launcher does not use this for fingerprinting. */
  emulation: CdpEmulation;
  /** Internal/test JS init script; production Lobium launcher does not inject it. */
  initScript: string;
}

/** A live engine instance the runner tracks. */
export interface LaunchHandle {
  pid: number;
  /** CDP websocket URL for `connectOverCDP`. */
  ws: string;
  /** host:port for Selenium `debuggerAddress`. */
  debuggerAddress: string;
  /** True only after a supplied one-shot cookie import was applied successfully. */
  cookieImportApplied?: boolean;
  /** Export the current live jar. Available on production Lobium handles. */
  exportCookies?(): Promise<string>;
  close(): Promise<void>;
  /**
   * Register a listener fired when the browser closes for ANY reason — explicit `close()`, a crash, or
   * the user closing the window externally. The CompositeRunner uses it to evict the profile from its
   * running map so a stale entry can't block relaunch after a crash. Optional so fakes/tests can omit it.
   */
  onClose?(listener: (reason?: string) => void): void;
}

/**
 * Launches one engine family. The production implementation launches native Lobium; tests can inject
 * fakes or lower-level adapters.
 */
export interface Launcher {
  (ctx: LaunchContext): Promise<LaunchHandle>;
  /** Present on production Lobium launchers; probes the exact executable this function will spawn. */
  getBuildCapabilities?: () => Promise<LobiumBuildCapabilities>;
}

/** Maps each engine to its launcher. Missing entries mean "engine not available". */
export type LauncherRegistry = Partial<Record<EngineKind, Launcher>>;
