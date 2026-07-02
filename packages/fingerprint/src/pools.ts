import type { OsFamily } from '@lobster/shared-types';

/**
 * Built-in coherent device pools. Intentionally small for Day 0 — every entry describes a
 * plausible real machine. Day 1 replaces these with Apify fingerprint-suite's statistically
 * realistic, internally-consistent distributions (same shape, richer data).
 */
export interface DeviceTemplate {
  platform: string; // navigator.platform
  uaPlatform: string; // Sec-CH-UA-Platform
  uaPlatformVersion: string;
  osToken: string; // UA OS token, e.g. "Windows NT 10.0; Win64; x64"
  fonts: string[];
  webgl: ReadonlyArray<{
    vendor: string;
    renderer: string;
    unmaskedVendor: string;
    unmaskedRenderer: string;
  }>;
  screens: ReadonlyArray<{ width: number; height: number; dpr: number }>;
  hardwareConcurrency: readonly number[];
  deviceMemory: readonly number[];
}

const WINDOWS: DeviceTemplate = {
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
    'Tahoma',
    'Times New Roman',
    'Verdana',
  ],
  webgl: [
    {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unmaskedVendor: 'Google Inc. (NVIDIA)',
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unmaskedVendor: 'Google Inc. (Intel)',
      unmaskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    },
  ],
  screens: [
    { width: 1920, height: 1080, dpr: 1 },
    { width: 2560, height: 1440, dpr: 1 },
  ],
  hardwareConcurrency: [8, 12, 16],
  deviceMemory: [4, 8],
};

const MACOS: DeviceTemplate = {
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
    'San Francisco',
    'Times',
    'Verdana',
  ],
  webgl: [
    {
      vendor: 'Google Inc. (Apple)',
      renderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
      unmaskedVendor: 'Google Inc. (Apple)',
      unmaskedRenderer: 'ANGLE (Apple, ANGLE Metal Renderer: Apple M1, Unspecified Version)',
    },
  ],
  screens: [
    { width: 1512, height: 982, dpr: 2 },
    { width: 1728, height: 1117, dpr: 2 },
  ],
  hardwareConcurrency: [8, 10],
  deviceMemory: [4, 8],
};

const LINUX: DeviceTemplate = {
  platform: 'Linux x86_64',
  uaPlatform: 'Linux',
  uaPlatformVersion: '6.8.0',
  osToken: 'X11; Linux x86_64',
  fonts: [
    'DejaVu Sans',
    'DejaVu Serif',
    'Liberation Mono',
    'Liberation Sans',
    'Noto Sans',
    'Ubuntu',
  ],
  webgl: [
    {
      vendor: 'Google Inc. (Intel)',
      renderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
      unmaskedVendor: 'Google Inc. (Intel)',
      unmaskedRenderer: 'ANGLE (Intel, Mesa Intel(R) UHD Graphics 620 (KBL GT2), OpenGL 4.6)',
    },
  ],
  screens: [{ width: 1920, height: 1080, dpr: 1 }],
  hardwareConcurrency: [4, 8],
  deviceMemory: [4, 8],
};

export const DEVICE_TEMPLATES: Record<OsFamily, DeviceTemplate> = {
  windows: WINDOWS,
  macos: MACOS,
  linux: LINUX,
};

export const CHROME_VERSIONS = ['131.0.0.0', '130.0.0.0'] as const;
