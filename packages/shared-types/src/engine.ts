/**
 * Which browser engine backs a profile. Lobium is the only product engine: every profile launches the
 * custom Chromium build and receives the native config channel. Chromium may still appear in external
 * automation examples as Playwright/Selenium API terminology, but it is not a Lobster engine choice.
 */
export const ENGINE_KINDS = ['lobium'] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

/** The OS a fingerprint claims to be. Must stay coherent with UA, fonts, and WebGL. */
export const OS_FAMILIES = ['windows', 'macos', 'linux'] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];

/**
 * User-facing profile OS targets. macOS Intel and Apple Silicon are distinct product personas, even
 * though Chrome's reduced UA still reports `MacIntel` for both; the engine maps them to coherent
 * arch/GPU/font presets. Android is a mobile Lobium target, not a desktop Chromium disguise. iOS is
 * intentionally absent: Lobster is not pursuing an iOS/WebKit path.
 */
export const PLANNED_MOBILE_OS_FAMILIES = ['android'] as const;
export type PlannedMobileOsFamily = (typeof PLANNED_MOBILE_OS_FAMILIES)[number];
export const PROFILE_OS_TARGETS = [
  'windows',
  /** Legacy persisted value; the product UI now creates macOS Intel / macOS Arm explicitly. */
  'macos',
  'macos_intel',
  'macos_arm',
  'linux',
  'android',
] as const;
export type ProfileOsTarget = (typeof PROFILE_OS_TARGETS)[number];

/** CPU architecture a profile presents. */
export type CpuArch = 'x86_64' | 'arm64';

export interface EngineDescriptor {
  kind: EngineKind;
  /** Human label, e.g. "Lobium 131" or "Chromium 131". */
  label: string;
  /** The engine version string the profile presents (must match the UA-claimed version). */
  version: string;
}
