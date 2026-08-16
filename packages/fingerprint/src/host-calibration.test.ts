import assert from 'node:assert/strict';
import test from 'node:test';
import type { HostCalibrationProfile, WebGlShaderPrecisionProfile } from '@lobster/shared-types';
import {
  deriveFingerprintFromHost,
  normalizeHostWebglIdentity,
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
    browserVersion: '152.0.7977.42',
    navigator: {
      platform: 'Linux x86_64',
      languages: ['de-DE', 'de', 'en-US'],
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
      extensions: [
        'ANGLE_instanced_arrays',
        'EXT_texture_filter_anisotropic',
        'WEBGL_debug_renderer_info',
      ],
      caps: {
        maxTextureSize: 16384,
        maxCubeMapTextureSize: 16384,
        maxRenderbufferSize: 16384,
        maxViewportDims: [16384, 16384],
        maxVertexAttribs: 16,
        maxVertexUniformVectors: 4096,
        maxFragmentUniformVectors: 1024,
        maxVaryingVectors: 30,
        maxTextureImageUnits: 16,
        maxVertexTextureImageUnits: 16,
        maxCombinedTextureImageUnits: 32,
        aliasedLineWidthRange: [1, 1],
        aliasedPointSizeRange: [1, 1024],
      },
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
  assert.deepEqual(fp.navigator.languages, ['de-DE', 'de', 'en-US']);
  assert.equal(fp.locale.locale, 'de-DE');
  assert.equal(fp.locale.timezone, 'Europe/Berlin');
  assert.equal(fp.locale.acceptLanguage, 'de-DE,de;q=0.9,en-US;q=0.8');
  assert.equal(fp.navigator.hardwareConcurrency, 12);
  assert.equal(fp.navigator.deviceMemory, 8, 'navigator.deviceMemory is spec-capped at 8');
  assert.equal(fp.webgl.renderer, host().webgl.renderer);
  assert.deepEqual(fp.webgl.extensions, host().webgl.extensions);
  assert.deepEqual(fp.webgl.shaderPrecision, precision);
  assert.deepEqual(fp.fonts, ['DejaVu Sans', 'Liberation Sans', 'Noto Sans']);
  assert.match(fp.navigator.userAgent, /Chrome\/152\.0\.0\.0/);
  assert.equal(fp.navigator.uaFullVersion, '152.0.7977.42');
  assert.deepEqual(validateFingerprintCoherence(fp), []);
});

test('deriveFingerprintFromHost is deterministic per seed and host snapshot', () => {
  const h = host();
  const a = deriveFingerprintFromHost('same-seed', h, { engine: 'lobium' });
  const b = deriveFingerprintFromHost('same-seed', h, { engine: 'lobium' });
  assert.deepEqual(a, b);
});

test('normalized host renderer removes formatting noise without changing captured depth', () => {
  const source = host().webgl;
  source.renderer = `  ${source.renderer}   `;
  source.unmaskedRenderer = `${source.unmaskedRenderer}\0`;
  const normalized = normalizeHostWebglIdentity(source);
  assert.equal(normalized.renderer, source.renderer.trim());
  assert.equal(normalized.unmaskedRenderer.includes('\0'), false);
  assert.deepEqual(normalized.extensions, source.extensions);
  assert.deepEqual(normalized.caps, source.caps);
  assert.deepEqual(normalized.shaderPrecision, source.shaderPrecision);
});

test('validateHostCalibrationProfile rejects software-rendered hosts', () => {
  const h = host();
  h.webgl.vendor = 'Mesa';
  h.webgl.renderer = 'llvmpipe (LLVM 20.1.2, 256 bits)';
  const issues = validateHostCalibrationProfile(h);
  assert.ok(issues.some((issue) => issue.includes('software renderer')));
});

test('software-rendered calibration can be admitted only for explicit provisional runs', () => {
  const h = host();
  h.webgl.vendor = 'Mesa';
  h.webgl.renderer = 'llvmpipe (LLVM 20.1.2, 256 bits)';
  const issues = validateHostCalibrationProfile(h, { allowSoftwareRenderer: true });
  assert.ok(!issues.some((issue) => /software renderer|llvmpipe/i.test(issue)));
});

test('Linux host calibration accepts a top panel in the real available screen rect', () => {
  const h = host();
  h.screen.availTop = 26;
  h.screen.availHeight = h.screen.height - 26;
  const issues = validateHostCalibrationProfile(h);
  assert.ok(!issues.some((issue) => issue.includes('availTop')));
});

test('validateHostCalibrationProfile rejects partial GPU evidence', () => {
  const h = host();
  delete h.webgl.caps;
  delete h.webgl.shaderPrecision;
  const issues = validateHostCalibrationProfile(h);
  assert.ok(issues.includes('host WebGL numeric capabilities are required'));
  assert.ok(issues.includes('host WebGL shader-precision profile is required'));
});

test('a touch-capable host does not give a desktop persona touch points', () => {
  // Regression: the derivation used to copy the host's raw navigator.maxTouchPoints into a desktop
  // persona. The coherence gate then rejected it ("maxTouchPoints must be 0 for a non-mobile
  // profile") and startProfile refused to launch — so on any Surface, 2-in-1 or touch laptop, all
  // of which report 10, the product could not open a single desktop profile. Even with the gate
  // relaxed it would be a lie: the same non-zero count on every profile is a linkage signal, and a
  // desktop UA advertising touch while matchMedia says (pointer: fine) is incoherent.
  const h = host();
  h.navigator.maxTouchPoints = 10;

  const fp = deriveFingerprintFromHost('touch-host-seed', h, { engine: 'lobium' });

  assert.equal(fp.navigator.maxTouchPoints, 0);
  assert.equal(fp.navigator.uaMobile, false);
  assert.deepEqual(validateFingerprintCoherence(fp), []);
});
