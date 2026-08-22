import assert from 'node:assert/strict';
import test from 'node:test';
import type { AndroidFingerprint } from '@lobster/shared-types';
import {
  applyGeoToFingerprint,
  ANDROID_PHONE_MODEL_CATALOG,
  ANDROID_TABLET_MODEL_CATALOG,
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
  // Chrome's UA reduction freezes the Android platform token on EVERY device, so the persona's real
  // version and model must NOT appear here - they travel in Sec-CH-UA-Platform-Version and
  // Sec-CH-UA-Model, asserted above. Chromium pins this exact string in
  // components/embedder_support/user_agent_utils_unittest.cc.
  assert.match(fp.navigator.userAgent, /\(Linux; Android 10; K\)/);
  assert.doesNotMatch(
    fp.navigator.userAgent,
    new RegExp(fp.android.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
    'the device model must not leak into the User-Agent',
  );
  assert.match(fp.navigator.userAgent, /Mobile Safari\/537\.36/);
  assert.equal(fp.navigator.uaFullVersion, '140.0.1234.56');
  assert.ok(
    fp.screen.width < fp.screen.height,
    'phone profile should default to portrait CSS size',
  );
  assert.ok(fp.fonts.includes('Roboto'));
  assert.ok(fp.webgl.renderer.includes('OpenGL ES') || fp.webgl.renderer.includes('Vulkan'));
});

test('selected Google Play phone/tablet models own the complete Android identity chain', () => {
  const phone = ANDROID_PHONE_MODEL_CATALOG[0];
  const tablet = ANDROID_TABLET_MODEL_CATALOG[0];
  assert.ok(phone && tablet);

  const selectedPhone = deriveAndroidFingerprint('selected-phone', {
    engine: 'lobium',
    deviceType: 'mobile',
    deviceModel: phone.label,
    osVersion: 'Android 15',
  });
  assert.equal(selectedPhone.android.model, phone.model);
  assert.equal(selectedPhone.android.device, phone.device);
  assert.equal(selectedPhone.android.androidVersion, '15');
  assert.equal(selectedPhone.navigator.uaModel, phone.model);
  // The model reaches Sec-CH-UA-Model (above) and NOT the User-Agent: Chrome's reduced UA carries the
  // frozen "Linux; Android 10; K" platform on every device.
  assert.match(selectedPhone.navigator.userAgent, /\(Linux; Android 10; K\)/);
  assert.doesNotMatch(
    selectedPhone.navigator.userAgent,
    new RegExp(phone.model.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')),
  );
  assert.deepEqual(validateAndroidFingerprintCoherence(selectedPhone), []);

  const selectedTablet = deriveAndroidFingerprint('selected-tablet', {
    engine: 'lobium',
    deviceType: 'tablet',
    deviceModel: tablet.label,
    osVersion: 'Android 14',
  });
  // The tablet IDENTITY chain is correct: the model name reaches the UA and Sec-CH-UA-Model, the
  // profile is not mobile, and the screen is landscape.
  assert.equal(selectedTablet.android.formFactor, 'tablet');
  assert.equal(selectedTablet.navigator.uaMobile, false);
  assert.doesNotMatch(selectedTablet.navigator.userAgent, /\bMobile\b/);
  assert.ok(selectedTablet.screen.width > selectedTablet.screen.height);

  // The tablet HARDWARE chain is NOT correct yet, and this test says so rather than pretending
  // otherwise. ANDROID_TEMPLATE.devices contains only phones, so a tablet model can never match a
  // hardware template and falls back to a seeded phone — panel, SoC, GPU string, RAM and cores
  // included. What ships is a real tablet Sec-CH-UA-Model beside phone hardware and a merely rotated
  // phone screen. See docs/ENGINE_AUDIT.md `android-tablet-phone-hardware`.
  //
  // Until curated tablet hardware templates exist, the coherence gate must REPORT this so
  // startProfile fails closed instead of launching a trivially unmasked profile. Asserting the exact
  // issue keeps that behaviour pinned, and this assertion is what flips when the gap is closed.
  const tabletIssues = validateAndroidFingerprintCoherence(selectedTablet);
  assert.equal(
    tabletIssues.length,
    1,
    `expected exactly the known tablet-hardware gap, got: ${tabletIssues.join(' | ')}`,
  );
  assert.match(tabletIssues[0]!, /Android tablet CSS screen is outside expected bounds/);
});

test('phone fingerprints stay portrait while tablet fingerprints are landscape', () => {
  const phone = deriveAndroidFingerprint('orientation-phone', {
    engine: 'lobium',
    deviceType: 'mobile',
  });
  const tablet = deriveAndroidFingerprint('orientation-tablet', {
    engine: 'lobium',
    deviceType: 'tablet',
  });
  assert.ok(phone.screen.height > phone.screen.width);
  assert.equal(phone.android.formFactor, 'phone');
  assert.ok(tablet.screen.width > tablet.screen.height);
  assert.equal(tablet.android.formFactor, 'tablet');
  assert.equal(tablet.navigator.uaMobile, false);
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
        // Left as derived. This fixture used to rewrite the platform token to the device's real
        // version and model; that is precisely the leak the gate now rejects, and the UA is
        // identical across devices anyway.
        userAgent: fp.navigator.userAgent,
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
  // 'ja', not 'ja-JP'. Chromium's own default for Japanese is "ja,en-US,en"
  // (components/strings/components_locale_settings_ja.xtb), with a region-free head - Chrome has
  // never emitted "ja-JP" as navigator.language.
  assert.equal(out.locale.locale, 'ja');
  assert.equal(out.navigator.languages[0], 'ja');
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
