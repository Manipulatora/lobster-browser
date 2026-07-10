import assert from 'node:assert/strict';
import test from 'node:test';
import type { AndroidFingerprint } from '@lobster/shared-types';
import {
  applyGeoToFingerprint,
  deriveAndroidFingerprint,
  validateAndroidFingerprintCoherence,
  validateFingerprintCoherence,
} from './index.js';
import { ANDROID_TEMPLATE } from './pools.js';
import { generateSeed } from './seed.js';

function coherentAndroid(): AndroidFingerprint {
  const fp = deriveAndroidFingerprint('android-coherence-base', { engine: 'lobium' });
  assert.deepEqual(validateAndroidFingerprintCoherence(fp), [], 'base fixture must be coherent');
  return structuredClone(fp);
}

function assertAndroidFlags(fp: AndroidFingerprint, re: RegExp): void {
  const issues = validateAndroidFingerprintCoherence(fp);
  assert.ok(
    issues.some((issue) => re.test(issue)),
    `expected Android coherence issue matching ${re}, got ${JSON.stringify(issues)}`,
  );
}

function gpuVendor(vendor: string): string {
  return vendor.match(/\(([^)]+)\)/)?.[1] ?? vendor;
}

test('deriveAndroidFingerprint is deterministic and coherent across seeds', () => {
  for (let i = 0; i < 100; i++) {
    const seed = generateSeed();
    const a = deriveAndroidFingerprint(seed, { engine: 'lobium' });
    const b = deriveAndroidFingerprint(seed, { engine: 'lobium' });

    assert.deepEqual(a, b, `Android derivation is not deterministic for seed=${seed}`);
    assert.deepEqual(validateAndroidFingerprintCoherence(a), [], `incoherent Android seed=${seed}`);
  }
});

test('Android fingerprints carry the complete mobile identity chain', () => {
  const fp = deriveAndroidFingerprint('android-shape', {
    engine: 'lobium',
    browserVersion: '140.0.1234.56',
  });

  assert.equal(fp.os, 'android');
  assert.equal(fp.arch, 'arm64');
  assert.equal(fp.android.cpuAbi, 'arm64-v8a');
  assert.equal(fp.navigator.uaPlatform, 'Android');
  assert.equal(fp.navigator.uaModel, fp.android.model);
  assert.equal(fp.navigator.uaMobile, true);
  assert.ok(fp.navigator.maxTouchPoints > 0);
  assert.match(fp.navigator.userAgent, new RegExp(`Android ${fp.android.androidVersion}`));
  assert.match(fp.navigator.userAgent, new RegExp(fp.android.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  assert.match(fp.navigator.userAgent, /Mobile Safari\/537\.36/);
  assert.equal(fp.navigator.uaFullVersion, '140.0.1234.56');
  assert.ok(fp.screen.width < fp.screen.height, 'phone profile should default to portrait CSS size');
  assert.ok(fp.fonts.includes('Roboto'));
  assert.ok(fp.webgl.renderer.includes('OpenGL ES') || fp.webgl.renderer.includes('Vulkan'));
});

test('Android catalog is exhaustive-coherent, not just sampled-coherent', () => {
  assert.ok(ANDROID_TEMPLATE.devices.length >= 5, 'Android catalog is too thin');
  const ids = new Set<string>();

  for (const device of ANDROID_TEMPLATE.devices) {
    assert.ok(!ids.has(device.id), `duplicate Android device id ${device.id}`);
    ids.add(device.id);

    const fp = deriveAndroidFingerprint(device.id, { engine: 'lobium' });
    const forced: AndroidFingerprint = {
      ...fp,
      android: {
        brand: device.brand,
        manufacturer: device.manufacturer,
        model: device.model,
        device: device.device,
        androidVersion: device.androidVersion,
        apiLevel: device.apiLevel,
        buildId: device.buildId,
        buildFingerprint: device.buildFingerprint,
        formFactor: 'phone',
        cpuAbi: 'arm64-v8a',
      },
      navigator: {
        ...fp.navigator,
        userAgent: fp.navigator.userAgent.replace(
          /Android \d+; [^)]+/,
          `Android ${device.androidVersion}; ${device.model}`,
        ),
        hardwareConcurrency: device.hardwareConcurrency,
        deviceMemory: device.deviceMemory,
        maxTouchPoints: device.maxTouchPoints,
        uaPlatformVersion: `${device.androidVersion}.0.0`,
        uaModel: device.model,
      },
      screen: {
        width: device.screen.width,
        height: device.screen.height,
        availWidth: device.screen.width,
        availHeight: device.screen.height,
        availLeft: 0,
        availTop: 0,
        colorDepth: 24,
        devicePixelRatio: device.screen.dpr,
      },
      webgl: { ...device.webgl },
      fonts: [...ANDROID_TEMPLATE.fonts],
    };

    assert.deepEqual(
      validateAndroidFingerprintCoherence(forced),
      [],
      `Android catalog device ${device.id} is incoherent`,
    );
  }
});

test('Android seeds select diverse device models and mobile GPU vendors', () => {
  const models = new Set<string>();
  const vendors = new Set<string>();

  for (let i = 0; i < 300; i++) {
    const fp = deriveAndroidFingerprint(generateSeed(), { engine: 'lobium' });
    models.add(fp.android.model);
    vendors.add(gpuVendor(fp.webgl.vendor));
  }

  assert.ok(models.size >= 4, `expected Android model diversity, saw ${[...models].join(', ')}`);
  assert.ok(
    vendors.has('Qualcomm') && vendors.has('ARM'),
    `expected Qualcomm and ARM mobile GPUs, saw ${[...vendors].join(', ')}`,
  );
});

test('proxy geo overlay works for Android without changing device identity', () => {
  const base = deriveAndroidFingerprint('android-geo', { engine: 'lobium' });
  const out = applyGeoToFingerprint(base, {
    ip: '203.0.113.8',
    countryCode: 'JP',
    timezone: 'Asia/Tokyo',
    latitude: 35.6762,
    longitude: 139.6503,
  });

  assert.equal(out.locale.timezone, 'Asia/Tokyo');
  assert.equal(out.locale.locale, 'ja-JP');
  assert.equal(out.navigator.languages[0], 'ja-JP');
  assert.deepEqual(out.android, base.android, 'geo must not mutate the Android device identity');
  assert.deepEqual(out.webgl, base.webgl, 'geo must not mutate Android GPU identity');
  assert.deepEqual(validateAndroidFingerprintCoherence(out), []);
});

test('Android coherence flags desktop-shaped and internally mixed profiles', () => {
  const mobileFalse = coherentAndroid();
  mobileFalse.navigator.uaMobile = false;
  assertAndroidFlags(mobileFalse, /uaMobile/);

  const noTouch = coherentAndroid();
  noTouch.navigator.maxTouchPoints = 0;
  assertAndroidFlags(noTouch, /maxTouchPoints/);

  const modelMismatch = coherentAndroid();
  modelMismatch.navigator.uaModel = 'Pixel 8';
  modelMismatch.android.model = 'SM-S911B';
  assertAndroidFlags(modelMismatch, /Sec-CH-UA-Model/);

  const desktopGpu = coherentAndroid();
  desktopGpu.webgl.vendor = 'Google Inc. (NVIDIA)';
  desktopGpu.webgl.renderer =
    'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11 vs_5_0 ps_5_0, D3D11)';
  desktopGpu.webgl.unmaskedVendor = desktopGpu.webgl.vendor;
  desktopGpu.webgl.unmaskedRenderer = desktopGpu.webgl.renderer;
  assertAndroidFlags(desktopGpu, /desktop GPU backends/);

  const desktopFonts = coherentAndroid();
  desktopFonts.fonts = ['Segoe UI', 'Calibri', 'Arial'];
  assertAndroidFlags(desktopFonts, /Roboto\/Noto Sans|desktop-only/);
});

test('desktop coherence validator rejects Android instead of treating it as launchable desktop', () => {
  const fp = deriveAndroidFingerprint('android-not-desktop', { engine: 'lobium' });
  assert.deepEqual(validateFingerprintCoherence(fp as never), [
    'Unsupported desktop fingerprint OS "android"',
  ]);
});
