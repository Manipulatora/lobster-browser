/**
 * Library entry for `@lobster/engine-runner` — the reusable pieces, with NO side effects.
 * (The sidecar process entry point lives in `index.ts`, exposed as the package `bin`.)
 */
export { CompositeRunner } from './runners/composite.js';
export { startProfile } from './start-profile.js';
export {
  androidProfileStatus,
  startAndroidProfile,
  stopAndroidProfile,
} from './start-android-profile.js';
export type { StartAndroidProfileOptions } from './start-android-profile.js';
export { startAndroidEmulatedProfile } from './start-android-emulated-profile.js';
export { dispatch } from './rpc.js';
export { buildAndroidMirrorArgs, launchAndroidMirror } from './android-mirror.js';
export type { AndroidMirrorHandle, AndroidMirrorOptions } from './android-mirror.js';
export {
  buildLaunchers,
  defaultLaunchers,
  EngineNotProvisionedError,
} from './runners/default-launchers.js';
export type { BuildLaunchersOptions } from './runners/default-launchers.js';
export {
  buildLobiumLaunchArgs,
  buildLobiumLaunchEnv,
  buildNativeLobiumProcessArgs,
  createLobiumLauncher,
  ensureChromiumLaunchPreferences,
  isLobiumAvailable,
  lobiumBinaryCandidates,
  proxySummaryFromServer,
  resolveFontsBaseDir,
  resolveLobiumBinary,
  scrubLegacyBrandingSessions,
} from './runners/lobium-launcher.js';
export type { NativeLobiumLauncherOptions } from './runners/lobium-launcher.js';
export {
  availableFontFamilies,
  buildFontConfig,
  hasFontPersona,
  loadFontPackManifest,
  orderFontFallbackFamilies,
  planFontAliases,
  verifyFontPackFiles,
  writeFontConfig,
} from './fonts.js';
export type { FontAliasPlan, FontPackFile, FontPackManifest } from './fonts.js';
export {
  downloadChromeWebStoreCrx,
  extensionLaunchArgs,
  extractExtensionZip,
  parseChromeWebStoreId,
  prepareProfileExtensions,
  verifyCrx3,
} from './extensions.js';
export type { PrepareExtensionsOptions } from './extensions.js';
export { buildCdpEmulation, buildFingerprintInitScript, buildLaunchOptions } from './launch.js';
export type { CdpEmulation, PersistentLaunchOptions, UserAgentMetadata } from './launch.js';
export {
  allowProvisionalSoftwareGpu,
  buildGpuArgs,
  isSoftwareRenderer,
  resolveGpuMode,
} from './gpu.js';
export {
  assertLobiumBuildCapabilities,
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  LOBIUM_CAPABILITY_SWITCH,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
  probeLobiumBuildCapabilities,
  requiredLobiumCapabilities,
} from './lobium-capabilities.js';
export type {
  LobiumBuildCapabilities,
  LobiumNativeFingerprintCapability,
} from './lobium-capabilities.js';
export { buildProxyHardeningArgs } from './proxy-hardening.js';
export type { ProxyHardeningOptions } from './proxy-hardening.js';
export {
  assertUpstreamReachable,
  needsLocalProxyAdapter,
  startLocalProxyAdapter,
  upstreamProxyUrl,
} from './proxy-auth-adapter.js';
export type { LocalProxyAdapter, UpstreamProxy } from './proxy-auth-adapter.js';
export type { AngleBackend, GpuArgsOptions, GpuMode } from './gpu.js';
export { buildDevShmArgs, MIN_CHROMIUM_DEV_SHM_BYTES } from './dev-shm.js';
export type { DevShmArgsOptions } from './dev-shm.js';
export { withCdpSession, cdpEvaluate, resolveCdpTarget } from './cdp-client.js';
export type { CdpSession } from './cdp-client.js';
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
  humanDrag,
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
  LOBIUM_MAX_RENDERER_CONFIG_BASE64_BYTES,
  LOBIUM_BROWSER_ONLY_CONFIG_KEYS,
  rendererConfigProjection,
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
export { defaultHostCalibrationPath, ensureHostCalibration } from './ensure-host-calibration.js';
export { captureHostCalibrationRawSnapshot } from './capture-host-calibration.js';
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

export { DEFAULT_CAPABILITY_PROBE_POLICY } from './launch-policy.js';
