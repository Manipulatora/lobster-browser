import {
  ANDROID_PHONE_MODEL_CATALOG,
  ANDROID_TABLET_MODEL_CATALOG,
  ENGINE_CHROME,
  LINUX_FONT_NAMES,
  LINUX_RENDERER_PRESETS,
  MACOS_ARM_RENDERER_PRESETS,
  MACOS_FONT_NAMES,
  MACOS_INTEL_RENDERER_PRESETS,
  WINDOWS_FONT_NAMES,
  WINDOWS_RENDERER_PRESETS,
  defaultFontsForOs,
  filterAndroidCatalogByOsVersion,
  normalizeMacFontFamily,
  type AndroidDeviceCatalogEntry,
  type ProductRendererCatalogEntry,
} from '@lobster/fingerprint';
import type {
  AndroidDeviceType,
  PersonaMode,
  ProfileOsTarget,
  RendererPolicy,
  WebGlFingerprint,
  WebRtcPolicy,
} from '@lobster/shared-types';

export type { AndroidDeviceType, PersonaMode };

export interface SelectOption<T extends string = string> {
  value: T;
  label: string;
}

export interface RendererPreset {
  id: string;
  os: 'windows' | 'macos' | 'linux';
  label: string;
  vendorFamily: string;
  validationLevel: ProductRendererCatalogEntry['validationLevel'];
  webgl: WebGlFingerprint;
  policy: RendererPolicy;
}

export const PERSONA_MODE_OPTIONS: ReadonlyArray<SelectOption<PersonaMode>> = [
  { value: 'based_ip', label: 'Based on IP' },
  { value: 'real', label: 'Real' },
  { value: 'manual', label: 'Manual' },
];

/** WebRTC UI modes — not the same as Language/Timezone PersonaMode. */
export type WebRtcUiMode = 'based_ip' | 'real' | 'disable_udp' | 'disabled';

export const WEBRTC_MODE_OPTIONS: ReadonlyArray<SelectOption<WebRtcUiMode>> = [
  { value: 'based_ip', label: 'Based on IP' },
  { value: 'real', label: 'Real' },
  { value: 'disable_udp', label: 'Disable non-proxied UDP' },
  { value: 'disabled', label: 'Disabled' },
];

export function webRtcPolicyForUiMode(mode: WebRtcUiMode): WebRtcPolicy {
  if (mode === 'based_ip') return 'proxy_only';
  if (mode === 'disable_udp') return 'disable_non_proxied_udp';
  if (mode === 'disabled') return 'disabled';
  return 'default_public_interface_only';
}

export const ANDROID_DEVICE_TYPE_OPTIONS: ReadonlyArray<SelectOption<AndroidDeviceType>> = [
  { value: 'mobile', label: 'Mobile' },
  { value: 'tablet', label: 'Tablet' },
];

/** Desktop-only hardwareConcurrency choices for the Create Profile form. */
export const CPU_CORE_OPTIONS = [8, 10, 11, 12, 14, 16, 20, 24] as const;

/**
 * Values Chromium can actually expose through `navigator.deviceMemory`. Calling these physical RAM
 * sizes was misleading: values above 8 GB all collapse to the same observable value.
 */
export const DEVICE_MEMORY_OPTIONS = [0.25, 0.5, 1, 2, 4, 8] as const;

export const WINDOWS_SCREEN_OPTIONS = [
  '1280x720',
  '1366x768',
  '1440x900',
  '1536x864',
  '1600x900',
  '1680x1050',
  '1920x1080',
  '1920x1200',
  '2048x1152',
  '2560x1080',
  '2560x1440',
  '2560x1600',
  '3440x1440',
  '3840x1600',
  '3840x2160',
  '5120x1440',
  '5120x2160',
] as const;

export const MAC_SCREEN_OPTIONS = [
  '1280x800',
  '1440x900',
  '1512x982 Retina',
  '1680x1050',
  '1728x1117 Retina',
  '1792x1120',
  '1920x1080',
  '2056x1329 Retina',
  '2560x1440',
  '2560x1600 Retina',
  '3008x1692 Retina',
  '3456x2234 Retina',
  '3840x2160',
  '5120x2160',
] as const;

export const LINUX_SCREEN_OPTIONS = [
  '1280x720',
  '1366x768',
  '1440x900',
  '1600x900',
  '1680x1050',
  '1920x1080',
  '1920x1200',
  '2560x1440',
  '3440x1440',
  '3840x2160',
] as const;

export const ANDROID_PHONE_MODELS = ANDROID_PHONE_MODEL_CATALOG.map((device) => device.label);
export const ANDROID_TABLET_MODELS = ANDROID_TABLET_MODEL_CATALOG.map((device) => device.label);

function rendererPreset(entry: ProductRendererCatalogEntry): RendererPreset {
  return {
    id: entry.id,
    os: entry.os,
    label: entry.label,
    vendorFamily: entry.vendorFamily,
    validationLevel: entry.validationLevel,
    webgl: entry.webgl,
    policy: { mode: 'validated_preset', presetId: entry.id },
  };
}

export const WINDOWS_RENDERERS = WINDOWS_RENDERER_PRESETS.map(rendererPreset);
export const MAC_ARM_RENDERERS = MACOS_ARM_RENDERER_PRESETS.map(rendererPreset);
export const MAC_INTEL_RENDERERS = MACOS_INTEL_RENDERER_PRESETS.map(rendererPreset);
export const LINUX_RENDERERS = LINUX_RENDERER_PRESETS.map(rendererPreset);

export const WINDOWS_FONT_PRESETS = WINDOWS_FONT_NAMES;
export const MAC_FONT_PRESETS = [...new Set(MACOS_FONT_NAMES.map(normalizeMacFontFamily))].sort(
  (a, b) => a.localeCompare(b, 'en'),
);
export const LINUX_FONT_PRESETS = LINUX_FONT_NAMES;

export function screenOptionsForTarget(os: ProfileOsTarget): readonly string[] {
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm') return MAC_SCREEN_OPTIONS;
  if (os === 'linux') return LINUX_SCREEN_OPTIONS;
  return WINDOWS_SCREEN_OPTIONS;
}

export function fontPresetsForTarget(os: ProfileOsTarget): readonly string[] {
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm') return MAC_FONT_PRESETS;
  if (os === 'linux') return LINUX_FONT_PRESETS;
  return WINDOWS_FONT_PRESETS;
}

export function defaultSelectedFontsForTarget(os: ProfileOsTarget): string[] {
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm')
    return defaultFontsForOs('macos');
  if (os === 'linux') return defaultFontsForOs('linux');
  if (os === 'android') return [];
  return defaultFontsForOs('windows');
}

export function rendererPresetsForTarget(os: ProfileOsTarget): ReadonlyArray<RendererPreset> {
  if (os === 'macos_arm') return MAC_ARM_RENDERERS;
  if (os === 'macos' || os === 'macos_intel') return MAC_INTEL_RENDERERS;
  if (os === 'linux') return LINUX_RENDERERS;
  return WINDOWS_RENDERERS;
}

export function rendererPresetById(
  os: ProfileOsTarget,
  presetId: string,
): RendererPreset | undefined {
  return rendererPresetsForTarget(os).find((preset) => preset.id === presetId);
}

export function defaultUserAgent(
  os: ProfileOsTarget,
  androidDeviceType: AndroidDeviceType,
): string {
  const reducedVersion = ENGINE_CHROME.reduced;
  if (os === 'windows') {
    return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion} Safari/537.36`;
  }
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm') {
    return `Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion} Safari/537.36`;
  }
  if (os === 'android') {
    const compat = androidDeviceType === 'mobile' ? 'Mobile ' : '';
    return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion} ${compat}Safari/537.36`;
  }
  return `Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion} Safari/537.36`;
}

export function chromeMajorFromUserAgent(userAgent: string): string | undefined {
  return /Chrome\/(\d+)\./.exec(userAgent)?.[1];
}

export function chromeFullVersionForMajor(major: string): string {
  return major === ENGINE_CHROME.major ? ENGINE_CHROME.full : `${major}.0.0.0`;
}

export function uaPlatformVersionForSelection(
  os: ProfileOsTarget,
  osVersion: string,
): string | undefined {
  if (os === 'windows') return osVersion.includes('10') ? '10.0.0' : '15.0.0';
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm') {
    const major = /(\d+)/.exec(osVersion)?.[1];
    return major ? `${major}.0.0` : undefined;
  }
  if (os === 'android') {
    const major = /(\d+)/.exec(osVersion)?.[1];
    return major ? `${major}.0.0` : undefined;
  }
  return undefined;
}

/** Parse a screen option like `1920x1080` or `2560x1600 Retina` into CSS pixels + DPR. */
export function parseScreenOption(
  value: string,
): { width: number; height: number; devicePixelRatio: number } | undefined {
  const match = /^(\d+)\s*[x×]\s*(\d+)(.*)$/i.exec(value.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
    return undefined;
  }
  const retina = /retina/i.test(match[3] ?? '');
  return { width, height, devicePixelRatio: retina ? 2 : 1 };
}

export function findAndroidCatalogEntry(
  deviceType: AndroidDeviceType,
  label: string,
): AndroidDeviceCatalogEntry | undefined {
  const catalog =
    deviceType === 'mobile' ? ANDROID_PHONE_MODEL_CATALOG : ANDROID_TABLET_MODEL_CATALOG;
  return catalog.find((entry) => entry.label === label);
}

export function androidModelsForSelection(
  deviceType: AndroidDeviceType,
  osVersion: string,
): string[] {
  const catalog =
    deviceType === 'mobile' ? ANDROID_PHONE_MODEL_CATALOG : ANDROID_TABLET_MODEL_CATALOG;
  return filterAndroidCatalogByOsVersion(catalog, osVersion).map((entry) => entry.label);
}
