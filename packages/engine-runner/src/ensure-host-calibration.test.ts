/**
 * Unit tests for ensureHostCalibration (HC-3 persistence helper).
 */

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import type { HostCalibrationProfile } from '@lobster/shared-types';

import { persistHostCalibration } from './host-calibration-store.js';
import { ensureHostCalibration } from './ensure-host-calibration.js';

function sampleHost(): HostCalibrationProfile {
  return {
    version: 1,
    capturedAt: '2026-07-09T00:00:00.000Z',
    os: 'linux',
    arch: 'x86_64',
    browserVersion: '152.0.7977.42',
    navigator: {
      platform: 'Linux x86_64',
      languages: ['en-US', 'en'],
      locale: 'en-US',
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: {
      vendor: 'Google Inc. (NVIDIA)',
      renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 5090)',
      unmaskedVendor: 'NVIDIA Corporation',
      unmaskedRenderer: 'NVIDIA GeForce RTX 5090/PCIe/SSE2',
      version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
      shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
      extensions: ['EXT_color_buffer_float'],
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
    fonts: ['DejaVu Sans'],
    timezone: 'UTC',
  };
}

describe('ensureHostCalibration', () => {
  it('loads an existing persisted profile', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hc-ensure-'));
    const path = join(dir, 'host-calibration.json');
    await persistHostCalibration(path, sampleHost());
    const result = await ensureHostCalibration({ path });
    assert.equal(result.source, 'loaded');
    assert.equal(result.profile?.os, 'linux');
    assert.equal(result.profile?.webgl.unmaskedRenderer.includes('5090'), true);
    await rm(dir, { recursive: true, force: true });
  });

  it('returns missing when no file and no probe', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hc-ensure-miss-'));
    const path = join(dir, 'missing.json');
    const result = await ensureHostCalibration({ path });
    assert.equal(result.source, 'missing');
    assert.equal(result.profile, undefined);
    await rm(dir, { recursive: true, force: true });
  });

  it('probes and persists when a probe is supplied', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'hc-ensure-probe-'));
    const path = join(dir, 'host-calibration.json');
    const host = sampleHost();
    const result = await ensureHostCalibration({
      path,
      os: 'linux',
      arch: 'x86_64',
      probe: async () => ({
        navigator: {
          userAgent: 'Mozilla/5.0',
          platform: host.navigator.platform,
          languages: host.navigator.languages ?? ['en-US', 'en'],
          locale: host.navigator.locale ?? 'en-US',
          hardwareConcurrency: host.navigator.hardwareConcurrency,
          deviceMemory: host.navigator.deviceMemory,
          maxTouchPoints: host.navigator.maxTouchPoints,
        },
        screen: host.screen,
        webgl: host.webgl,
        fonts: host.fonts,
        timezone: host.timezone ?? 'UTC',
        browserVersion: host.browserVersion ?? '152.0.7977.42',
      }),
    });
    assert.equal(result.source, 'probed');
    assert.ok(result.profile);
    const again = await ensureHostCalibration({ path });
    assert.equal(again.source, 'loaded');
    await rm(dir, { recursive: true, force: true });
  });
});
