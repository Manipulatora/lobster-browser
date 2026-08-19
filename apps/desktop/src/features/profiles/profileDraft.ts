import {
  HIGH_CORE_MEMORY_FLOOR,
  deriveDevicePersona,
  deriveFingerprint,
  normalizeDeviceMemory,
  type DerivedDevicePersona,
} from '@lobster/fingerprint';

import type {
  AndroidDeviceType,
  BrowserExtensionRef,
  CookieImportDraft,
  CookieImportMode,
  CreateProfileInput,
  FingerprintOverrides,
  HardwareNoisePolicy,
  MediaDeviceProfile,
  PersonaMode,
  Profile,
  ProfileOsTarget,
  ProfileTemplate,
  RendererPolicy,
  WebRtcPolicy,
} from '@lobster/shared-types';

import {
  CPU_CORE_OPTIONS,
  DEVICE_MEMORY_OPTIONS,
  androidUserAgent,
  defaultSelectedFontsForTarget,
  deviceTierEnvelopeFor,
  devicePixelRatioOptionsFor,
  findAndroidCatalogEntry,
  fontPresetsForTarget,
  parseScreenOption,
  rendererPresetById,
  rendererPresetsForTarget,
  screenOptionsForTarget,
  webRtcPolicyForUiMode,
  type WebRtcUiMode,
} from './fingerprintCatalog';
import { OS_VERSION_OPTIONS, archForTarget, desktopOsForTarget } from './options';

export type ProfileDraftStep = 'general' | 'fingerprint' | 'cookies' | 'security' | 'extensions';

export interface ProfileDraftIssue {
  step: ProfileDraftStep;
  message: string;
}

export interface FontSelectionDraft {
  /** The families that the installed product font pack says it can expose. */
  available: string[];
  /** A subset of `available`; serialization never emits unavailable family names. */
  selected: string[];
  mode: PersonaMode;
}

/**
 * Where the profile's machine comes from.
 *
 * `seed` is the default and the honest one: the launcher derives GPU, panel, cores and memory from the
 * profile's own seed, so two profiles created with default settings describe two different computers.
 * `pinned` writes those four into `fingerprintOverrides` and is an advanced choice — every profile
 * pinned to the same values is one machine wearing different farbling seeds, which is a link, not a
 * disguise.
 */
export type DeviceSource = 'seed' | 'pinned';

export interface ProfileDraft {
  name: string;
  description: string;
  folder: string;
  os: ProfileOsTarget;
  osVersion: string;
  tags: string;
  proxyId: string;
  templateId: string;
  /**
   * The identity the whole persona derives from. Held in the draft (not only in the saved profile) so
   * the editor can show the machine the seed produces BEFORE the profile exists, and so what it shows
   * is what the store then keeps.
   */
  fingerprintSeed: string;
  deviceSource: DeviceSource;
  androidDeviceType: AndroidDeviceType;
  androidDeviceModel: string;
  screenResolution: string;
  devicePixelRatio: string;
  fonts: FontSelectionDraft;
  languageMode: PersonaMode;
  languages: string;
  timezoneMode: PersonaMode;
  timezone: string;
  geolocationMode: PersonaMode;
  geolocationLat: string;
  geolocationLng: string;
  geolocationAccuracy: string;
  cpuCores: string;
  ramSize: string;
  rendererPresetId: string;
  webrtcMode: WebRtcUiMode;
  noiseWebgl: boolean;
  noiseCanvas: boolean;
  noiseAudio: boolean;
  noiseClientRects: boolean;
  mediaCameras: string;
  mediaMicrophones: string;
  mediaSpeakers: string;
  stableDeviceIds: boolean;
  cookiesMode: CookieImportMode;
  cookiesText: string;
  cookiesFileName: string;
  cookiesParsedCount: number | undefined;
  cookiesErrors: CookieImportDraft['errors'];
  password: string;
  passwordConfirm: string;
  removePassword: boolean;
  extensions: BrowserExtensionRef[];
}

const GENERATED_NAVIGATOR_KEYS = [
  'userAgent',
  'uaBrands',
  'uaPlatform',
  'uaPlatformVersion',
  'uaMobile',
  'uaFullVersion',
  'uaModel',
] as const;

function numToString(value: number | undefined, fallback = ''): string {
  return value === undefined ? fallback : String(value);
}

function numberOrUndefined(raw: string): number | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

function wholeNumberOrZero(raw: string): number {
  const value = Number(raw.trim());
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function isMac(os: ProfileOsTarget): boolean {
  return os === 'macos' || os === 'macos_intel' || os === 'macos_arm';
}

function isValidLanguageTag(value: string): boolean {
  try {
    return Intl.getCanonicalLocales(value).length === 1;
  } catch {
    return false;
  }
}

function isValidTimezone(value: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

export function isChromeWebStoreUrl(value: string): boolean {
  return chromeWebStoreExtensionId(value) !== undefined;
}

export function chromeWebStoreExtensionId(value: string): string | undefined {
  const normalized = value.trim().toLowerCase();
  if (/^[a-p]{32}$/.test(normalized)) return normalized;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:') return undefined;
    const official =
      (url.hostname === 'chromewebstore.google.com' && url.pathname.startsWith('/detail/')) ||
      (url.hostname === 'chrome.google.com' && url.pathname.startsWith('/webstore/detail/'));
    if (!official) return undefined;
    return url.pathname
      .split('/')
      .filter(Boolean)
      .reverse()
      .find((part) => /^[a-p]{32}$/.test(part));
  } catch {
    return undefined;
  }
}

export function parseProfileTags(raw: string): string[] {
  const tags = new Set<string>();
  for (const part of raw.split(/[,\n]/)) {
    const tag = part.trim();
    if (tag) tags.add(tag);
  }
  return [...tags];
}

export function parseExtensionUrls(raw: string): string[] {
  return [
    ...new Set(
      raw
        .split(/\r?\n/)
        .map((value) => value.trim())
        .filter(Boolean),
    ),
  ];
}

/**
 * A fresh per-profile seed. `@lobster/fingerprint` generates seeds through `node:crypto`, which does
 * not exist in the webview, so the editor draws its own from the Web Crypto API in the same 128-bit
 * lowercase-hex shape the store uses.
 */
function newFingerprintSeed(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The machine this draft's seed describes, or undefined for Android (whose device comes from the
 * chosen catalog model, not from a desktop tier draw). Identical to what the launcher derives, so the
 * editor previews the real thing rather than a second implementation of it.
 */
function derivedDevice(os: ProfileOsTarget, seed: string): DerivedDevicePersona | undefined {
  const family = desktopOsForTarget(os);
  if (!family || !seed) return undefined;
  const arch = archForTarget(os);
  return deriveDevicePersona(seed, { os: family, ...(arch ? { arch } : {}) });
}

export function derivedDeviceForDraft(draft: ProfileDraft): DerivedDevicePersona | undefined {
  return derivedDevice(draft.os, draft.fingerprintSeed);
}

/**
 * The User-Agent this profile will really send, read back from the derived fingerprint instead of
 * rebuilt from a per-OS literal. The literal drifted: it ignored the seed, the architecture and the
 * engine's own version, so the field the user read as "this is my UA" could disagree with the string
 * the engine put on the wire.
 */
export function draftUserAgent(draft: ProfileDraft): string {
  if (draft.os === 'android') return androidUserAgent(draft.androidDeviceType);
  const family = desktopOsForTarget(draft.os);
  if (!family) return '';
  const arch = archForTarget(draft.os);
  const seed = draft.fingerprintSeed || newFingerprintSeed();
  return deriveFingerprint(seed, { os: family, engine: 'lobium', ...(arch ? { arch } : {}) })
    .navigator.userAgent;
}

function screenSelection(os: ProfileOsTarget, screen: FingerprintOverrides['screen']): string {
  const options = screenOptionsForTarget(os);
  if (!screen?.width || !screen.height) return options[0] ?? '1920x1080';
  return `${screen.width}x${screen.height}`;
}

/**
 * Does this profile pin its machine, or leave it to the seed? Any of the four device-defining override
 * keys means pinned — an existing profile carrying a screen but no renderer still had its screen taken
 * out of the seed's hands, and re-deriving it on open would silently change what that profile reports.
 */
function deviceSourceOf(overrides: FingerprintOverrides | undefined): DeviceSource {
  const pinned =
    overrides?.screen !== undefined ||
    overrides?.renderer !== undefined ||
    overrides?.navigator?.hardwareConcurrency !== undefined ||
    overrides?.navigator?.deviceMemory !== undefined;
  return pinned ? 'pinned' : 'seed';
}

/** The renderer picker entry that names the derived GPU, so "pin what I was shown" loses nothing. */
function derivedRendererPresetId(
  os: ProfileOsTarget,
  device: DerivedDevicePersona | undefined,
): string | undefined {
  if (!device) return undefined;
  if (device.rendererPresetId && rendererPresetById(os, device.rendererPresetId)) {
    return device.rendererPresetId;
  }
  return rendererPresetsForTarget(os).find(
    (preset) => preset.webgl.renderer === device.webgl.renderer,
  )?.id;
}

function rendererSelection(overrides: FingerprintOverrides | undefined): string | undefined {
  const policy = overrides?.renderer;
  if (policy?.mode === 'validated_preset') return policy.presetId;
  return policy?.mode;
}

function webRtcUiMode(
  mode: PersonaMode | undefined,
  policy: WebRtcPolicy | undefined,
): WebRtcUiMode {
  if (mode === 'based_ip' || policy === 'proxy_only') return 'based_ip';
  if (policy === 'disable_non_proxied_udp') return 'disable_udp';
  if (policy === 'disabled') return 'disabled';
  return 'real';
}

export function createProfileDraft(
  os: ProfileOsTarget = 'linux',
  seed: string = newFingerprintSeed(),
): ProfileDraft {
  const available = [...fontPresetsForTarget(os)];
  // The pinnable controls START on the seed's own machine. Two things follow: the editor shows the
  // device the profile will actually report instead of a house default, and pinning is then a promise
  // to keep that machine rather than a silent swap to a different one.
  const device = derivedDevice(os, seed);
  const screen = device
    ? `${device.screen.width}x${device.screen.height}`
    : (screenOptionsForTarget(os)[0] ?? '1920x1080');
  return {
    name: '',
    description: '',
    folder: '',
    os,
    osVersion: OS_VERSION_OPTIONS[os][0],
    tags: '',
    proxyId: '',
    templateId: '',
    fingerprintSeed: seed,
    deviceSource: 'seed',
    androidDeviceType: 'mobile',
    androidDeviceModel: '',
    screenResolution: screen,
    devicePixelRatio: String(
      device?.screen.devicePixelRatio ?? devicePixelRatioOptionsFor(os, screen)[0] ?? 1,
    ),
    fonts: {
      available,
      selected: defaultSelectedFontsForTarget(os).filter((font) => available.includes(font)),
      mode: 'manual',
    },
    languageMode: 'based_ip',
    languages: 'en-US, en',
    timezoneMode: 'based_ip',
    timezone: 'America/New_York',
    geolocationMode: 'based_ip',
    geolocationLat: '',
    geolocationLng: '',
    geolocationAccuracy: '100',
    cpuCores: String(device?.hardwareConcurrency ?? 8),
    ramSize: String(device?.deviceMemory ?? 8),
    // Default to a coherent VALIDATED preset for the persona OS rather than the real host GPU. `host`
    // mode is only coherent when the persona OS matches the host OS; the engine now fail-closes a
    // cross-OS `host` launch (start-profile.ts), and anti-detect personas are usually cross-OS (e.g. a
    // Linux host running a Windows persona), so `host` as the default would brick the common case.
    // Real-host-GPU stays available as an explicit choice in the renderer picker.
    rendererPresetId:
      derivedRendererPresetId(os, device) ?? rendererPresetsForTarget(os)[0]?.id ?? 'host',
    webrtcMode: 'based_ip',
    noiseWebgl: true,
    noiseCanvas: true,
    noiseAudio: true,
    noiseClientRects: false,
    mediaCameras: '1',
    mediaMicrophones: '1',
    mediaSpeakers: '2',
    stableDeviceIds: true,
    cookiesMode: 'merge',
    cookiesText: '',
    cookiesFileName: '',
    cookiesParsedCount: undefined,
    cookiesErrors: undefined,
    password: '',
    passwordConfirm: '',
    removePassword: false,
    extensions: [],
  };
}

export function hydrateProfileDraft(profile: Profile): ProfileDraft {
  const draft = createProfileDraft(profile.os, profile.fingerprintSeed || undefined);
  const overrides = profile.fingerprintOverrides;
  const navigator = overrides?.navigator;
  const geolocation = overrides?.locale?.geolocation;
  const available = [...fontPresetsForTarget(profile.os)];
  const selected = (overrides?.fonts ?? defaultSelectedFontsForTarget(profile.os)).filter((font) =>
    available.includes(font),
  );
  return {
    ...draft,
    name: profile.name,
    description: profile.notes ?? '',
    folder: profile.folder ?? '',
    osVersion: profile.osVersion ?? draft.osVersion,
    tags: profile.tags.join(', '),
    proxyId: profile.proxyId ?? '',
    templateId: profile.templateId ?? '',
    deviceSource: deviceSourceOf(overrides),
    androidDeviceType: overrides?.androidDeviceType ?? draft.androidDeviceType,
    androidDeviceModel: overrides?.androidDeviceModel ?? draft.androidDeviceModel,
    screenResolution: overrides?.screen
      ? screenSelection(profile.os, overrides.screen)
      : draft.screenResolution,
    devicePixelRatio: numToString(overrides?.screen?.devicePixelRatio, draft.devicePixelRatio),
    fonts: {
      available,
      selected,
      // Desktop launches always use an exact bundled allowlist; host-font passthrough is forbidden.
      mode: 'manual',
    },
    languageMode:
      overrides?.languageMode ?? (navigator?.languages?.length ? 'manual' : draft.languageMode),
    languages: navigator?.languages?.join(', ') ?? draft.languages,
    timezoneMode:
      overrides?.timezoneMode ?? (overrides?.locale?.timezone ? 'manual' : draft.timezoneMode),
    timezone: overrides?.locale?.timezone ?? draft.timezone,
    geolocationMode: overrides?.geolocationMode ?? (geolocation ? 'manual' : draft.geolocationMode),
    geolocationLat: numToString(geolocation?.latitude),
    geolocationLng: numToString(geolocation?.longitude),
    geolocationAccuracy: numToString(geolocation?.accuracy, '100'),
    cpuCores: numToString(navigator?.hardwareConcurrency, draft.cpuCores),
    ramSize: numToString(navigator?.deviceMemory, draft.ramSize),
    rendererPresetId: rendererSelection(overrides) ?? draft.rendererPresetId,
    webrtcMode: webRtcUiMode(overrides?.webrtcMode, overrides?.webrtc),
    noiseWebgl: overrides?.hardwareNoise?.webgl ?? draft.noiseWebgl,
    noiseCanvas: overrides?.hardwareNoise?.canvas ?? draft.noiseCanvas,
    noiseAudio: overrides?.hardwareNoise?.audio ?? draft.noiseAudio,
    noiseClientRects: overrides?.hardwareNoise?.clientRects ?? draft.noiseClientRects,
    mediaCameras: numToString(overrides?.mediaDevices?.cameras, draft.mediaCameras),
    mediaMicrophones: numToString(overrides?.mediaDevices?.microphones, draft.mediaMicrophones),
    mediaSpeakers: numToString(overrides?.mediaDevices?.speakers, draft.mediaSpeakers),
    stableDeviceIds: overrides?.mediaDevices?.stableDeviceIds ?? draft.stableDeviceIds,
    cookiesMode: profile.cookiesImport?.mode ?? draft.cookiesMode,
    cookiesText: profile.cookiesImport?.rawText ?? '',
    cookiesFileName: profile.cookiesImport?.fileName ?? '',
    cookiesParsedCount: profile.cookiesImport?.parsedCount,
    cookiesErrors: profile.cookiesImport?.errors,
    extensions: (profile.extensions ?? []).map((extension) => ({ ...extension })),
  };
}

export function hydrateTemplateDraft(
  current: ProfileDraft,
  template: ProfileTemplate,
): ProfileDraft {
  const syntheticProfile: Profile = {
    id: 'profile-template-draft',
    name: current.name,
    engine: template.engine,
    os: template.os,
    // The template describes settings, not an identity: the profile being edited keeps its own seed,
    // so applying a template never moves it onto another template user's machine.
    fingerprintSeed: current.fingerprintSeed,
    tags: template.tags,
    status: 'idle',
    createdAt: '',
    updatedAt: '',
    ...(template.osVersion ? { osVersion: template.osVersion } : {}),
    ...(template.proxyId ? { proxyId: template.proxyId } : {}),
    ...(template.fingerprintOverrides
      ? { fingerprintOverrides: template.fingerprintOverrides }
      : {}),
    ...(template.cookiesImport ? { cookiesImport: template.cookiesImport } : {}),
    ...(template.extensions ? { extensions: template.extensions } : {}),
  };
  return {
    ...hydrateProfileDraft(syntheticProfile),
    name: current.name,
    description: current.description,
    folder: current.folder,
    templateId: template.id,
    password: current.password,
    passwordConfirm: current.passwordConfirm,
    removePassword: current.removePassword,
  };
}

export function changeDraftOs(draft: ProfileDraft, os: ProfileOsTarget): ProfileDraft {
  // Same seed, new OS: the machine is re-derived for the target (a Windows seed and a macOS seed pick
  // from different catalogs), which is why every device-shaped field is taken from the fresh draft.
  const fresh = createProfileDraft(os, draft.fingerprintSeed);
  return {
    ...draft,
    os,
    osVersion: fresh.osVersion,
    screenResolution: fresh.screenResolution,
    devicePixelRatio: fresh.devicePixelRatio,
    fonts: fresh.fonts,
    cpuCores: fresh.cpuCores,
    ramSize: fresh.ramSize,
    rendererPresetId: fresh.rendererPresetId,
  };
}

/**
 * Pin the machine the seed produced, so the advanced controls open on the device the user was just
 * shown rather than on the first entry of every list.
 */
export function pinDerivedDevice(draft: ProfileDraft): ProfileDraft {
  const fresh = createProfileDraft(draft.os, draft.fingerprintSeed);
  return {
    ...draft,
    deviceSource: 'pinned',
    screenResolution: fresh.screenResolution,
    devicePixelRatio: fresh.devicePixelRatio,
    cpuCores: fresh.cpuCores,
    ramSize: fresh.ramSize,
    rendererPresetId: fresh.rendererPresetId,
  };
}

export function validateProfileDraft(draft: ProfileDraft): ProfileDraftIssue[] {
  const issues: ProfileDraftIssue[] = [];
  const add = (step: ProfileDraftStep, message: string): void => {
    issues.push({ step, message });
  };
  const name = draft.name.trim();
  if (!name) add('general', 'Enter a profile name.');
  else if (name.length > 120) add('general', 'Profile name must be 120 characters or fewer.');
  if (draft.description.length > 2_000) {
    add('general', 'Description must be 2,000 characters or fewer.');
  }
  if (draft.folder.length > 240) add('general', 'Folder must be 240 characters or fewer.');

  if (draft.os !== 'android') {
    if (
      draft.fonts.mode === 'manual' &&
      (draft.fonts.selected.length === 0 ||
        draft.fonts.selected.some((font) => !draft.fonts.available.includes(font)))
    ) {
      add('fingerprint', 'Select at least one physically available font.');
    }
  }
  // Only a pinned device is the draft's to get wrong. A seed-derived one is produced by the same code
  // the launcher runs, and is coherent by construction.
  if (draft.os !== 'android' && draft.deviceSource === 'pinned') {
    const screen = parseScreenOption(draft.screenResolution);
    const dpr = numberOrUndefined(draft.devicePixelRatio);
    const cores = Number(draft.cpuCores);
    const memory = Number(draft.ramSize);
    if (!screen) add('fingerprint', 'Choose a valid screen resolution.');
    else if (
      dpr === undefined ||
      !devicePixelRatioOptionsFor(draft.os, draft.screenResolution).includes(dpr)
    ) {
      add('fingerprint', 'Choose a scaling factor this screen size is actually presented at.');
    }
    if (
      draft.rendererPresetId !== 'host' &&
      draft.rendererPresetId !== 'normalized_host' &&
      !rendererPresetById(draft.os, draft.rendererPresetId)
    ) {
      add('fingerprint', 'Choose a renderer that is valid for the selected operating system.');
    }
    if (!CPU_CORE_OPTIONS.includes(cores as (typeof CPU_CORE_OPTIONS)[number])) {
      add('fingerprint', 'Choose a verified CPU core count.');
    }
    if (!DEVICE_MEMORY_OPTIONS.includes(memory)) {
      add('fingerprint', 'Choose a Lobium-compatible reported memory value.');
    }
    // Cores, memory and GPU are bought together. The launch-time coherence gate refuses the pairing,
    // so catching it here is the difference between an editable field and a profile that saves and
    // then will not start.
    const envelope = deviceTierEnvelopeFor(draft.os, draft.rendererPresetId);
    if (envelope) {
      if (cores < envelope.minCores || cores > envelope.maxCores) {
        add(
          'fingerprint',
          `This GPU is found on machines with ${envelope.minCores}–${envelope.maxCores} CPU cores.`,
        );
      }
      if (memory < envelope.minDeviceMemory) {
        add('fingerprint', `This GPU is never paired with under ${envelope.minDeviceMemory} GB.`);
      }
    }
    if (cores >= HIGH_CORE_MEMORY_FLOOR.cores && memory < HIGH_CORE_MEMORY_FLOOR.deviceMemory) {
      add(
        'fingerprint',
        `A ${cores}-thread machine never reports under ${HIGH_CORE_MEMORY_FLOOR.deviceMemory} GB.`,
      );
    }
  }
  // "Real" publishes every host ICE candidate. Behind a proxy that leaks the real address the proxy
  // exists to hide, so the launcher refuses the combination outright rather than starting a profile
  // that is deanonymised by its first WebRTC call.
  if (draft.proxyId && draft.webrtcMode === 'real') {
    add('fingerprint', 'WebRTC "Real" leaks the host IP past the proxy — choose Based on IP.');
  }

  const languages = draft.languages
    .split(',')
    .map((language) => language.trim())
    .filter(Boolean);
  if (draft.languageMode === 'manual') {
    if (!languages.length) add('fingerprint', 'Enter at least one language tag.');
    else if (languages.some((language) => !isValidLanguageTag(language))) {
      add('fingerprint', 'Use valid BCP-47 language tags, for example en-US, en.');
    }
  }
  if (draft.timezoneMode === 'manual' && !isValidTimezone(draft.timezone.trim())) {
    add('fingerprint', 'Enter a valid IANA timezone, for example America/New_York.');
  }
  if (draft.geolocationMode === 'manual') {
    const latitude = numberOrUndefined(draft.geolocationLat);
    const longitude = numberOrUndefined(draft.geolocationLng);
    const accuracy = numberOrUndefined(draft.geolocationAccuracy);
    if (latitude === undefined || latitude < -90 || latitude > 90) {
      add('fingerprint', 'Latitude must be a number from -90 to 90.');
    }
    if (longitude === undefined || longitude < -180 || longitude > 180) {
      add('fingerprint', 'Longitude must be a number from -180 to 180.');
    }
    if (accuracy === undefined || accuracy <= 0) {
      add('fingerprint', 'Geolocation accuracy must be greater than zero.');
    }
  }
  for (const [raw, label] of [
    [draft.mediaCameras, 'Camera'],
    [draft.mediaMicrophones, 'Microphone'],
    [draft.mediaSpeakers, 'Speaker'],
  ] as const) {
    const count = Number(raw.trim());
    if (!Number.isInteger(count) || count < 0 || count > 16) {
      add('fingerprint', `${label} count must be a whole number from 0 to 16.`);
    }
  }

  if (draft.cookiesMode === 'replace' && !draft.cookiesText.trim()) {
    add('cookies', 'Add cookies before choosing Replace cookie jar.');
  }
  if (draft.cookiesMode !== 'empty' && draft.cookiesErrors?.length) {
    add('cookies', 'Fix the cookie import errors before saving the profile.');
  }
  if (draft.password !== draft.passwordConfirm) {
    add('security', 'Password confirmation does not match.');
  }
  if (draft.removePassword && draft.password) {
    add('security', 'Choose either a new password or remove password protection.');
  }
  for (const extension of draft.extensions) {
    if (extension.source === 'chrome_web_store') {
      if (!chromeWebStoreExtensionId(extension.id ?? extension.url ?? '')) {
        add('extensions', 'A Chrome Web Store extension has an invalid ID or official detail URL.');
      }
    } else if (
      !extension.path ||
      (!extension.path.startsWith('/') &&
        !/^[A-Za-z]:[\\/]/.test(extension.path) &&
        !extension.path.startsWith('\\\\'))
    ) {
      add('extensions', 'Local unpacked extension paths must be absolute.');
    }
  }
  return issues;
}

/**
 * Settings that will save and launch, but not do what their label says.
 *
 * "Based on IP" reads the locale, timezone and coordinates off the proxy's exit address. With no proxy
 * attached there is no exit address to read, so the launch keeps the base persona — en-US, New York,
 * and the host's own position — while the modal still reads "Based on IP". That contradiction is
 * exactly what a detector compares, so it is surfaced before the profile is saved rather than after a
 * benchmark reports the mismatch.
 */
export function profileDraftWarnings(draft: ProfileDraft): ProfileDraftIssue[] {
  if (draft.proxyId) return [];
  const basedOnIp = [
    ['Language', draft.languageMode],
    ['Timezone', draft.timezoneMode],
    ['Geolocation', draft.geolocationMode],
    ['WebRTC', draft.webrtcMode],
  ] as const;
  const affected = basedOnIp.filter(([, mode]) => mode === 'based_ip').map(([label]) => label);
  if (!affected.length) return [];
  return [
    {
      step: 'fingerprint',
      message: `${affected.join(', ')} ${affected.length === 1 ? 'is' : 'are'} set to Based on IP, but this profile has no proxy — the launch keeps the base persona instead.`,
    },
  ];
}

function rendererPolicy(draft: ProfileDraft): RendererPolicy {
  if (draft.rendererPresetId === 'host') return { mode: 'host' };
  if (draft.rendererPresetId === 'normalized_host') return { mode: 'normalized_host' };
  return { mode: 'validated_preset', presetId: draft.rendererPresetId };
}

function hardwareNoise(draft: ProfileDraft): HardwareNoisePolicy {
  return {
    webgl: draft.noiseWebgl,
    canvas: draft.noiseCanvas,
    audio: draft.noiseAudio,
    clientRects: draft.noiseClientRects,
  };
}

function mediaDevices(draft: ProfileDraft): MediaDeviceProfile {
  return {
    cameras: wholeNumberOrZero(draft.mediaCameras),
    microphones: wholeNumberOrZero(draft.mediaMicrophones),
    speakers: wholeNumberOrZero(draft.mediaSpeakers),
    stableDeviceIds: draft.stableDeviceIds,
  };
}

/**
 * Rebuilds every draft-owned override. Generated UA and UA-CH fields are always removed: the engine
 * derives those from its build, seed, OS and OS version. Target changes discard all old target-specific
 * values; same-target edits retain only override keys that this editor does not own.
 *
 * The device keys — screen, hardwareConcurrency, deviceMemory, renderer/webgl — are written ONLY when
 * the user pinned them. Writing them unconditionally was what made every profile the same computer:
 * the values came from the first entry of each picker, so the seed's machine was computed, shown and
 * then overwritten before it ever reached the engine.
 */
export function serializeFingerprintOverrides(
  draft: ProfileDraft,
  originalProfile?: Profile,
): FingerprintOverrides {
  const targetChanged = Boolean(originalProfile && originalProfile.os !== draft.os);
  const overrides: FingerprintOverrides =
    originalProfile && !targetChanged ? { ...originalProfile.fingerprintOverrides } : {};
  const originalNavigator =
    originalProfile && !targetChanged ? originalProfile.fingerprintOverrides?.navigator : undefined;
  const navigator = { ...originalNavigator };
  for (const key of GENERATED_NAVIGATOR_KEYS) delete navigator[key];
  delete navigator.languages;
  delete navigator.hardwareConcurrency;
  delete navigator.deviceMemory;

  if (draft.languageMode === 'manual') {
    const languages = draft.languages
      .split(',')
      .map((language) => language.trim())
      .filter(Boolean);
    if (languages.length) navigator.languages = languages;
  }
  const pinsDevice = draft.os !== 'android' && draft.deviceSource === 'pinned';
  if (pinsDevice) {
    const cores = numberOrUndefined(draft.cpuCores);
    const memory = numberOrUndefined(draft.ramSize);
    if (cores !== undefined) navigator.hardwareConcurrency = cores;
    if (memory !== undefined) navigator.deviceMemory = normalizeDeviceMemory(memory);
  }
  if (Object.keys(navigator).length) overrides.navigator = navigator;
  else delete overrides.navigator;

  const screen = pinsDevice ? parseScreenOption(draft.screenResolution) : undefined;
  if (screen) {
    const top = isMac(draft.os) ? 25 : 0;
    const bottom = isMac(draft.os) ? 0 : 40;
    overrides.screen = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: Math.max(1, screen.height - top - bottom),
      availLeft: 0,
      availTop: top,
      devicePixelRatio: numberOrUndefined(draft.devicePixelRatio) ?? 1,
    };
  } else {
    delete overrides.screen;
  }

  delete overrides.locale;
  const timezone = draft.timezone.trim();
  const latitude = numberOrUndefined(draft.geolocationLat);
  const longitude = numberOrUndefined(draft.geolocationLng);
  if (
    (draft.timezoneMode === 'manual' && timezone) ||
    (draft.geolocationMode === 'manual' && latitude !== undefined && longitude !== undefined)
  ) {
    overrides.locale = {};
    if (draft.timezoneMode === 'manual' && timezone) overrides.locale.timezone = timezone;
    if (draft.geolocationMode === 'manual' && latitude !== undefined && longitude !== undefined) {
      overrides.locale.geolocation = {
        latitude,
        longitude,
        accuracy: numberOrUndefined(draft.geolocationAccuracy) ?? 100,
      };
    }
  }

  overrides.fontsMode = draft.os === 'android' ? draft.fonts.mode : 'manual';
  if (draft.os !== 'android') {
    overrides.fonts = draft.fonts.selected.filter((font) => draft.fonts.available.includes(font));
  } else {
    delete overrides.fonts;
  }
  if (pinsDevice) {
    overrides.renderer = rendererPolicy(draft);
    const renderer = rendererPresetById(draft.os, draft.rendererPresetId);
    if (renderer) overrides.webgl = renderer.webgl;
    else delete overrides.webgl;
  } else {
    delete overrides.renderer;
    delete overrides.webgl;
  }
  overrides.languageMode = draft.languageMode;
  overrides.timezoneMode = draft.timezoneMode;
  overrides.geolocationMode = draft.geolocationMode;
  overrides.webrtcMode =
    draft.webrtcMode === 'based_ip' ? 'based_ip' : draft.webrtcMode === 'real' ? 'real' : 'manual';
  overrides.webrtc = webRtcPolicyForUiMode(draft.webrtcMode);
  overrides.hardwareNoise = hardwareNoise(draft);
  overrides.mediaDevices = mediaDevices(draft);
  if (draft.os === 'android') {
    overrides.androidDeviceType = draft.androidDeviceType;
    overrides.androidDeviceModel = draft.androidDeviceModel;
    const entry = findAndroidCatalogEntry(draft.androidDeviceType, draft.androidDeviceModel);
    if (entry?.model) overrides.androidDeviceCode = entry.model;
    else delete overrides.androidDeviceCode;
  } else {
    delete overrides.androidDeviceType;
    delete overrides.androidDeviceModel;
    delete overrides.androidDeviceCode;
  }
  return overrides;
}

export interface SerializedProfileDraft {
  input: CreateProfileInput;
  password: string | null | undefined;
}

export function serializeProfileDraft(
  draft: ProfileDraft,
  originalProfile?: Profile,
): SerializedProfileDraft {
  const input: CreateProfileInput = {
    name: draft.name.trim(),
    engine: 'lobium',
    os: draft.os,
    osVersion: draft.osVersion,
    tags: parseProfileTags(draft.tags),
    fingerprintOverrides: serializeFingerprintOverrides(draft, originalProfile),
  };
  // The seed the editor previewed IS the profile's identity, so it travels with the create. Without
  // this the store would mint its own and the machine the user was shown would not be the machine that
  // launches. (The store treats a profile's seed as immutable, so an edit carries it back unchanged.)
  if (draft.fingerprintSeed) input.fingerprintSeed = draft.fingerprintSeed;
  const notes = draft.description.trim();
  const folder = draft.folder.trim();
  if (notes) input.notes = notes;
  if (folder) input.folder = folder;
  if (draft.proxyId) input.proxyId = draft.proxyId;
  if (draft.templateId) input.templateId = draft.templateId;

  if (draft.cookiesMode === 'empty') {
    input.cookiesImport = { mode: 'empty' };
  } else if (draft.cookiesText.trim()) {
    input.cookiesImport = {
      mode: draft.cookiesMode,
      source: draft.cookiesFileName ? 'file' : 'plain_text',
      rawText: draft.cookiesText.trim(),
      ...(draft.cookiesFileName ? { fileName: draft.cookiesFileName } : {}),
      ...(draft.cookiesParsedCount !== undefined ? { parsedCount: draft.cookiesParsedCount } : {}),
      ...(draft.cookiesErrors ? { errors: draft.cookiesErrors } : {}),
    };
  }
  const extensions: BrowserExtensionRef[] = draft.extensions.map((extension) => {
    if (extension.source === 'unpacked') {
      return { ...extension, path: extension.path?.trim() };
    }
    const id = chromeWebStoreExtensionId(extension.id ?? extension.url ?? '');
    return {
      ...extension,
      ...(id ? { id } : {}),
      ...(extension.url ? { url: extension.url.trim() } : {}),
    };
  });
  if (extensions.length) input.extensions = extensions;

  const password = draft.removePassword ? null : draft.password.trim() ? draft.password : undefined;
  return { input, password };
}
