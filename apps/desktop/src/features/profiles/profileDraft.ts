import { normalizeDeviceMemory } from '@lobster/fingerprint';

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
  defaultSelectedFontsForTarget,
  findAndroidCatalogEntry,
  fontPresetsForTarget,
  parseScreenOption,
  rendererPresetById,
  rendererPresetsForTarget,
  screenOptionsForTarget,
  webRtcPolicyForUiMode,
  type WebRtcUiMode,
} from './fingerprintCatalog';
import { OS_VERSION_OPTIONS } from './options';

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

export interface ProfileDraft {
  name: string;
  description: string;
  folder: string;
  os: ProfileOsTarget;
  osVersion: string;
  tags: string;
  proxyId: string;
  templateId: string;
  androidDeviceType: AndroidDeviceType;
  androidDeviceModel: string;
  screenResolution: string;
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

function screenSelection(os: ProfileOsTarget, screen: FingerprintOverrides['screen']): string {
  const options = screenOptionsForTarget(os);
  if (!screen?.width || !screen.height) return options[0] ?? '1920x1080';
  const match = options.find((option) => {
    const parsed = parseScreenOption(option);
    return (
      parsed !== undefined &&
      parsed.width === screen.width &&
      parsed.height === screen.height &&
      parsed.devicePixelRatio === (screen.devicePixelRatio ?? 1)
    );
  });
  if (match) return match;
  return `${screen.width}x${screen.height}${screen.devicePixelRatio === 2 ? ' Retina' : ''}`;
}

function rendererSelection(overrides: FingerprintOverrides | undefined): string {
  const policy = overrides?.renderer;
  if (policy?.mode === 'validated_preset') return policy.presetId;
  if (policy) return policy.mode;
  return 'host';
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

export function createProfileDraft(os: ProfileOsTarget = 'linux'): ProfileDraft {
  const available = [...fontPresetsForTarget(os)];
  return {
    name: '',
    description: '',
    folder: '',
    os,
    osVersion: OS_VERSION_OPTIONS[os][0],
    tags: '',
    proxyId: '',
    templateId: '',
    androidDeviceType: 'mobile',
    androidDeviceModel: '',
    screenResolution: screenOptionsForTarget(os)[0] ?? '1920x1080',
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
    cpuCores: '8',
    ramSize: '8',
    // Default to a coherent VALIDATED preset for the persona OS rather than the real host GPU. `host`
    // mode is only coherent when the persona OS matches the host OS; the engine now fail-closes a
    // cross-OS `host` launch (start-profile.ts), and anti-detect personas are usually cross-OS (e.g. a
    // Linux host running a Windows persona), so `host` as the default would brick the common case.
    // Real-host-GPU stays available as an explicit choice in the renderer picker.
    rendererPresetId: rendererPresetsForTarget(os)[0]?.id ?? 'host',
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
  const draft = createProfileDraft(profile.os);
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
    androidDeviceType: overrides?.androidDeviceType ?? draft.androidDeviceType,
    androidDeviceModel: overrides?.androidDeviceModel ?? draft.androidDeviceModel,
    screenResolution: screenSelection(profile.os, overrides?.screen),
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
    rendererPresetId: rendererSelection(overrides),
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
    fingerprintSeed: '',
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
  const fresh = createProfileDraft(os);
  return {
    ...draft,
    os,
    osVersion: fresh.osVersion,
    screenResolution: fresh.screenResolution,
    fonts: fresh.fonts,
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
    if (!parseScreenOption(draft.screenResolution)) {
      add('fingerprint', 'Choose a valid screen resolution.');
    }
    if (
      draft.fonts.mode === 'manual' &&
      (draft.fonts.selected.length === 0 ||
        draft.fonts.selected.some((font) => !draft.fonts.available.includes(font)))
    ) {
      add('fingerprint', 'Select at least one physically available font.');
    }
    if (
      draft.rendererPresetId !== 'host' &&
      draft.rendererPresetId !== 'normalized_host' &&
      !rendererPresetById(draft.os, draft.rendererPresetId)
    ) {
      add('fingerprint', 'Choose a renderer that is valid for the selected operating system.');
    }
    if (!CPU_CORE_OPTIONS.includes(Number(draft.cpuCores) as (typeof CPU_CORE_OPTIONS)[number])) {
      add('fingerprint', 'Choose a verified CPU core count.');
    }
    if (
      !DEVICE_MEMORY_OPTIONS.includes(
        Number(draft.ramSize) as (typeof DEVICE_MEMORY_OPTIONS)[number],
      )
    ) {
      add('fingerprint', 'Choose a Lobium-compatible reported memory value.');
    }
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
  if (draft.os !== 'android') {
    const cores = numberOrUndefined(draft.cpuCores);
    const memory = numberOrUndefined(draft.ramSize);
    if (cores !== undefined) navigator.hardwareConcurrency = cores;
    if (memory !== undefined) navigator.deviceMemory = normalizeDeviceMemory(memory);
  }
  if (Object.keys(navigator).length) overrides.navigator = navigator;
  else delete overrides.navigator;

  const screen = parseScreenOption(draft.screenResolution);
  if (draft.os !== 'android' && screen) {
    const top = isMac(draft.os) ? 25 : 0;
    const bottom = isMac(draft.os) ? 0 : 40;
    overrides.screen = {
      width: screen.width,
      height: screen.height,
      availWidth: screen.width,
      availHeight: Math.max(1, screen.height - top - bottom),
      availLeft: 0,
      availTop: top,
      devicePixelRatio: screen.devicePixelRatio,
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
  if (draft.os !== 'android') {
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
