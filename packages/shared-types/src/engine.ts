/**
 * Which browser engine backs a profile.
 * - `kernel`   — the Lobster Kernel (our own Chromium build), the flagship engine (ADR-0004).
 * - `chromium` — ungoogled-Chromium, the default interim engine.
 * - `camoufox` — the High-Stealth interim engine.
 */
export type EngineKind = 'kernel' | 'chromium' | 'camoufox';

/** The OS a fingerprint claims to be. Must stay coherent with UA, fonts, and WebGL. */
export type OsFamily = 'windows' | 'macos' | 'linux';

/** CPU architecture a profile presents. */
export type CpuArch = 'x86_64' | 'arm64';

export interface EngineDescriptor {
  kind: EngineKind;
  /** Human label, e.g. "Chromium 131" or "Camoufox 133". */
  label: string;
  /** The engine version string the profile presents (must match the UA-claimed version). */
  version: string;
}
