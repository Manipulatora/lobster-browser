import type { CpuArch, OsFamily, WebGlFingerprint } from '@lobster/shared-types';
import type { SeededRandom } from './prng.js';
import {
  WINDOWS_RENDERER_PRESETS,
  LINUX_RENDERER_PRESETS,
  MACOS_ARM_RENDERER_PRESETS,
  MACOS_INTEL_RENDERER_PRESETS,
  type RendererCatalogEntry,
} from './catalog.generated.js';

/**
 * Coherent-device generator (catalog scale-up).
 *
 * The curated `pools.ts` bundles only ~21 desktop machines. This module turns the large sourced renderer
 * catalog (`catalog.generated.ts`: ~1838 Windows / ~1599 Linux / ~200 macOS real GPUs) into THOUSANDS of
 * coherent full device classes by pairing each real GPU with hardware (cores / reported memory / screen)
 * that is plausible for that GPU's TIER. The result is a real machine's identity, not random field-mixing:
 * a GTX-1050 never lands on 32 cores + a 4K display, and an RTX-4090 never lands on 4 cores + 768p.
 *
 * Reported memory is Chrome's spec-capped `navigator.deviceMemory` ({4,8}); screens use CSS-pixel logical
 * resolutions with the right devicePixelRatio (Apple Retina = 2, else 1) so screen.width×dpr matches a real
 * panel. Distributions are weighted toward real market share (StatCounter desktop resolutions; Apple panels).
 */

export type GpuTier =
  | 'apple-silicon'
  | 'workstation'
  | 'high-discrete'
  | 'mid-discrete'
  | 'entry-discrete'
  | 'integrated';

/** Classify a renderer into a hardware tier from its vendor family + model string. */
export function gpuTier(entry: RendererCatalogEntry): GpuTier {
  const r = entry.webgl.unmaskedRenderer || entry.webgl.renderer || '';
  if (entry.vendorFamily === 'Apple' || /Apple\s?M\d/.test(r)) return 'apple-silicon';
  if (
    /RTX\s?A\d{3,}|Quadro|Radeon\s?Pro\s?W|FirePro|RTX\s?(6000|5000)\s?(Ada|Generation)/.test(r)
  ) {
    return 'workstation';
  }
  if (
    /RTX\s?(30[789]0|3080|3090|40[789]0|4080|4090|50[789]0|5080|5090)|RX\s?(7[6789]00|6[89]00|6950|7900)|Arc\s?A7/.test(
      r,
    )
  ) {
    return 'high-discrete';
  }
  if (
    /RTX\s?(2060|2070|2080|3050|3060|3070|4050|4060|4070|5060|5070)|GTX\s?16\d\d|RX\s?(5500|5600|5700|6[567]00|590|580)|Arc\s?A[35]/.test(
      r,
    )
  ) {
    return 'mid-discrete';
  }
  if (/GTX\s?(9|10)\d\d|GT\s?\d|RX\s?(4[5678]0|5[45]0|550|560|570)|MX\s?\d/.test(r)) {
    return 'entry-discrete';
  }
  // Integrated / software: Intel iGPU, AMD APU, Mesa/llvmpipe, SwiftShader.
  return 'integrated';
}

interface Screen {
  width: number;
  height: number;
  dpr: number;
}

// Desktop panels (logical CSS px @ dpr 1).
const S_1080: Screen = { width: 1920, height: 1080, dpr: 1 };
const S_1440: Screen = { width: 2560, height: 1440, dpr: 1 };
const S_4K: Screen = { width: 3840, height: 2160, dpr: 1 };
const S_UW1440: Screen = { width: 3440, height: 1440, dpr: 1 };
const S_1200: Screen = { width: 1920, height: 1200, dpr: 1 };
// Laptop panels (Windows scaling folded into a coherent logical size).
const S_768: Screen = { width: 1366, height: 768, dpr: 1 };
const S_900: Screen = { width: 1600, height: 900, dpr: 1 };
const S_864: Screen = { width: 1536, height: 864, dpr: 1.25 };
// Apple Retina (logical CSS px @ dpr 2 — matches default macOS "looks like" scaling).
const S_MBA13: Screen = { width: 1470, height: 956, dpr: 2 };
const S_MBP14: Screen = { width: 1512, height: 982, dpr: 2 };
const S_MBP16: Screen = { width: 1728, height: 1117, dpr: 2 };
const S_IMAC24: Screen = { width: 2240, height: 1260, dpr: 2 };

interface Tier {
  cores: number[];
  /** navigator.deviceMemory candidates (spec-capped to {4,8}). */
  mem: number[];
  screens: Screen[];
}

const TIERS: Record<GpuTier, Tier> = {
  integrated: { cores: [4, 6, 8], mem: [4, 8], screens: [S_1080, S_768, S_900, S_864, S_1200] },
  'entry-discrete': { cores: [6, 8, 12], mem: [8], screens: [S_1080, S_1440] },
  'mid-discrete': { cores: [8, 12, 16], mem: [8], screens: [S_1080, S_1440] },
  'high-discrete': { cores: [12, 16, 24], mem: [8], screens: [S_1440, S_4K, S_UW1440, S_1080] },
  workstation: { cores: [16, 24, 32], mem: [8], screens: [S_1440, S_4K, S_UW1440] },
  'apple-silicon': {
    cores: [8, 10, 12, 14, 16],
    mem: [8],
    screens: [S_MBA13, S_MBP14, S_MBP16, S_IMAC24],
  },
};

function presetsFor(os: OsFamily, arch: CpuArch): readonly RendererCatalogEntry[] {
  if (os === 'windows') return WINDOWS_RENDERER_PRESETS;
  if (os === 'linux') return LINUX_RENDERER_PRESETS;
  // macos: Apple-Silicon (arm64) vs Intel (x86_64) are physically different GPU families.
  return arch === 'arm64' ? MACOS_ARM_RENDERER_PRESETS : MACOS_INTEL_RENDERER_PRESETS;
}

/** A generated device bundle — the fields deriveFromPools consumes (looser than DeviceProfile: caps optional). */
export interface GeneratedDevice {
  id: string;
  webgl: WebGlFingerprint;
  screen: Screen;
  hardwareConcurrency: number;
  deviceMemory: number;
}

/**
 * Deterministically pair a seeded real renderer with tier-coherent hardware. Returns null when the OS/arch
 * has no catalog presets (caller falls back to the curated flagship pool). Consumes exactly 4 rng draws.
 */
export function deriveCoherentDevice(
  rng: SeededRandom,
  os: OsFamily,
  arch: CpuArch,
): GeneratedDevice | null {
  const presets = presetsFor(os, arch);
  if (!presets || presets.length === 0) return null;
  const entry = rng.pick(presets);
  const t = TIERS[gpuTier(entry)];
  return {
    id: `gen-${entry.id}`,
    webgl: entry.webgl,
    screen: rng.pick(t.screens),
    hardwareConcurrency: rng.pick(t.cores),
    deviceMemory: rng.pick(t.mem),
  };
}

/** Total distinct real renderers reachable per OS (for diversity reporting/tests). */
export function catalogRendererCounts(): Record<string, number> {
  return {
    windows: WINDOWS_RENDERER_PRESETS.length,
    linux: LINUX_RENDERER_PRESETS.length,
    'macos-arm': MACOS_ARM_RENDERER_PRESETS.length,
    'macos-intel': MACOS_INTEL_RENDERER_PRESETS.length,
  };
}
