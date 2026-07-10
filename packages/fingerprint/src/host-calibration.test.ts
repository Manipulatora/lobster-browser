import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostCalibrationProfile, WebGlShaderPrecisionProfile } from '@lobster/shared-types';
import {
  deriveFingerprintFromHost,
  validateFingerprintCoherence,
  validateHostCalibrationProfile,
} from './index.js';

const precision: WebGlShaderPrecisionProfile = {
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
};

function host(): HostCalibrationProfile {
  return {
    version: 1,
    capturedAt: '2026-07-08T12:00:00.000Z',
    os: 'linux',
    arch: 'x86_64',
    browserVersion: '152.0.7928.0',
    navigator: {
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
      extensions: ['ANGLE_instanced_arrays', 'EXT_texture_filter_anisotropic', 'WEBGL_debug_renderer_info'],
      shaderPrecision: precision,
    },
    fonts: ['Noto Sans', 'DejaVu Sans', 'Liberation Sans', 'Noto Sans'],
    timezone: 'Europe/Berlin',
  };
}

test('deriveFingerprintFromHost inherits captured host hardware while keeping Chrome-safe surfaces', () => {
  const fp = deriveFingerprintFromHost('host-seed-a', host(), { engine: 'lobium' });

  assert.equal(fp.os, 'linux');
  assert.equal(fp.arch, 'x86_64');
  assert.equal(fp.navigator.platform, 'Linux x86_64');
  assert.equal(fp.navigator.hardwareConcurrency, 12);
  assert.equal(fp.navigator.deviceMemory, 8, 'navigator.deviceMemory is spec-capped at 8');
  assert.equal(fp.webgl.renderer, host().webgl.renderer);
  assert.deepEqual(fp.webgl.extensions, host().webgl.extensions);
  assert.deepEqual(fp.webgl.shaderPrecision, precision);
  assert.deepEqual(fp.fonts, ['DejaVu Sans', 'Liberation Sans', 'Noto Sans']);
  assert.match(fp.navigator.userAgent, /Chrome\/152\.0\.0\.0/);
  assert.equal(fp.navigator.uaFullVersion, '152.0.7928.0');
  assert.deepEqual(validateFingerprintCoherence(fp), []);
});

test('deriveFingerprintFromHost is deterministic per seed and host snapshot', () => {
  const h = host();
  const a = deriveFingerprintFromHost('same-seed', h, { engine: 'lobium' });
  const b = deriveFingerprintFromHost('same-seed', h, { engine: 'lobium' });
  assert.deepEqual(a, b);
});

test('validateHostCalibrationProfile rejects software-rendered hosts', () => {
  const h = host();
  h.webgl.vendor = 'Mesa';
  h.webgl.renderer = 'llvmpipe (LLVM 20.1.2, 256 bits)';
  const issues = validateHostCalibrationProfile(h);
  assert.ok(issues.some((issue) => issue.includes('software renderer')));
});
