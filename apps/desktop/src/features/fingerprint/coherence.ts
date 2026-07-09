import {
  applyOverrides,
  deriveFingerprint,
  validateFingerprintCoherence,
} from '@lobster/fingerprint';
import type {
  EngineKind,
  Fingerprint,
  FingerprintOverrides,
  OsFamily,
} from '@lobster/shared-types';

/**
 * Live persona preview + coherence check for the fingerprint editor (UI-4).
 *
 * `@lobster/fingerprint` is pure TypeScript (no Node built-ins in the derive/coherence path), so it runs
 * directly in the browser. This lets the editor show the EXACT persona the engine will launch and flag
 * any incoherent field combination BEFORE launch — the same `validateFingerprintCoherence` the sidecar
 * fail-closes on, so the UI never lets a user build an identity the engine would then refuse.
 */
export interface PersonaPreview {
  fingerprint: Fingerprint | null;
  issues: string[];
  ok: boolean;
  error?: string;
}

export function previewPersona(
  seed: string,
  os: OsFamily,
  engine: EngineKind,
  overrides?: FingerprintOverrides,
): PersonaPreview {
  try {
    const base = deriveFingerprint(seed || 'preview-seed', { os, engine });
    const fingerprint = overrides ? applyOverrides(base, overrides) : base;
    const issues = validateFingerprintCoherence(fingerprint);
    return { fingerprint, issues, ok: issues.length === 0 };
  } catch (e) {
    return {
      fingerprint: null,
      issues: [],
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }
}

/**
 * Per-field engine support disposition, so the editor can badge what the native engine honors vs what is
 * best-effort or planned (prevents advertising unsupported behavior — roadmap risk #9).
 */
export type SupportLevel = 'native' | 'cdp' | 'planned';

export const FIELD_SUPPORT: Record<string, { level: SupportLevel; note: string }> = {
  userAgent: { level: 'native', note: 'Set natively in all contexts (main + workers).' },
  platform: { level: 'native', note: 'Native navigator.platform + Sec-CH-UA-Platform.' },
  hardwareConcurrency: { level: 'native', note: 'Native navigator.hardwareConcurrency.' },
  deviceMemory: { level: 'native', note: 'Native navigator.deviceMemory (secure-context).' },
  screen: { level: 'native', note: 'Native screen geometry / DPR / colorDepth.' },
  webglRenderer: { level: 'native', note: 'Native WebGL vendor/renderer string + farbled pixels.' },
  webglDeep: { level: 'planned', note: 'Extensions/precision from host calibration (HC-4, pending native hook).' },
  timezone: { level: 'cdp', note: 'Applied over CDP (Emulation.setTimezoneOverride).' },
  locale: { level: 'cdp', note: 'Applied over CDP + Accept-Language.' },
  geolocation: { level: 'cdp', note: 'Applied over CDP; permission granted at context level.' },
  webrtc: { level: 'native', note: 'WebRTC IP policy via launch flags + native config.' },
  canvasNoise: { level: 'native', note: 'Native canvas farbling (seeded per profile).' },
  audioNoise: { level: 'native', note: 'Native Web Audio farbling (seeded per profile).' },
  mediaDevices: { level: 'planned', note: 'Camera/mic/speaker counts — native consumption pending.' },
  clientRects: { level: 'planned', note: 'getClientRects noise — native consumption pending.' },
};
