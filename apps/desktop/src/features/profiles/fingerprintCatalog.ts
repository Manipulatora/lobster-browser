import {
  ANDROID_PHONE_MODEL_CATALOG,
  ANDROID_TABLET_MODEL_CATALOG,
  DESKTOP_DEVICE_MEMORY_VALUES,
  DEVICE_TIER_ENVELOPES,
  ENGINE_CHROME,
  LINUX_FONT_NAMES,
  LINUX_RENDERER_PRESETS,
  MACOS_APPLE_SILICON_MODES,
  MACOS_ARM_RENDERER_PRESETS,
  MACOS_FONT_NAMES,
  MACOS_INTEL_MODES,
  MACOS_INTEL_RENDERER_PRESETS,
  WINDOWS_FONT_NAMES,
  WINDOWS_RENDERER_PRESETS,
  defaultFontsForOs,
  displayModesFor,
  filterAndroidCatalogByOsVersion,
  gpuTierFromRenderer,
  normalizeMacFontFamily,
  type AndroidDeviceCatalogEntry,
  type DeviceTierEnvelope,
  type DisplayMode,
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

import { desktopOsForTarget } from './options';

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

/**
 * Desktop-only hardwareConcurrency choices for the Create Profile form. The low rungs are here because
 * derivation itself lands on them — an office laptop with an integrated GPU reports 4 threads — and a
 * picker that could not express the machine the seed produced would turn "pin what I was shown" into a
 * silent change of hardware.
 */
export const CPU_CORE_OPTIONS = [4, 6, 8, 10, 11, 12, 14, 16, 20, 24, 32] as const;

/**
 * Values Chromium can actually expose through `navigator.deviceMemory`. Calling these physical RAM
 * sizes was misleading: values above 8 GB all collapse to the same observable value.
 *
 * Only the rungs at or above the desktop floor are offered. A desktop UA reporting 2 GB is refused by
 * the coherence gate at launch, so the lower rungs could only ever produce a profile that saves and
 * then cannot start; they stay on the Android path, where a 2 GB phone is ordinary.
 */
export const DEVICE_MEMORY_OPTIONS: readonly number[] = DESKTOP_DEVICE_MEMORY_VALUES;

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

/**
 * macOS sizes come from the display model rather than a hand-kept list, and are split by architecture:
 * a Mac's CSS size is the "looks like" mode Apple ships for one specific panel, so an Intel MacBook
 * cannot present 1512x982 (a 14" M-series panel) any more than an M3 can present the 2016 15" mode.
 */
function macScreenOptions(modes: readonly DisplayMode[]): readonly string[] {
  return [...new Set(modes.map((mode) => `${mode.width}x${mode.height}`))].sort(
    compareScreenOption,
  );
}

export const MAC_ARM_SCREEN_OPTIONS = macScreenOptions(MACOS_APPLE_SILICON_MODES);
export const MAC_INTEL_SCREEN_OPTIONS = macScreenOptions(MACOS_INTEL_MODES);
export const MAC_SCREEN_OPTIONS = macScreenOptions([
  ...MACOS_INTEL_MODES,
  ...MACOS_APPLE_SILICON_MODES,
]);

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
  if (os === 'macos_arm') return MAC_ARM_SCREEN_OPTIONS;
  if (os === 'macos_intel') return MAC_INTEL_SCREEN_OPTIONS;
  if (os === 'macos') return MAC_SCREEN_OPTIONS;
  if (os === 'linux') return LINUX_SCREEN_OPTIONS;
  return WINDOWS_SCREEN_OPTIONS;
}

function compareScreenOption(a: string, b: string): number {
  const left = parseScreenOption(a);
  const right = parseScreenOption(b);
  if (!left || !right) return a.localeCompare(b, 'en');
  return left.width - right.width || left.height - right.height;
}

/**
 * The catalog sizes plus whatever the profile currently reports. A seed-derived machine can land on a
 * scaled mode the curated list does not name (1707x960 is a 1440p panel at 150%), and a picker that
 * silently dropped it would show a different screen than the profile actually uses.
 */
export function screenChoicesFor(os: ProfileOsTarget, current: string): readonly string[] {
  const options = screenOptionsForTarget(os);
  if (!parseScreenOption(current) || options.includes(current)) return options;
  return [...options, current].sort(compareScreenOption);
}

/**
 * The scale factors the selected screen can be presented at. `screen.width/height` are CSS pixels — the
 * panel divided by the OS scale step — so the ratio is not a free choice next to them: 1536x864 exists
 * only as a 1080p panel at 125%, and 1920x1080 at 125% would claim a 2400x1350 panel nobody makes. Both
 * numbers are read on the same line by every detector, so the picker offers only pairs that exist.
 */
export function devicePixelRatioOptionsFor(os: ProfileOsTarget, screen: string): number[] {
  const parsed = parseScreenOption(screen);
  const family = desktopOsForTarget(os);
  if (!parsed || !family) return [1];
  const ratios = new Set<number>();
  for (const mode of displayModesFor(family)) {
    if (mode.width === parsed.width && mode.height === parsed.height) ratios.add(mode.dpr);
  }
  if (ratios.size === 0) ratios.add(1);
  return [...ratios].sort((a, b) => a - b);
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

/**
 * The Android User-Agent an emulated phone persona sends. Chrome's reduced UA freezes the Android
 * version at 10 and the model at "K" on every device, so the only thing the model selection changes
 * here is the `Mobile` token — the device name itself travels in the UA-CH model hint.
 *
 * Desktop personas do not go through this: their UA is read back from the derived fingerprint, so the
 * preview cannot drift away from what the engine sends (see `draftUserAgent`).
 */
export function androidUserAgent(androidDeviceType: AndroidDeviceType): string {
  const compat = androidDeviceType === 'mobile' ? 'Mobile ' : '';
  return `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${ENGINE_CHROME.reduced} ${compat}Safari/537.36`;
}

/**
 * `Sec-CH-UA-Platform-Version` for the selected OS version, mirroring what the launcher's
 * `applyProfileOsVersion` will do — the modal must preview the hint the engine actually sends.
 *
 * Linux is deliberately absent: Chrome reports an EMPTY platform version there, on every distribution.
 * Answering "Ubuntu 24.04" with a version string would be a value no real Linux Chrome emits.
 */
export function uaPlatformVersionForSelection(
  os: ProfileOsTarget,
  osVersion: string,
): string | undefined {
  if (os === 'windows') {
    if (/Windows\s+10\b/i.test(osVersion)) return '10.0.0';
    if (/Windows\s+11\b/i.test(osVersion)) return '15.0.0';
    return undefined;
  }
  if (os === 'macos' || os === 'macos_intel' || os === 'macos_arm') {
    const major = /macOS\s+(\d+)/i.exec(osVersion)?.[1];
    return major ? `${major}.0.0` : undefined;
  }
  if (os === 'android') {
    const major = /(\d+)/.exec(osVersion)?.[1];
    return major ? `${major}.0.0` : undefined;
  }
  return undefined;
}

/**
 * The cores/memory envelope the pinned GPU implies. A machine is bought whole: 24 threads next to an
 * integrated GPU, or a discrete card next to 4 GB, is refused by the coherence gate at launch, so the
 * editor has to catch the pairing while the user can still change it.
 */
export function deviceTierEnvelopeFor(
  os: ProfileOsTarget,
  presetId: string,
): DeviceTierEnvelope | undefined {
  const preset = rendererPresetById(os, presetId);
  if (!preset) return undefined;
  return DEVICE_TIER_ENVELOPES[
    gpuTierFromRenderer(preset.webgl.unmaskedRenderer || preset.webgl.renderer)
  ];
}

/**
 * Parse a screen option like `1920x1080` into CSS pixels.
 *
 * The scale factor is NOT inferred from the label. A "Retina" suffix answered the question for macOS
 * only and answered it wrongly everywhere else: 1536x864 is a 1080p panel at 125%, so reading it as
 * dpr 1 described a panel that has never been manufactured. The ratio is its own choice, drawn from
 * {@link devicePixelRatioOptionsFor}.
 */
export function parseScreenOption(value: string): { width: number; height: number } | undefined {
  const match = /^(\d+)\s*[x×]\s*(\d+)\s*$/i.exec(value.trim());
  if (!match) return undefined;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 100 || height < 100) {
    return undefined;
  }
  return { width, height };
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
