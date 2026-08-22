import type { OsFamily, WebGlCaps } from '@lobster/shared-types';
import { MACOS_FONT_NAMES, WINDOWS_FONT_NAMES } from './catalog.generated.js';

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
    /** Numeric GPU limits (ENG-8) — a real-ANGLE profile for the backend, not the software backend. */
    caps: WebGlCaps;
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

// Real-ANGLE WebGL capability profiles per backend. These replace the software (SwiftShader) backend's
// distinctly-low limits (e.g. MAX_TEXTURE_SIZE 8192) with values a real GPU reports through ANGLE, so the
// numeric caps agree with the spoofed renderer string. ANGLE normalises most limits across GPUs within a
// backend, so a per-backend profile is coherent for the common case; exact per-GPU caps + the extension
// list need real-GPU capture (the real-GPU boundary) and are left to the backend.
const D3D11_CAPS: WebGlCaps = {
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  // ANGLE's D3D11 backend sets maxViewportWidth/Height to D3D11_VIEWPORT_BOUNDS_MAX (32767) for
  // feature level 11_0 and above - renderer11_utils.cpp GetMaximumViewportSize(). It is NOT clamped
  // to the texture size: that coupling belongs to the Metal and GL backends. 16384 was therefore a
  // MAX_VIEWPORT_DIMS no Chrome on Windows reports, readable with a single getParameter call.
  maxViewportDims: [32767, 32767],
  maxVertexAttribs: 16,
  maxVertexUniformVectors: 4096,
  maxFragmentUniformVectors: 1024,
  maxVaryingVectors: 30,
  maxTextureImageUnits: 16,
  maxVertexTextureImageUnits: 16,
  maxCombinedTextureImageUnits: 32,
  aliasedLineWidthRange: [1, 1],
  aliasedPointSizeRange: [1, 1024],
};
/**
 * D3D11 caps as ANGLE reports them ON NVIDIA.
 *
 * renderer11_utils.cpp takes maxVertexUniformVectors from D3D11_REQ_CONSTANT_BUFFER_ELEMENT_COUNT
 * (4096) and then does `if (features.skipVSConstantRegisterZero.enabled) caps->maxVertexUniformVectors -= 1;`
 * - and that feature is switched on for NVIDIA and nothing else
 * (`ANGLE_FEATURE_CONDITION(features, skipVSConstantRegisterZero, isNvidia)`). So an NVIDIA card on
 * Windows reports 4095 where Intel and AMD report 4096. A persona naming a GeForce and reporting
 * 4096 contradicts itself in one getParameter call.
 */
const D3D11_CAPS_NVIDIA: WebGlCaps = { ...D3D11_CAPS, maxVertexUniformVectors: 4095 };

const METAL_CAPS: WebGlCaps = {
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxViewportDims: [16384, 16384],
  maxVertexAttribs: 16,
  maxVertexUniformVectors: 1024,
  maxFragmentUniformVectors: 1024,
  // 30, not 31. ANGLE's Metal backend does `maxVaryingVectors = 31 - 1` on macOS, with the comment
  // "On macOS exclude [[position]] from maxVaryingVectors" (DisplayMtl.mm). The paired component
  // limit is 124 - 4 = 120, i.e. exactly 4x30, so a persona claiming 31 also contradicted its own
  // WebGL2 component counts.
  maxVaryingVectors: 30,
  maxTextureImageUnits: 16,
  maxVertexTextureImageUnits: 16,
  maxCombinedTextureImageUnits: 32,
  aliasedLineWidthRange: [1, 1],
  aliasedPointSizeRange: [1, 511],
};
const GL_CAPS: WebGlCaps = {
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxViewportDims: [16384, 16384],
  maxVertexAttribs: 16,
  // 1024, not 4096. ANGLE's OpenGL backend hard-clamps this regardless of what the driver reports:
  // renderergl_utils.cpp does `caps->maxVertexUniformVectors = std::min(1024, ...)`, with a comment
  // that the WebGL conformance suite cannot finish otherwise. So no Chrome on Linux has ever
  // reported more than 1024 here, and 4096 was a single-getParameter tell on every Linux persona.
  // (4096 IS right on Windows, where the D3D11 backend uses D3D11_REQ_CONSTANT_BUFFER_ELEMENT_COUNT.)
  maxVertexUniformVectors: 1024,
  maxFragmentUniformVectors: 1024,
  // 30, matching MESA_CAPS in the generated catalog. Two Linux capability profiles used to ship
  // in the same product disagreeing on this value, so which number a Linux persona reported
  // depended on whether its GPU came from the curated pool or the generated preset list.
  maxVaryingVectors: 30,
  maxTextureImageUnits: 16,
  maxVertexTextureImageUnits: 16,
  maxCombinedTextureImageUnits: 32,
  aliasedLineWidthRange: [1, 1],
  aliasedPointSizeRange: [1, 2047],
};

const MOBILE_GLES_CAPS: WebGlCaps = {
  maxTextureSize: 16384,
  maxCubeMapTextureSize: 16384,
  maxRenderbufferSize: 16384,
  maxViewportDims: [16384, 16384],
  maxVertexAttribs: 16,
  maxVertexUniformVectors: 1024,
  maxFragmentUniformVectors: 1024,
  maxVaryingVectors: 31,
  maxTextureImageUnits: 16,
  maxVertexTextureImageUnits: 16,
  maxCombinedTextureImageUnits: 32,
  aliasedLineWidthRange: [1, 1],
  aliasedPointSizeRange: [1, 1024],
};

/** Windows GPU renderer string in ANGLE Direct3D11 form (the only backend real Windows Chrome uses). */
function winGpu(vendor: 'NVIDIA' | 'Intel' | 'AMD', model: string): DeviceProfile['webgl'] {
  const v = `Google Inc. (${vendor})`;
  const r = `ANGLE (${vendor}, ${model} Direct3D11 vs_5_0 ps_5_0, D3D11)`;
  const caps = vendor === 'NVIDIA' ? D3D11_CAPS_NVIDIA : D3D11_CAPS;
  return { vendor: v, renderer: r, unmaskedVendor: v, unmaskedRenderer: r, caps };
}

const WINDOWS: OsTemplate = {
  platform: 'Win32',
  uaPlatform: 'Windows',
  uaPlatformVersion: '15.0.0',
  osToken: 'Windows NT 10.0; Win64; x64',
  fonts: [...WINDOWS_FONT_NAMES],
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
  return { vendor: v, renderer: r, unmaskedVendor: v, unmaskedRenderer: r, caps: METAL_CAPS };
}

/** macOS Intel/AMD GPU renderer string in the modern ANGLE Metal form. */
function macIntelGpu(vendor: 'Intel' | 'AMD', model: string): DeviceProfile['webgl'] {
  const v = vendor === 'Intel' ? 'Google Inc. (Intel Inc.)' : 'Google Inc. (ATI Technologies Inc.)';
  const backendVendor = vendor === 'Intel' ? 'Intel Inc.' : 'ATI Technologies Inc.';
  const r = `ANGLE (${backendVendor}, ANGLE Metal Renderer: ${model}, Unspecified Version)`;
  return { vendor: v, renderer: r, unmaskedVendor: v, unmaskedRenderer: r, caps: METAL_CAPS };
}

const MACOS: OsTemplate = {
  platform: 'MacIntel',
  uaPlatform: 'macOS',
  uaPlatformVersion: '14.5.0',
  osToken: 'Macintosh; Intel Mac OS X 10_15_7',
  fonts: [...MACOS_FONT_NAMES],
  devices: [
    {
      id: 'mac-intel-iris-plus',
      webgl: macIntelGpu('Intel', 'Intel(R) Iris(TM) Plus Graphics'),
      screen: { width: 1440, height: 900, dpr: 2 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'mac-intel-uhd630',
      webgl: macIntelGpu('Intel', 'Intel(R) UHD Graphics 630'),
      screen: { width: 1680, height: 1050, dpr: 2 },
      hardwareConcurrency: 6,
      deviceMemory: 8,
    },
    {
      id: 'mac-amd-radeon-pro-5500m',
      webgl: macIntelGpu('AMD', 'AMD Radeon Pro 5500M'),
      screen: { width: 1792, height: 1120, dpr: 2 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'mac-m1',
      webgl: macGpu('M1'),
      // MacBook Air 13" (M1, 2020): 2560x1600 panel, Retina default "looks like" 1440x900.
      // NOT 1512x982 - that is the 14" MacBook Pro, which never shipped with a base M1 (only M1 Pro
      // and M1 Max). A base-M1 machine reporting a 14" panel is a pairing Apple never sold, and both
      // halves are readable together from screen.* and the WebGL renderer.
      screen: { width: 1440, height: 900, dpr: 2 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'mac-m2',
      webgl: macGpu('M2'),
      // MacBook Air 13.6" (M2, 2022): 2560x1664 panel, Retina default "looks like" 1470x956.
      // Same error as mac-m1 above: the 14" MacBook Pro took M2 Pro / M2 Max, never a base M2.
      screen: { width: 1470, height: 956, dpr: 2 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
    },
    {
      id: 'mac-m3',
      webgl: macGpu('M3'),
      // MacBook Pro 14" (M3, Oct 2023): 3024x1964 panel, Retina default "looks like" 1512x982. The
      // base M3 genuinely did ship in the 14" - unlike M1/M2 above - so this pairing is real. What
      // it must NOT be is 1728x1117: that is the 16", which only ever took M3 Pro / M3 Max.
      screen: { width: 1512, height: 982, dpr: 2 },
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
  return { vendor: v, renderer, unmaskedVendor: v, unmaskedRenderer: renderer, caps: GL_CAPS };
}

const LINUX: OsTemplate = {
  platform: 'Linux x86_64',
  uaPlatform: 'Linux',
  // Real Chrome on Linux sends Sec-CH-UA-Platform-Version as an EMPTY string, always. Chromium has
  // no Linux platform-version source: `GetUserAgentPlatformVersion()` returns "" for
  // BUILDFLAG(IS_LINUX), because a kernel release is not a platform version any site could use and
  // it would be high-entropy. A Linux persona reporting a kernel-shaped "6.8.0" is therefore a value
  // no real Chrome has ever emitted — a single `getHighEntropyValues(['platformVersion'])` call
  // unmasks it. Empty here is not "unset": the native UA-CH hook assigns platform_version straight
  // through, so an empty string is faithfully emitted rather than falling back to the host.
  uaPlatformVersion: '',
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

export interface AndroidDeviceProfile {
  /** Stable id for tests/telemetry; never surfaced to the page. */
  id: string;
  brand: string;
  manufacturer: string;
  model: string;
  /** Android build/device codename. */
  device: string;
  androidVersion: string;
  apiLevel: number;
  buildId: string;
  buildFingerprint: string;
  webgl: DeviceProfile['webgl'];
  /** CSS screen dimensions as exposed by Chrome Android, not physical pixels. */
  screen: { width: number; height: number; dpr: number };
  hardwareConcurrency: number;
  /** Spec value from the navigator.deviceMemory ladder. */
  deviceMemory: number;
  maxTouchPoints: number;
}

export interface AndroidTemplate {
  platform: string;
  uaPlatform: 'Android';
  fonts: string[];
  devices: readonly AndroidDeviceProfile[];
}

function androidGpu(vendor: 'Qualcomm' | 'ARM', model: string): DeviceProfile['webgl'] {
  const v = `Google Inc. (${vendor})`;
  const r = `ANGLE (${vendor}, ${model}, OpenGL ES 3.2)`;
  return { vendor: v, renderer: r, unmaskedVendor: v, unmaskedRenderer: r, caps: MOBILE_GLES_CAPS };
}

export const ANDROID_TEMPLATE: AndroidTemplate = {
  platform: 'Linux armv81',
  uaPlatform: 'Android',
  fonts: ['Roboto', 'Noto Sans', 'Noto Color Emoji', 'Droid Sans', 'Google Sans', 'sans-serif'],
  devices: [
    {
      id: 'pixel-8-android-14',
      brand: 'Google',
      manufacturer: 'Google',
      model: 'Pixel 8',
      device: 'shiba',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UQ1A.240205.004',
      buildFingerprint: 'google/shiba/shiba:14/UQ1A.240205.004/11269751:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G715'),
      screen: { width: 412, height: 915, dpr: 2.625 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'pixel-7-android-14',
      brand: 'Google',
      manufacturer: 'Google',
      model: 'Pixel 7',
      device: 'panther',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UQ1A.240205.002',
      buildFingerprint: 'google/panther/panther:14/UQ1A.240205.002/11269751:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G710'),
      screen: { width: 412, height: 915, dpr: 2.625 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'galaxy-s23-android-14',
      brand: 'Samsung',
      manufacturer: 'samsung',
      model: 'SM-S911B',
      device: 'dm1q',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'samsung/dm1qxx/dm1q:14/UP1A.231005.007/S911BXXS3BXAD:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 740'),
      screen: { width: 360, height: 780, dpr: 3 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'galaxy-a54-android-14',
      brand: 'Samsung',
      manufacturer: 'samsung',
      model: 'SM-A546B',
      device: 'a54x',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'samsung/a54x/a54x:14/UP1A.231005.007/A546BXXS8CXA2:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G68'),
      screen: { width: 384, height: 854, dpr: 2.8125 },
      hardwareConcurrency: 8,
      deviceMemory: 4,
      maxTouchPoints: 5,
    },
    {
      id: 'oneplus-11-android-14',
      brand: 'OnePlus',
      manufacturer: 'OnePlus',
      model: 'CPH2449',
      device: 'OP594DL1',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UKQ1.230924.001',
      buildFingerprint: 'OnePlus/CPH2449/OP594DL1:14/UKQ1.230924.001/R.1733:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 740'),
      screen: { width: 412, height: 919, dpr: 3.5 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'redmi-note-12-android-13',
      brand: 'Xiaomi',
      manufacturer: 'Xiaomi',
      model: '22111317G',
      device: 'sunstone',
      androidVersion: '13',
      apiLevel: 33,
      buildId: 'TKQ1.221114.001',
      buildFingerprint:
        'xiaomi/sunstone_global/sunstone:13/TKQ1.221114.001/V14.0.8.0.TMQMIXM:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 619'),
      screen: { width: 393, height: 873, dpr: 2.75 },
      hardwareConcurrency: 8,
      deviceMemory: 4,
      maxTouchPoints: 5,
    },
    // --- Expanded coverage. Real, coherent hardware profiles for the popular brands/tiers so any
    // selected model resolves (by exact model, then same-brand match in android.ts) to a REAL GPU and a
    // plausible screen for its class instead of a random unrelated template. GPUs are the exact silicon
    // those devices ship (Adreno = Qualcomm, Mali = ARM); screens are the device's / its tier's real CSS
    // geometry. When a catalog model is selected its exact model/codename drive the UA + build id; these
    // templates supply only screen / GPU / RAM / cores. ---
    {
      id: 'pixel-9-android-14',
      brand: 'Google',
      manufacturer: 'Google',
      model: 'Pixel 9',
      device: 'tokay',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'AD1A.240530.047',
      buildFingerprint: 'google/tokay/tokay:14/AD1A.240530.047/12150698:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G715'),
      // 412x924 is the Pixel 9's own panel. This carried 412x915 - the Pixel 8's - so a persona
      // naming a Pixel 9 in Sec-CH-UA-Model reported the previous generation's screen beside it.
      // Chromium's device list has both: EmulatedDevices.ts 'Pixel 9' is 412x924 and 'Pixel 8' is
      // 412x915, each at deviceScaleFactor 2.625.
      screen: { width: 412, height: 924, dpr: 2.625 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'pixel-6-android-14',
      brand: 'Google',
      manufacturer: 'Google',
      model: 'Pixel 6',
      device: 'oriole',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'google/oriole/oriole:14/UP1A.231005.007/10754064:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G78'),
      screen: { width: 393, height: 873, dpr: 2.75 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'galaxy-s24-android-14',
      brand: 'Samsung',
      manufacturer: 'samsung',
      model: 'SM-S921B',
      device: 'e1q',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'samsung/e1qxxx/e1q:14/UP1A.231005.007/S921BXXU4AXK4:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 750'),
      screen: { width: 360, height: 780, dpr: 3 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'galaxy-s22-android-14',
      brand: 'Samsung',
      manufacturer: 'samsung',
      model: 'SM-S901B',
      device: 'r0q',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'samsung/r0qxxx/r0q:14/UP1A.231005.007/S901BXXS6DXA1:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 730'),
      screen: { width: 360, height: 780, dpr: 3 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'galaxy-s21-android-14',
      brand: 'Samsung',
      manufacturer: 'samsung',
      model: 'SM-G991B',
      device: 'o1s',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'samsung/o1sxxx/o1s:14/UP1A.231005.007/G991BXXS9EXA1:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 660'),
      screen: { width: 384, height: 854, dpr: 2.8125 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'galaxy-a34-android-14',
      brand: 'Samsung',
      manufacturer: 'samsung',
      model: 'SM-A346B',
      device: 'a34x',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'samsung/a34xxx/a34x:14/UP1A.231005.007/A346BXXS5BXA1:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G68'),
      screen: { width: 384, height: 832, dpr: 2.8125 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'galaxy-a14-android-14',
      brand: 'Samsung',
      manufacturer: 'samsung',
      model: 'SM-A145F',
      device: 'a14',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UP1A.231005.007',
      buildFingerprint: 'samsung/a14xx/a14:14/UP1A.231005.007/A145FXXU5CXA1:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G57'),
      screen: { width: 393, height: 873, dpr: 2.75 },
      hardwareConcurrency: 8,
      deviceMemory: 4,
      maxTouchPoints: 5,
    },
    {
      id: 'xiaomi-13-android-14',
      brand: 'Xiaomi',
      manufacturer: 'Xiaomi',
      model: '2211133G',
      device: 'fuxi',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'UKQ1.230804.001',
      buildFingerprint: 'Xiaomi/fuxi/fuxi:14/UKQ1.230804.001/V816.0.6.0:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 740'),
      screen: { width: 393, height: 873, dpr: 2.75 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'motorola-edge-40-android-14',
      brand: 'Motorola',
      manufacturer: 'motorola',
      model: 'motorola edge 40',
      device: 'lyriq',
      androidVersion: '14',
      apiLevel: 34,
      buildId: 'U1TC34.66-96',
      buildFingerprint: 'motorola/lyriq_g/lyriq:14/U1TC34.66-96/abcd:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G68'),
      screen: { width: 393, height: 873, dpr: 2.75 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'oppo-reno8-android-13',
      brand: 'Oppo',
      manufacturer: 'OPPO',
      model: 'CPH2359',
      device: 'OP4F0FL1',
      androidVersion: '13',
      apiLevel: 33,
      buildId: 'TP1A.220905.001',
      buildFingerprint: 'OPPO/CPH2359/OP4F0FL1:13/TP1A.220905.001/R.abcd:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G77 MC9'),
      screen: { width: 360, height: 804, dpr: 3 },
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 5,
    },
    {
      id: 'vivo-y35-android-13',
      brand: 'Vivo',
      manufacturer: 'vivo',
      model: 'V2205',
      device: 'V2205',
      androidVersion: '13',
      apiLevel: 33,
      buildId: 'TP1A.220624.014',
      buildFingerprint: 'vivo/V2205/V2205:13/TP1A.220624.014/compiler12:user/release-keys',
      webgl: androidGpu('Qualcomm', 'Adreno (TM) 619'),
      screen: { width: 392, height: 873, dpr: 2.75 },
      hardwareConcurrency: 8,
      deviceMemory: 4,
      maxTouchPoints: 5,
    },
    {
      id: 'realme-c55-android-13',
      brand: 'realme',
      manufacturer: 'realme',
      model: 'RMX3710',
      device: 'RE58B2L1',
      androidVersion: '13',
      apiLevel: 33,
      buildId: 'TP1A.220905.001',
      buildFingerprint: 'realme/RMX3710/RE58B2L1:13/TP1A.220905.001/R.abcd:user/release-keys',
      webgl: androidGpu('ARM', 'Mali-G57 MC2'),
      screen: { width: 360, height: 800, dpr: 3 },
      hardwareConcurrency: 8,
      deviceMemory: 4,
      maxTouchPoints: 5,
    },
  ],
};

/**
 * The Chrome version the catalog advertises. It MUST equal the actually-launched engine's version:
 * a detector that feature-detects the engine — or simply reads `getHighEntropyValues(['fullVersionList'])`,
 * which returns the REAL build the CDP UA override does not mask — catches any mismatch as a lie. (This
 * was a real tell: a persona claiming Chrome 151 leaked `Chromium 152.0.7928.0` via fullVersionList.)
 *
 * So we pin to the running engine (Lobium = 152.0.7977.42) rather than a diverse pool — every profile
 * runs the SAME binary, so they must all claim ITS version; cross-profile version diversity would be a
 * lie the moment a detector feature-probes the engine. Chrome caps `navigator.userAgent` at
 * `major.0.0.0` (UA reduction), while the high-entropy `uaFullVersion` / `fullVersionList` carry the
 * full build — so we track both forms.
 *
 * The build MUST additionally be one Google actually RELEASED. The pin was previously 152.0.7928.0, a
 * canary nightly: numerically ahead of stable, but a build essentially no real user runs, so
 * `fullVersionList` returned a near-unique string and the `.0` patch component advertised it as a
 * branch-point build rather than a release. Population matters as much as freshness here — see
 * `scripts/track-upstream.mjs`, which now verifies channel membership and refuses an unreleased pin.
 *
 * Keep this in lockstep with `lobium/build.sh` CHROMIUM_REF and the engine manifest; the coherence test
 * in `ci/validation/version-coherence.test.mjs` fails the build if they drift.
 *
 * `deriveFingerprint({ browserVersion })` overrides this when the sidecar knows a different engine build.
 */
export const ENGINE_CHROME = {
  major: '152',
  /** navigator.userAgent form (UA-reduced to major.0.0.0). */
  reduced: '152.0.0.0',
  /** getHighEntropyValues(['uaFullVersion'|'fullVersionList']) form (real build). */
  full: '152.0.7977.42',
} as const;

/** Split a full Chrome build (e.g. "152.0.7977.42") into the UA-reduced + major forms it must present. */
export function chromeVersionForms(full: string): { major: string; reduced: string; full: string } {
  const major = full.split('.')[0] ?? ENGINE_CHROME.major;
  return { major, reduced: `${major}.0.0.0`, full };
}

/**
 * Build the Sec-CH-UA brand list EXACTLY as Chromium does.
 *
 * This is not a free-form list. Chromium derives all three entries — including the "GREASE" decoy
 * brand and the ORDER they appear in — deterministically from a single seed, and that seed is the UA
 * major version (`version_info::GetMajorVersionNumber()`), so the output changes every release.
 * Verified against `components/embedder_support/user_agent_utils.cc` at tag 152.0.7977.42:
 *
 *   greasey_chars      = {" ","(",":","-",".","/",")",";","=","?","_"}          (line 554)
 *   greasey_brand      = "Not" + chars[seed%11] + "A" + chars[(seed+1)%11] + "Brand"   (559-561)
 *   greasey_version    = {"8","99","24"}[seed%3]                                (556, 562)
 *   orders             = {{0,1,2},{0,2,1},{1,0,2},{1,2,0},{2,0,1},{2,1,0}}      (246-247)
 *   ShuffleBrandList   : shuffled[order[i]] = list[i], list = [GREASE, Chromium, Google Chrome] (265-278)
 *
 * The previous hardcoded `[Chromium, Google Chrome, Not_A Brand]` was wrong on TWO counts for Chrome
 * 152: the decoy token (`Not_A Brand` — that is the M131 spelling) and its position. Sec-CH-UA is a
 * LOW-ENTROPY hint, so it rides every single HTTP request including worker fetches; any edge that keeps
 * a Chrome-major → expected-brand-string table sees a token no Chrome 152 has ever emitted. It is the
 * cheapest possible UA-CH cross-check and it fired on every profile.
 *
 * `major` must be the UA major as a decimal string; anything else throws rather than silently emitting
 * a brand list that does not correspond to any real Chrome.
 */
const GREASE_CHARS = [' ', '(', ':', '-', '.', '/', ')', ';', '=', '?', '_'] as const;
const GREASE_VERSIONS = ['8', '99', '24'] as const;
const GREASE_ORDERS = [
  [0, 1, 2],
  [0, 2, 1],
  [1, 0, 2],
  [1, 2, 0],
  [2, 0, 1],
  [2, 1, 0],
] as const;

export interface ChromeBrandOptions {
  /**
   * `true` (default) emits the Google-Chrome-branded three-entry list a Chrome build sends.
   * `false` emits the two-entry list an UNBRANDED Chromium build sends — Chromium's own
   * `GenerateBrandVersionList` takes the product brand as an optional, and with it absent the list is
   * just [GREASE, Chromium], shuffled by `GetRandomOrder(seed, 2)` = `{seed%2, (seed+1)%2}`.
   * Both shapes are legitimate; only a list that matches NEITHER is impossible.
   */
  branded?: boolean;
}

export function buildChromeBrands(
  major: string,
  opts: ChromeBrandOptions = {},
): Array<{ brand: string; version: string }> {
  // Validate the STRING shape, not just Number(major): `Number('')` is 0, which is a perfectly good
  // non-negative integer, so an empty major would have produced a brand list whose real entries carry
  // version "" — an impossible header emitted with no error at all.
  if (!/^\d+$/.test(major)) {
    throw new Error(`buildChromeBrands: invalid Chrome major version ${JSON.stringify(major)}`);
  }
  const branded = opts.branded !== false;
  const seed = Number(major);
  const greaseBrand = `Not${GREASE_CHARS[seed % GREASE_CHARS.length]}A${
    GREASE_CHARS[(seed + 1) % GREASE_CHARS.length]
  }Brand`;
  // Source order is always [GREASE, Chromium, <brand>?]; the shuffle then scatters it.
  const source = [
    { brand: greaseBrand, version: GREASE_VERSIONS[seed % GREASE_VERSIONS.length] as string },
    { brand: 'Chromium', version: major },
    ...(branded ? [{ brand: 'Google Chrome', version: major }] : []),
  ];
  const order: readonly number[] = branded
    ? (GREASE_ORDERS[seed % GREASE_ORDERS.length] as readonly number[])
    : [seed % 2, (seed + 1) % 2];
  const shuffled: Array<{ brand: string; version: string }> = new Array(source.length);
  order.forEach((position, index) => {
    shuffled[position] = source[index] as { brand: string; version: string };
  });
  return shuffled;
}

/** Canonical `"brand";v="version", …` rendering, used for exact brand-list comparison. */
export function renderChromeBrands(
  list: ReadonlyArray<{ brand: string; version: string }>,
): string {
  return list.map((b) => `"${b.brand}";v="${b.version}"`).join(', ');
}
