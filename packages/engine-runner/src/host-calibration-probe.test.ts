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
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.7928.0 Safari/537.36',
      platform: 'Linux x86_64',
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

test('normalizeHostCalibrationSnapshot produces a host profile with sorted unique arrays', () => {
  const profile = normalizeHostCalibrationSnapshot(rawSnapshot(), {
    os: 'linux',
    arch: 'x86_64',
  });

  assert.equal(profile.version, 1);
  assert.equal(profile.os, 'linux');
  assert.equal(profile.arch, 'x86_64');
  assert.equal(profile.browserVersion, '152.0.7928.0');
  assert.deepEqual(profile.fonts, ['DejaVu Sans', 'Noto Sans']);
  assert.deepEqual(profile.webgl.extensions, [
    'ANGLE_instanced_arrays',
    'WEBGL_debug_renderer_info',
  ]);
  assert.deepEqual(profile.webgl.caps?.maxViewportDims, [16384, 16384]);
  assert.deepEqual(profile.warnings, ['queryLocalFonts unavailable']);
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
