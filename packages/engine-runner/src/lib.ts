/**
 * Library entry for `@lobster/engine-runner` — the reusable pieces, with NO side effects.
 * (The sidecar process entry point lives in `index.ts`, exposed as the package `bin`.)
 */
export { CompositeRunner } from './runners/composite.js';
export { startProfile } from './start-profile.js';
export {
  buildLaunchers,
  defaultLaunchers,
  EngineNotProvisionedError,
} from './runners/default-launchers.js';
export type { BuildLaunchersOptions } from './runners/default-launchers.js';
export { createPatchrightLauncher, isChromiumAvailable } from './runners/patchright-launcher.js';
export type { PatchrightLauncherOptions } from './runners/patchright-launcher.js';
export { buildCdpEmulation, buildFingerprintInitScript, buildLaunchOptions } from './launch.js';
export type { CdpEmulation, PersistentLaunchOptions, UserAgentMetadata } from './launch.js';
export { applyCdpFingerprint } from './cdp-fingerprint.js';
export type { CdpSession } from './cdp-fingerprint.js';
export {
  mousePath,
  moveTimings,
  typingCadence,
  humanMouseMove,
  humanClick,
  humanType,
} from './humanize.js';
export type {
  Point,
  MousePathOptions,
  MoveTimingOptions,
  TypingOptions,
  HumanMoveOptions,
  Sleep,
} from './humanize.js';
export type { EngineRunner } from './runner.js';
export type { Launcher, LaunchContext, LaunchHandle, LauncherRegistry } from './runners/types.js';
