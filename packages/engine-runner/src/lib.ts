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
export {
  buildLobiumLaunchArgs,
  buildLobiumLaunchEnv,
  createLobiumLauncher,
  isLobiumAvailable,
  lobiumBinaryCandidates,
  proxySummaryFromServer,
  resolveFontsBaseDir,
  resolveLobiumBinary,
} from './runners/lobium-launcher.js';
export { buildFontConfig, hasFontPersona, writeFontConfig } from './fonts.js';
export { buildCdpEmulation, buildFingerprintInitScript, buildLaunchOptions } from './launch.js';
export type { CdpEmulation, PersistentLaunchOptions, UserAgentMetadata } from './launch.js';
export { buildGpuArgs, isSoftwareRenderer, resolveGpuMode } from './gpu.js';
export { buildProxyHardeningArgs } from './proxy-hardening.js';
export type { ProxyHardeningOptions } from './proxy-hardening.js';
export type { AngleBackend, GpuArgsOptions, GpuMode } from './gpu.js';
export { applyCdpFingerprint } from './cdp-fingerprint.js';
export type { CdpSession } from './cdp-fingerprint.js';
export {
  applyCookieImport,
  cdpCookiesFromDraft,
  exportCookies,
  exportCookiesJson,
  parseCookieText,
  toCdpCookie,
} from './cookie-inject.js';
export type { CdpCookieParam } from './cookie-inject.js';
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
export {
  buildLobiumConfig,
  writeLobiumConfig,
  lobiumConfigArg,
  LOBIUM_CONFIG_VERSION,
  LOBIUM_CONFIG_FILENAME,
} from './lobium-config.js';
export type {
  LobiumConfig,
  LobiumNetConfig,
  LobiumFarblingSeeds,
  BuildLobiumConfigOptions,
} from './lobium-config.js';
export {
  ANDROID_LOBIUM_CONFIG_FILENAME,
  ANDROID_LOBIUM_CONFIG_VERSION,
  buildAndroidLobiumConfig,
  writeAndroidLobiumConfig,
} from './android-config.js';
export type {
  AndroidLobiumConfig,
  AndroidLobiumFarblingSeeds,
  AndroidLobiumNetConfig,
  AndroidLobiumPolicyConfig,
  BuildAndroidLobiumConfigOptions,
} from './android-config.js';
export {
  AndroidDeviceBridge,
  DEFAULT_ANDROID_CDP_SOCKET,
  DEFAULT_ANDROID_LOBIUM_ACTIVITY,
  DEFAULT_ANDROID_LOBIUM_PACKAGE,
  NodeAdbClient,
  buildAndroidCdpForwardCommand,
  buildAndroidConfigDeliveryCommands,
  buildAndroidLaunchPlan,
  buildAndroidStartCommand,
  buildAndroidStopCommand,
  defaultAndroidRemoteConfigPath,
  parseAdbDevices,
  sanitizeAndroidProfileId,
} from './android-bridge.js';
export type {
  AdbClient,
  AdbCommandResult,
  AndroidConfigDeliveryPlan,
  AndroidDeviceInfo,
  AndroidDeviceState,
  AndroidLaunchPlan,
  BuildAndroidLaunchPlanOptions,
} from './android-bridge.js';
export {
  buildHostCalibrationProbeScript,
  normalizeHostCalibrationSnapshot,
  probeHostCalibration,
} from './host-calibration-probe.js';
export {
  loadHostCalibration,
  persistHostCalibration,
  resolveHostCalibrationPath,
} from './host-calibration-store.js';
export {
  defaultHostCalibrationPath,
  ensureHostCalibration,
} from './ensure-host-calibration.js';
export type {
  EnsureHostCalibrationOptions,
  EnsureHostCalibrationResult,
} from './ensure-host-calibration.js';
export type {
  HostCalibrationRawNavigator,
  HostCalibrationRawSnapshot,
  HostProbePage,
  NormalizeHostCalibrationOptions,
} from './host-calibration-probe.js';
export type { EngineRunner } from './runner.js';
export type { Launcher, LaunchContext, LaunchHandle, LauncherRegistry } from './runners/types.js';
