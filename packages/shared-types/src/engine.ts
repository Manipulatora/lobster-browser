/**
 * Which browser engine backs a profile. The runtime array is the single source of truth — backend
 * validation, the desktop UI, and the fingerprint engine all derive from it, so the set never drifts.
 * Both engines are Chromium-based, so profiles always present a Chrome fingerprint.
 * - `lobium`   — Lobium, our custom-built Chromium engine (flagship, ADR-0004). Until the custom
 *                build ships it is served by a patched Chromium via patchright.
 * - `chromium` — a prebuilt (ungoogled) Chromium driven via patchright (interim / everyday).
 */
export const ENGINE_KINDS = ['lobium', 'chromium'] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

/** The OS a fingerprint claims to be. Must stay coherent with UA, fonts, and WebGL. */
export const OS_FAMILIES = ['windows', 'macos', 'linux'] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];

/** CPU architecture a profile presents. */
export type CpuArch = 'x86_64' | 'arm64';

export interface EngineDescriptor {
  kind: EngineKind;
  /** Human label, e.g. "Lobium 131" or "Chromium 131". */
  label: string;
  /** The engine version string the profile presents (must match the UA-claimed version). */
  version: string;
}
