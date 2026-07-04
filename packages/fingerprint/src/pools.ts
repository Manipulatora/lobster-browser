import type { OsFamily } from '@lobster/shared-types';

/**
 * Lobster's OWN internal coherent device catalog — the source of truth for base device fingerprints.
 * No third-party fingerprint-generation API is involved (see derive.ts): realism comes from curated,
 * plausible device CLASSES, not from a shared statistical distribution (which would itself be a tell)
 * and not from arbitrary random field-mixing.
 *
 * The unit is a {@link DeviceProfile}: ONE real machine, with its GPU, screen, CPU-core count and
 * device-memory bundled so they always describe a coherent whole (e.g. a gaming desktop pairs a
 * discrete GPU with a 1440p screen and 8+ cores; a thin laptop pairs an integrated GPU with 1080p and
 * fewer cores). A seed selects a whole profile, so no field can drift out of its device's plausible
 * range. OS-wide fields (platform, UA-CH platform, fonts, UA OS token) live on the {@link OsTemplate}.
 *
 * Coherence rules these entries MUST satisfy (enforced by validateFingerprintCoherence + its tests):
 *  - Windows GPUs render through ANGLE's Direct3D11 backend ("Google Inc. (Vendor)" +
 *    "ANGLE (Vendor, … Direct3D11 …)") and never use a macOS/legacy string (no "Intel Inc.",
 *    "ATI Technologies Inc.", "OpenGL Engine", or "Metal Renderer").
 *  - macOS GPUs use ANGLE's Metal backend ("ANGLE Metal Renderer: Apple …"); Apple Silicon still
 *    reports navigator.platform "MacIntel" (real Chrome behaviour).
 *  - Linux GPUs use Mesa/OpenGL (never the Windows-only Direct3D) and a real GPU (never a software
 *    rasteriser like SwiftShader/llvmpipe).
 *  - deviceMemory is a spec value in {4, 8} (navigator.deviceMemory is capped at 8; desktops floor
 *    at 4). It represents "≥ N GB", so a 16/32 GB machine still reports 8.
 */
export interface DeviceProfile {
  /** Stable id for tests/telemetry (e.g. "win-nvidia-rtx3060"); never surfaced to the page. */
  id: string;
  webgl: {
    vendor: string;
    renderer: string;
    unmaskedVendor: string;
    unmaskedRenderer: string;
  };
  screen: { width: number; height: number; dpr: number };
  hardwareConcurrency: number;
  /** Spec value in {4, 8} — see the coherence note above. */
  deviceMemory: number;
}

export interface OsTemplate {
  platform: string; // navigator.platform
  uaPlatform: string; // Sec-CH-UA-Platform
  uaPlatformVersion: string;
  osToken: string; // UA OS token, e.g. "Windows NT 10.0; Win64; x64"
  fonts: string[];
  /** Coherent machine classes for this OS. A seed picks exactly one. */
  devices: readonly DeviceProfile[];
}

/** Windows GPU renderer string in ANGLE Direct3D11 form (the only backend real Windows Chrome uses). */
function winGpu(vendor: 'NVIDIA' | 'Intel' | 'AMD', model: string): DeviceProfile['webgl'] {
  const v = `Google Inc. (${vendor})`;
  const r = `ANGLE (${vendor}, ${model} Direct3D11 vs_5_0 ps_5_0, D3D11)`;
  return { vendor: v, renderer: r, unmaskedVendor: v, unmaskedRenderer: r };
}

const WINDOWS: OsTemplate = {
  platform: 'Win32',
  uaPlatform: 'Windows',
  uaPlatformVersion: '15.0.0',
  osToken: 'Windows NT 10.0; Win64; x64',
  fonts: [
    'Arial',
    'Calibri',
    'Cambria',
    'Consolas',
    'Segoe UI',
    'Segoe UI Emoji',
    'Tahoma',
    'Times New Roman',
    'Trebuchet MS',
    'Verdana',
  ],
  devices: [
    {
      id: 'win-nvidia-rtx3060',
      webgl: winGpu('NVIDIA', 'NVIDIA GeForce RTX 3060'),
      screen: { width: 2560, height: 1440, dpr: 1 },
      hardwareConcurrency: 16,
      deviceMemory: 8,
    },
    {
      id: 'win-nvidia-rtx4060',
      webgl: winGpu('NVIDIA', 'NVIDIA GeForce RTX 4060'),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 16,
      deviceMemory: 8,
    },
    {
      id: 'win-nvidia-gtx1660ti',
      webgl: winGpu('NVIDIA', 'NVIDIA GeForce GTX 1660 Ti'),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 12,
      deviceMemory: 8,
    },
    {
      id: 'win-amd-rx6600',
      webgl: winGpu('AMD', 'AMD Radeon RX 6600'),
      screen: { width: 2560, height: 1440, dpr: 1 },
      hardwareConcurrency: 12,
      deviceMemory: 8,
    },
    {
      id: 'win-amd-rx580',
      webgl: winGpu('AMD', 'AMD Radeon RX 580'),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'win-intel-irisxe',
      webgl: winGpu('Intel', 'Intel(R) Iris(R) Xe Graphics'),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'win-intel-uhd620',
      webgl: winGpu('Intel', 'Intel(R) UHD Graphics 620'),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'win-intel-uhd630',
      webgl: winGpu('Intel', 'Intel(R) UHD Graphics 630'),
      screen: { width: 1536, height: 864, dpr: 1.25 },
      hardwareConcurrency: 6,
      deviceMemory: 8,
    },
  ],
};

/** macOS (Apple Silicon) GPU renderer string in ANGLE Metal form. */
function macGpu(chip: string): DeviceProfile['webgl'] {
  const v = 'Google Inc. (Apple)';
  const r = `ANGLE (Apple, ANGLE Metal Renderer: Apple ${chip}, Unspecified Version)`;
  return { vendor: v, renderer: r, unmaskedVendor: v, unmaskedRenderer: r };
}

const MACOS: OsTemplate = {
  platform: 'MacIntel',
  uaPlatform: 'macOS',
  uaPlatformVersion: '14.5.0',
  osToken: 'Macintosh; Intel Mac OS X 10_15_7',
  fonts: [
    'Arial',
    'Helvetica',
    'Helvetica Neue',
    'Menlo',
    'Monaco',
    'PingFang SC',
    'San Francisco',
    'Times',
    'Verdana',
  ],
  devices: [
    {
      id: 'mac-m1',
      webgl: macGpu('M1'),
      screen: { width: 1512, height: 982, dpr: 2 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'mac-m2',
      webgl: macGpu('M2'),
      screen: { width: 1512, height: 982, dpr: 2 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'mac-m3',
      webgl: macGpu('M3'),
      screen: { width: 1728, height: 1117, dpr: 2 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'mac-m1pro',
      webgl: macGpu('M1 Pro'),
      screen: { width: 1728, height: 1117, dpr: 2 },
      hardwareConcurrency: 10,
      deviceMemory: 8,
    },
    {
      id: 'mac-m2pro',
      webgl: macGpu('M2 Pro'),
      screen: { width: 1728, height: 1117, dpr: 2 },
      hardwareConcurrency: 12,
      deviceMemory: 8,
    },
  ],
};

/** Linux GPU renderer string in Mesa/OpenGL form (no Direct3D — that is Windows-only). */
function linuxGpu(vendor: 'Intel' | 'AMD' | 'NVIDIA', renderer: string): DeviceProfile['webgl'] {
  const v = `Google Inc. (${vendor})`;
  return { vendor: v, renderer, unmaskedVendor: v, unmaskedRenderer: renderer };
}

const LINUX: OsTemplate = {
  platform: 'Linux x86_64',
  uaPlatform: 'Linux',
  uaPlatformVersion: '6.8.0',
  osToken: 'X11; Linux x86_64',
  fonts: [
    'DejaVu Sans',
    'DejaVu Serif',
    'FreeMono',
    'Liberation Mono',
    'Liberation Sans',
    'Noto Sans',
    'Ubuntu',
  ],
  devices: [
    {
      id: 'linux-intel-uhd620',
      webgl: linuxGpu(
        'Intel',
        'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
      ),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 4,
      deviceMemory: 8,
    },
    {
      id: 'linux-intel-irisxe',
      webgl: linuxGpu('Intel', 'ANGLE (Intel, Mesa Intel(R) Xe Graphics (TGL GT2), OpenGL 4.6)'),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'linux-amd-rx6600',
      webgl: linuxGpu(
        'AMD',
        'ANGLE (AMD, AMD Radeon RX 6600 (radeonsi, navi23, LLVM 15.0.7, DRM 3.49, 6.5.0), OpenGL 4.6)',
      ),
      screen: { width: 2560, height: 1440, dpr: 1 },
      hardwareConcurrency: 16,
      deviceMemory: 8,
    },
    {
      id: 'linux-nvidia-rtx3060',
      webgl: linuxGpu('NVIDIA', 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6.0)'),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 12,
      deviceMemory: 8,
    },
    {
      id: 'linux-intel-uhd630',
      webgl: linuxGpu(
        'Intel',
        'ANGLE (Intel, Mesa Intel(R) UHD Graphics 630 (CFL GT2), OpenGL 4.6)',
      ),
      screen: { width: 1920, height: 1080, dpr: 1 },
      hardwareConcurrency: 4,
      deviceMemory: 4,
    },
  ],
};

export const DEVICE_TEMPLATES: Record<OsFamily, OsTemplate> = {
  windows: WINDOWS,
  macos: MACOS,
  linux: LINUX,
};

/**
 * The Chrome version the catalog advertises. It MUST equal the actually-launched engine's version:
 * a detector that feature-detects the engine — or simply reads `getHighEntropyValues(['fullVersionList'])`,
 * which returns the REAL build the CDP UA override does not mask — catches any mismatch as a lie. (This
 * was a real tell: a persona claiming Chrome 151 leaked `Chromium 152.0.7928.0` via fullVersionList.)
 *
 * So we pin to the running engine (Lobium = 152.0.7928.0) rather than a diverse pool — every profile
 * runs the SAME binary, so they must all claim ITS version; cross-profile version diversity would be a
 * lie the moment a detector feature-probes the engine. Chrome caps `navigator.userAgent` at
 * `major.0.0.0` (UA reduction), while the high-entropy `uaFullVersion` / `fullVersionList` carry the
 * full build — so we track both forms.
 *
 * `deriveFingerprint({ browserVersion })` overrides this when the sidecar knows a different engine build.
 */
export const ENGINE_CHROME = {
  major: '152',
  /** navigator.userAgent form (UA-reduced to major.0.0.0). */
  reduced: '152.0.0.0',
  /** getHighEntropyValues(['uaFullVersion'|'fullVersionList']) form (real build). */
  full: '152.0.7928.0',
} as const;

/** Split a full Chrome build (e.g. "152.0.7928.0") into the UA-reduced + major forms it must present. */
export function chromeVersionForms(full: string): { major: string; reduced: string; full: string } {
  const major = full.split('.')[0] ?? ENGINE_CHROME.major;
  return { major, reduced: `${major}.0.0.0`, full };
}
