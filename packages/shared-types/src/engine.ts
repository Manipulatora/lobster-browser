/**
 * Which browser engine backs a profile. The runtime array is the single source of truth — backend
 * validation, the desktop UI, and the fingerprint engine all derive from it, so the set never drifts.
 * - `kernel`   — the Lobster Kernel (our own Chromium build), the flagship engine (ADR-0004).
 * - `chromium` — ungoogled-Chromium, the default interim engine.
 * - `camoufox` — the High-Stealth interim engine.
 */
export const ENGINE_KINDS = ['kernel', 'chromium', 'camoufox'] as const;
export type EngineKind = (typeof ENGINE_KINDS)[number];

/** The OS a fingerprint claims to be. Must stay coherent with UA, fonts, and WebGL. */
export const OS_FAMILIES = ['windows', 'macos', 'linux'] as const;
export type OsFamily = (typeof OS_FAMILIES)[number];

/** CPU architecture a profile presents. */
export type CpuArch = 'x86_64' | 'arm64';

export interface EngineDescriptor {
  kind: EngineKind;
  /** Human label, e.g. "Chromium 131" or "Camoufox 133". */
  label: string;
  /** The engine version string the profile presents (must match the UA-claimed version). */
  version: string;
}
