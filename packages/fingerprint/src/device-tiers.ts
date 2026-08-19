import type { CpuArch, OsFamily, WebGlFingerprint } from '@lobster/shared-types';
import type { SeededRandom } from './prng.js';
import type { RendererCatalogEntry } from './catalog.generated.js';
import {
  WINDOWS_RENDERER_PRESETS,
  LINUX_RENDERER_PRESETS,
  MACOS_ARM_RENDERER_PRESETS,
  MACOS_INTEL_RENDERER_PRESETS,
  type ProductRendererCatalogEntry,
} from './catalog.js';
import { MACOS_APPLE_SILICON_MODES, MACOS_INTEL_MODES, type DisplayMode } from './displays.js';

/**
 * Coherent-device generator (catalog scale-up).
 *
 * The curated `pools.ts` bundles only ~21 desktop machines. This module turns the sourced renderer catalog
 * (`catalog.ts`: hundreds of current, real GPUs per OS) into THOUSANDS of
 * coherent full device classes by pairing each real GPU with hardware (cores / reported memory / screen)
 * that is plausible for that GPU's TIER. The result is a real machine's identity, not random field-mixing:
 * a GTX-1050 never lands on 32 cores + a 4K display, and an RTX-4090 never lands on 4 cores + 768p.
 *
 * Reported memory is Chrome's spec-capped `navigator.deviceMemory` ({4,8}); screens are whole display MODES
 * (`displays.ts`) — a CSS size together with the scale factor that produces it — so a persona claims a panel
 * that exists at a scaling step the OS offers. Distributions are weighted toward real market share
 * (StatCounter desktop resolutions; Apple panels).
 */

export type GpuTier =
  | 'apple-silicon'
  | 'workstation'
  | 'high-discrete'
  | 'mid-discrete'
  | 'entry-discrete'
  | 'integrated';

/**
 * Classify a renderer string into a hardware tier. Takes the raw string rather than a catalog entry so
 * the coherence gate can tier a persona whose GPU came from a user override or a host capture, not only
 * one this module generated.
 */
export function gpuTierFromRenderer(r: string): GpuTier {
  if (/Apple\s?M\d/.test(r)) return 'apple-silicon';
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

/** Classify a catalog entry, trusting its recorded vendor family over the renderer string. */
export function gpuTier(entry: Pick<RendererCatalogEntry, 'vendorFamily' | 'webgl'>): GpuTier {
  if (entry.vendorFamily === 'Apple') return 'apple-silicon';
  return gpuTierFromRenderer(entry.webgl.unmaskedRenderer || entry.webgl.renderer || '');
}

// Desktop monitors at 100%.
const S_1080: DisplayMode = { width: 1920, height: 1080, dpr: 1 };
const S_1440: DisplayMode = { width: 2560, height: 1440, dpr: 1 };
const S_4K: DisplayMode = { width: 3840, height: 2160, dpr: 1 };
const S_UW1440: DisplayMode = { width: 3440, height: 1440, dpr: 1 };
const S_1200: DisplayMode = { width: 1920, height: 1200, dpr: 1 };
// Laptop panels running the OS scaling their pixel density calls for: a 1080p 14" laptop sits at 125%
// and a 1440p/4K one at 150–200%, which is what makes 1536x864 and 1280x720 the sizes analytics see.
const S_768: DisplayMode = { width: 1366, height: 768, dpr: 1 };
const S_900: DisplayMode = { width: 1600, height: 900, dpr: 1 };
const S_864: DisplayMode = { width: 1536, height: 864, dpr: 1.25 };
const S_960: DisplayMode = { width: 1536, height: 960, dpr: 1.25 };
const S_720_150: DisplayMode = { width: 1280, height: 720, dpr: 1.5 };
const S_1152_125: DisplayMode = { width: 2048, height: 1152, dpr: 1.25 };
const S_960_150: DisplayMode = { width: 1707, height: 960, dpr: 1.5 };
const S_1440_150: DisplayMode = { width: 2560, height: 1440, dpr: 1.5 };
const S_1080_200: DisplayMode = { width: 1920, height: 1080, dpr: 2 };

interface Tier {
  cores: number[];
  /** navigator.deviceMemory candidates (spec-capped to {4,8}). */
  mem: number[];
  screens: DisplayMode[];
}

const TIERS: Record<GpuTier, Tier> = {
  integrated: {
    cores: [4, 6, 8],
    mem: [4, 8],
    screens: [S_1080, S_768, S_900, S_864, S_1200, S_720_150, S_960],
  },
  'entry-discrete': { cores: [6, 8, 12], mem: [8], screens: [S_1080, S_1440, S_864] },
  'mid-discrete': {
    cores: [8, 12, 16],
    mem: [8],
    screens: [S_1080, S_1440, S_1152_125, S_960_150, S_864],
  },
  'high-discrete': {
    cores: [12, 16, 24],
    mem: [8],
    screens: [S_1440, S_4K, S_UW1440, S_1080, S_1440_150, S_1080_200],
  },
  workstation: {
    cores: [16, 24, 32],
    mem: [8],
    screens: [S_1440, S_4K, S_UW1440, S_1440_150, S_1152_125],
  },
  'apple-silicon': { cores: [8, 10, 12, 14, 16], mem: [8], screens: [] },
};

/**
 * The hardware a tier's GPU is actually found next to. Deliberately WIDER than the generator's own
 * candidates: a machine is not implausible merely because we would not have generated it (an RTX 4090
 * behind an ageing 4-core CPU is a real upgrade path, and 32-thread HX laptops do render through their
 * iGPU). What no machine ships is a discrete-GPU box with under 8 GB of RAM, an M-series Mac with fewer
 * than 8 cores, or a workstation GPU on a dual-core.
 */
export interface DeviceTierEnvelope {
  minCores: number;
  maxCores: number;
  /** Lowest `navigator.deviceMemory` the tier ever reports (the value means "at least N GB"). */
  minDeviceMemory: number;
}

export const DEVICE_TIER_ENVELOPES: Record<GpuTier, DeviceTierEnvelope> = {
  integrated: { minCores: 2, maxCores: 32, minDeviceMemory: 4 },
  'entry-discrete': { minCores: 2, maxCores: 32, minDeviceMemory: 4 },
  'mid-discrete': { minCores: 4, maxCores: 64, minDeviceMemory: 8 },
  'high-discrete': { minCores: 4, maxCores: 128, minDeviceMemory: 8 },
  workstation: { minCores: 6, maxCores: 128, minDeviceMemory: 8 },
  'apple-silicon': { minCores: 8, maxCores: 32, minDeviceMemory: 8 },
};

/**
 * Above this thread count a machine has never shipped with under 8 GB of RAM, whatever GPU drives it —
 * the tell in a "24 cores + 4 GB" persona is the pairing, not either value alone.
 */
export const HIGH_CORE_MEMORY_FLOOR = { cores: 16, deviceMemory: 8 };

/**
 * Panels a tier's machines are sold with. macOS is answered from the Mac mode lists rather than the
 * tier table: an Intel MacBook's Iris GPU tiers as "integrated", but it ships a Retina panel, never the
 * 1366x768 a Windows laptop with the same GPU would have.
 */
function tierScreens(os: OsFamily, arch: CpuArch, tier: GpuTier): readonly DisplayMode[] {
  if (os === 'macos') {
    return tier === 'apple-silicon' || arch === 'arm64'
      ? MACOS_APPLE_SILICON_MODES
      : MACOS_INTEL_MODES;
  }
  return TIERS[tier].screens;
}

/**
 * The GPUs a persona may claim. Deliberately the PRODUCT catalog rather than the raw sourced one: the
 * raw arrays are provenance data straight out of pci.ids, and two thirds of their Windows rows carry a
 * parser artefact (`GeForce 6800 Ultra]`) or a card from 2004 that cannot run Chrome 152 at all. Both
 * land in the page-visible ANGLE renderer string, where a bracket no GPU driver emits — or a GeForce 6
 * advertising Direct3D11 vs_5_0 — identifies the product instead of hiding it. `catalog.ts` is the
 * filtered, cleaned view, and its ids are the ones the profile UI's renderer picker resolves, so a
 * derived GPU can also be pinned by name.
 */
function presetsFor(os: OsFamily, arch: CpuArch): readonly ProductRendererCatalogEntry[] {
  if (os === 'windows') return WINDOWS_RENDERER_PRESETS;
  if (os === 'linux') return LINUX_RENDERER_PRESETS;
  // macos: Apple-Silicon (arm64) vs Intel (x86_64) are physically different GPU families.
  return arch === 'arm64' ? MACOS_ARM_RENDERER_PRESETS : MACOS_INTEL_RENDERER_PRESETS;
}

/** A generated device bundle — the fields deriveFromPools consumes (looser than DeviceProfile: caps optional). */
export interface GeneratedDevice {
  id: string;
  /** The sourced-catalog GPU preset behind this device, so the UI can name (and pin) the same one. */
  presetId: string;
  /** Human GPU model, e.g. "NVIDIA GeForce RTX 4070" — display only, never page-visible. */
  label: string;
  webgl: WebGlFingerprint;
  screen: DisplayMode;
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
  const tier = gpuTier(entry);
  const t = TIERS[tier];
  return {
    id: `gen-${entry.id}`,
    presetId: entry.id,
    label: entry.label,
    webgl: entry.webgl,
    screen: rng.pick(tierScreens(os, arch, tier)),
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
