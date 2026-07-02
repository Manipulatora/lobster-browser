import type { EngineKind, Fingerprint } from '@lobster/shared-types';
import type { CdpEmulation, PersistentLaunchOptions } from '../launch.js';

/** Everything a concrete engine launcher needs — prepared by the CompositeRunner from a profile. */
export interface LaunchContext {
  profileId: string;
  engine: EngineKind;
  /** The fully-resolved fingerprint — used to apply CDP overrides on each page. */
  fingerprint: Fingerprint;
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
}

/**
 * Launches one engine family. The real implementation wraps patchright driving a patched Chromium
 * (chromium/lobium); it is injected so the orchestration is fully testable with a fake.
 */
export type Launcher = (ctx: LaunchContext) => Promise<LaunchHandle>;

/** Maps each engine to its launcher. Missing entries mean "engine not available". */
export type LauncherRegistry = Partial<Record<EngineKind, Launcher>>;
