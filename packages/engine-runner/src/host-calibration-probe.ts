import type {
  CpuArch,
  HostCalibrationProfile,
  OsFamily,
  ScreenFingerprint,
  WebGlCaps,
  WebGlFingerprint,
  WebGlShaderPrecisionProfile,
} from '@lobster/shared-types';

export interface HostCalibrationRawNavigator {
  userAgent: string;
  platform: string;
  languages?: string[];
  locale?: string;
  hardwareConcurrency: number;
  deviceMemory?: number;
  maxTouchPoints: number;
}

export interface HostCalibrationRawSnapshot {
  capturedAt?: string;
  browserVersion?: string;
  navigator: HostCalibrationRawNavigator;
  screen: ScreenFingerprint;
  webgl: WebGlFingerprint;
  fonts: string[];
  timezone?: string;
  warnings?: string[];
}

export interface NormalizeHostCalibrationOptions {
  os: OsFamily;
  arch: CpuArch;
  capturedAt?: string;
}

export interface HostProbePage {
  evaluate<T>(expression: string): Promise<T>;
}

function chromeVersionFromUserAgent(ua: string): string | undefined {
  return /Chrome\/([0-9.]+)/.exec(ua)?.[1];
}

function uniqSorted(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b),
  );
}

/**
 * De-duplicate while preserving the order the values arrived in.
 *
 * Required for `WebGLRenderingContext.getSupportedExtensions()`. Chrome returns extensions in
 * REGISTRATION order, which is a fixed property of the build and of the driver, not alphabetical:
 * on a real Chrome, `EXT_sRGB` follows the `EXT_texture_*` block, `WEBGL_debug_renderer_info` sits
 * among the other WEBGL_* entries, and so on. Sorting the list therefore replaces one host
 * fingerprint with a different, *impossible* one — every Lobium profile would return a perfectly
 * alphabetised array that no real Chrome ever produces, which is a stronger signal than the host
 * order it was trying to hide. Capture and replay the order verbatim.
 */
function uniqPreservingOrder(values: readonly string[]): string[] {
  return [...new Set(values.map((v) => v.trim()).filter(Boolean))];
}

function cloneCaps(caps: WebGlCaps | undefined): WebGlCaps | undefined {
  return caps
    ? {
        ...caps,
        maxViewportDims: [...caps.maxViewportDims] as [number, number],
        aliasedLineWidthRange: [...caps.aliasedLineWidthRange] as [number, number],
        aliasedPointSizeRange: [...caps.aliasedPointSizeRange] as [number, number],
      }
    : undefined;
}

function clonePrecision(
  precision: WebGlShaderPrecisionProfile | undefined,
): WebGlShaderPrecisionProfile | undefined {
  return precision
    ? {
        vertex: { ...precision.vertex },
        fragment: { ...precision.fragment },
      }
    : undefined;
}

function normalizeWebgl(webgl: WebGlFingerprint): WebGlFingerprint {
  const normalized: WebGlFingerprint = {
    vendor: webgl.vendor,
    renderer: webgl.renderer,
    unmaskedVendor: webgl.unmaskedVendor,
    unmaskedRenderer: webgl.unmaskedRenderer,
  };
  const caps = cloneCaps(webgl.caps);
  if (caps) normalized.caps = caps;
  if (webgl.version) normalized.version = webgl.version;
  if (webgl.shadingLanguageVersion) {
    normalized.shadingLanguageVersion = webgl.shadingLanguageVersion;
  }
  // Registration order, not alphabetical — see uniqPreservingOrder.
  if (webgl.extensions) normalized.extensions = uniqPreservingOrder(webgl.extensions);
  const precision = clonePrecision(webgl.shaderPrecision);
  if (precision) normalized.shaderPrecision = precision;
  return normalized;
}

export function normalizeHostCalibrationSnapshot(
  raw: HostCalibrationRawSnapshot,
  opts: NormalizeHostCalibrationOptions,
): HostCalibrationProfile {
  const warnings = uniqSorted(raw.warnings ?? []);
  const browserVersion = raw.browserVersion ?? chromeVersionFromUserAgent(raw.navigator.userAgent);
  const profile: HostCalibrationProfile = {
    version: 1,
    capturedAt: opts.capturedAt ?? raw.capturedAt ?? new Date().toISOString(),
    os: opts.os,
    arch: opts.arch,
    navigator: {
      platform: raw.navigator.platform,
      ...(raw.navigator.languages && raw.navigator.languages.length > 0
        ? {
            languages: [
              ...new Set(
                raw.navigator.languages.map((language) => language.trim()).filter(Boolean),
              ),
            ],
          }
        : {}),
      ...(raw.navigator.locale ? { locale: raw.navigator.locale } : {}),
      hardwareConcurrency: raw.navigator.hardwareConcurrency,
      deviceMemory: raw.navigator.deviceMemory ?? 8,
      maxTouchPoints: raw.navigator.maxTouchPoints,
    },
    screen: { ...raw.screen },
    webgl: normalizeWebgl(raw.webgl),
    fonts: uniqSorted(raw.fonts),
  };
  if (browserVersion) profile.browserVersion = browserVersion;
  if (raw.timezone) profile.timezone = raw.timezone;
  if (warnings.length > 0) profile.warnings = warnings;
  return profile;
}

/**
 * Browser-side host probe. It intentionally reads the unspoofed page-visible host surfaces; callers run
 * it before applying a persona. Real-GPU correctness depends on where this script runs, but the script
 * itself is hardware-agnostic and unit-testable.
 */
export function buildHostCalibrationProbeScript(): string {
  return String.raw`(async () => {
  const warnings = [];
  const safe = (fn, fallback, label) => {
    try { return fn(); } catch (e) { warnings.push(label + ': ' + String(e && e.message ? e.message : e)); return fallback; }
  };
  const numberParam = (gl, p, fallback = 0) => {
    const value = safe(() => gl.getParameter(p), fallback, 'webgl.getParameter');
    return Number.isFinite(Number(value)) ? Number(value) : fallback;
  };
  const tupleParam = (gl, p, fallback) => {
    const value = safe(() => gl.getParameter(p), fallback, 'webgl.getParameter');
    return Array.from(value || fallback).map((n) => Number(n));
  };
  const precision = (gl, shader, p) => {
    const value = safe(() => gl.getShaderPrecisionFormat(shader, p), null, 'webgl.getShaderPrecisionFormat');
    return value ? { rangeMin: value.rangeMin, rangeMax: value.rangeMax, precision: value.precision } : { rangeMin: 0, rangeMax: 0, precision: 0 };
  };
  const canvas = document.createElement('canvas');
  const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
  if (!gl) throw new Error('WebGL unavailable for host calibration');
  const dbg = safe(() => gl.getExtension('WEBGL_debug_renderer_info'), null, 'WEBGL_debug_renderer_info');
  const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
  const renderer = dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  const extensions = safe(() => gl.getSupportedExtensions() || [], [], 'webgl.getSupportedExtensions');
  const fonts = [];
  if ('queryLocalFonts' in globalThis) {
    try {
      const localFonts = await globalThis.queryLocalFonts();
      for (const font of localFonts) if (font && font.family) fonts.push(font.family);
    } catch (e) {
      warnings.push('queryLocalFonts: ' + String(e && e.message ? e.message : e));
    }
  } else {
    warnings.push('queryLocalFonts unavailable');
  }
  let browserVersion;
  const uaData = navigator.userAgentData;
  if (uaData && uaData.getHighEntropyValues) {
    try {
      const high = await uaData.getHighEntropyValues(['fullVersionList', 'uaFullVersion']);
      browserVersion = high.uaFullVersion || (high.fullVersionList || []).find((b) => b.brand === 'Chromium' || b.brand === 'Google Chrome')?.version;
    } catch (e) {
      warnings.push('userAgentData high entropy: ' + String(e && e.message ? e.message : e));
    }
  }
  if (!browserVersion) browserVersion = /Chrome\/([0-9.]+)/.exec(navigator.userAgent)?.[1];
  return {
    capturedAt: new Date().toISOString(),
    browserVersion,
    navigator: {
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      languages: Array.from(navigator.languages || []),
      locale: Intl.DateTimeFormat().resolvedOptions().locale,
      hardwareConcurrency: navigator.hardwareConcurrency || 1,
      deviceMemory: navigator.deviceMemory,
      maxTouchPoints: navigator.maxTouchPoints || 0,
    },
    screen: {
      width: screen.width,
      height: screen.height,
      availWidth: screen.availWidth,
      availHeight: screen.availHeight,
      availLeft: screen.availLeft || 0,
      availTop: screen.availTop || 0,
      colorDepth: screen.colorDepth,
      devicePixelRatio: window.devicePixelRatio || 1,
    },
    webgl: {
      vendor: String(vendor || ''),
      renderer: String(renderer || ''),
      unmaskedVendor: String(vendor || ''),
      unmaskedRenderer: String(renderer || ''),
      version: String(gl.getParameter(gl.VERSION) || ''),
      shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || ''),
      extensions,
      caps: {
        maxTextureSize: numberParam(gl, gl.MAX_TEXTURE_SIZE),
        maxCubeMapTextureSize: numberParam(gl, gl.MAX_CUBE_MAP_TEXTURE_SIZE),
        maxRenderbufferSize: numberParam(gl, gl.MAX_RENDERBUFFER_SIZE),
        maxViewportDims: tupleParam(gl, gl.MAX_VIEWPORT_DIMS, [0, 0]),
        maxVertexAttribs: numberParam(gl, gl.MAX_VERTEX_ATTRIBS),
        maxVertexUniformVectors: numberParam(gl, gl.MAX_VERTEX_UNIFORM_VECTORS),
        maxFragmentUniformVectors: numberParam(gl, gl.MAX_FRAGMENT_UNIFORM_VECTORS),
        maxVaryingVectors: numberParam(gl, gl.MAX_VARYING_VECTORS),
        maxTextureImageUnits: numberParam(gl, gl.MAX_TEXTURE_IMAGE_UNITS),
        maxVertexTextureImageUnits: numberParam(gl, gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
        maxCombinedTextureImageUnits: numberParam(gl, gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
        aliasedLineWidthRange: tupleParam(gl, gl.ALIASED_LINE_WIDTH_RANGE, [1, 1]),
        aliasedPointSizeRange: tupleParam(gl, gl.ALIASED_POINT_SIZE_RANGE, [1, 1]),
      },
      shaderPrecision: {
        vertex: {
          lowFloat: precision(gl, gl.VERTEX_SHADER, gl.LOW_FLOAT),
          mediumFloat: precision(gl, gl.VERTEX_SHADER, gl.MEDIUM_FLOAT),
          highFloat: precision(gl, gl.VERTEX_SHADER, gl.HIGH_FLOAT),
          lowInt: precision(gl, gl.VERTEX_SHADER, gl.LOW_INT),
          mediumInt: precision(gl, gl.VERTEX_SHADER, gl.MEDIUM_INT),
          highInt: precision(gl, gl.VERTEX_SHADER, gl.HIGH_INT),
        },
        fragment: {
          lowFloat: precision(gl, gl.FRAGMENT_SHADER, gl.LOW_FLOAT),
          mediumFloat: precision(gl, gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT),
          highFloat: precision(gl, gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
          lowInt: precision(gl, gl.FRAGMENT_SHADER, gl.LOW_INT),
          mediumInt: precision(gl, gl.FRAGMENT_SHADER, gl.MEDIUM_INT),
          highInt: precision(gl, gl.FRAGMENT_SHADER, gl.HIGH_INT),
        },
      },
    },
    fonts,
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    warnings,
  };
})()`;
}

export async function probeHostCalibration(
  page: HostProbePage,
  opts: NormalizeHostCalibrationOptions,
): Promise<HostCalibrationProfile> {
  const raw = await page.evaluate<HostCalibrationRawSnapshot>(buildHostCalibrationProbeScript());
  return normalizeHostCalibrationSnapshot(raw, opts);
}
