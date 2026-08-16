import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostCalibrationRawSnapshot, HostProbePage } from './lib.js';
import {
  buildHostCalibrationProbeScript,
  normalizeHostCalibrationSnapshot,
  probeHostCalibration,
} from './lib.js';

function rawSnapshot(): HostCalibrationRawSnapshot {
  return {
    capturedAt: '2026-07-08T12:00:00.000Z',
    navigator: {
      userAgent:
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7977.42 Safari/537.36',
      platform: 'Linux x86_64',
      languages: ['de-DE', 'de', 'de-DE'],
      locale: 'de-DE',
      hardwareConcurrency: 12,
      deviceMemory: 64,
      maxTouchPoints: 0,
    },
    screen: {
      width: 2560,
      height: 1440,
      availWidth: 2560,
      availHeight: 1400,
      availLeft: 0,
      availTop: 0,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6.0)',
      unmaskedVendor: 'Google Inc. (NVIDIA)',
      unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060/PCIe/SSE2, OpenGL 4.6.0)',
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      extensions: ['WEBGL_debug_renderer_info', 'ANGLE_instanced_arrays', 'ANGLE_instanced_arrays'],
      caps: {
        maxTextureSize: 16384,
        maxCubeMapTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDims: [16384, 16384],
        maxVertexAttribs: 16,
        maxVertexUniformVectors: 4096,
        maxFragmentUniformVectors: 1024,
        maxVaryingVectors: 31,
        maxTextureImageUnits: 16,
        maxVertexTextureImageUnits: 16,
        maxCombinedTextureImageUnits: 32,
        aliasedLineWidthRange: [1, 1],
        aliasedPointSizeRange: [1, 2047],
      },
      shaderPrecision: {
        vertex: {
          lowFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
          mediumFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
          highFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
          lowInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
          mediumInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
          highInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
        },
        fragment: {
          lowFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
          mediumFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
          highFloat: { rangeMin: 127, rangeMax: 127, precision: 23 },
          lowInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
          mediumInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
          highInt: { rangeMin: 31, rangeMax: 30, precision: 0 },
        },
      },
    },
    fonts: ['Noto Sans', 'DejaVu Sans', 'Noto Sans'],
    timezone: 'Europe/Berlin',
    warnings: ['queryLocalFonts unavailable', 'queryLocalFonts unavailable'],
  };
}

test('buildHostCalibrationProbeScript captures WebGL depth and local-font hooks', () => {
  const script = buildHostCalibrationProbeScript();

  assert.match(script, /getSupportedExtensions/);
  assert.match(script, /getShaderPrecisionFormat/);
  assert.match(script, /WEBGL_debug_renderer_info/);
  assert.match(script, /queryLocalFonts/);
  assert.match(script, /userAgentData/);
  assert.match(script, /Intl\.DateTimeFormat/);
});

test('normalizeHostCalibrationSnapshot produces a host profile with de-duplicated arrays', () => {
  const profile = normalizeHostCalibrationSnapshot(rawSnapshot(), {
    os: 'linux',
    arch: 'x86_64',
  });

  assert.equal(profile.version, 1);
  assert.equal(profile.os, 'linux');
  assert.equal(profile.arch, 'x86_64');
  assert.equal(profile.browserVersion, '152.0.7977.42');
  assert.deepEqual(profile.navigator.languages, ['de-DE', 'de']);
  assert.equal(profile.navigator.locale, 'de-DE');
  assert.deepEqual(profile.fonts, ['DejaVu Sans', 'Noto Sans']);
  // De-duplicated but NOT sorted: the captured order is the host's registration order, which is
  // what a real getSupportedExtensions() returns. See the dedicated test below.
  assert.deepEqual(profile.webgl.extensions, [
    'WEBGL_debug_renderer_info',
    'ANGLE_instanced_arrays',
  ]);
  assert.deepEqual(profile.webgl.caps?.maxViewportDims, [16384, 16384]);
  assert.deepEqual(profile.warnings, ['queryLocalFonts unavailable']);
});

test('the WebGL extension list keeps registration order and is never alphabetised', () => {
  // getSupportedExtensions() returns extensions in REGISTRATION order, a fixed property of the
  // build and driver - on real Chrome EXT_sRGB follows the EXT_texture_* block, and the WEBGL_*
  // entries are grouped, not interleaved alphabetically. Sorting the captured list does not hide
  // the host: it replaces the host's order with a perfectly alphabetised one that NO real Chrome
  // ever emits, which is a stronger tell than the order it was trying to conceal. This test exists
  // because the normalizer used to call a uniqSorted() helper here.
  const raw = rawSnapshot();
  // A realistic Chrome-on-NVIDIA prefix, deliberately not in alphabetical order, with a duplicate.
  raw.webgl.extensions = [
    'ANGLE_instanced_arrays',
    'EXT_blend_minmax',
    'EXT_clip_control',
    'EXT_color_buffer_half_float',
    'EXT_texture_compression_bptc',
    'EXT_texture_compression_rgtc',
    'EXT_texture_filter_anisotropic',
    'EXT_sRGB',
    'OES_element_index_uint',
    'WEBGL_debug_renderer_info',
    'WEBGL_compressed_texture_s3tc',
    'EXT_blend_minmax',
  ];

  const profile = normalizeHostCalibrationSnapshot(raw, {
    os: 'linux',
    arch: 'x86_64',
    capturedAt: '2026-07-08T12:00:00.000Z',
  });

  assert.deepEqual(profile.webgl.extensions, [
    'ANGLE_instanced_arrays',
    'EXT_blend_minmax',
    'EXT_clip_control',
    'EXT_color_buffer_half_float',
    'EXT_texture_compression_bptc',
    'EXT_texture_compression_rgtc',
    'EXT_texture_filter_anisotropic',
    'EXT_sRGB',
    'OES_element_index_uint',
    'WEBGL_debug_renderer_info',
    'WEBGL_compressed_texture_s3tc',
  ]);

  const got = profile.webgl.extensions ?? [];
  const alphabetical = [...got].sort((a, b) => a.localeCompare(b));
  assert.notDeepEqual(got, alphabetical, 'the list must not come out alphabetised');
  assert.equal(new Set(got).size, got.length, 'duplicates must still be removed');
});

test('probeHostCalibration evaluates the probe script and normalizes the result', async () => {
  let evaluated = '';
  const page: HostProbePage = {
    async evaluate<T>(expression: string): Promise<T> {
      evaluated = expression;
      return rawSnapshot() as T;
    },
  };

  const profile = await probeHostCalibration(page, {
    os: 'linux',
    arch: 'x86_64',
    capturedAt: '2026-07-08T12:30:00.000Z',
  });

  assert.match(evaluated, /WebGL unavailable for host calibration/);
  assert.equal(profile.capturedAt, '2026-07-08T12:30:00.000Z');
  assert.equal(profile.navigator.platform, 'Linux x86_64');
  assert.equal(profile.timezone, 'Europe/Berlin');
});
