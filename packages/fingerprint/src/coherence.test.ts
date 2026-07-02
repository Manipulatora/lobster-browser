import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fingerprint, GeoInfo } from '@lobster/shared-types';
import {
  applyGeoToFingerprint,
  DEVICE_MEMORY_VALUES,
  normalizeColorDepth,
  normalizeDeviceMemory,
  validateFingerprintCoherence,
} from './coherence.js';
import { deriveFingerprint } from './derive.js';

/** A coherent, freshly derived Windows fingerprint to mutate in the rule tests below. */
function coherentBase(): Fingerprint {
  const fp = deriveFingerprint('coherence-rule-base', { os: 'windows', engine: 'chromium' });
  assert.deepEqual(validateFingerprintCoherence(fp), [], 'base fixture must start coherent');
  return structuredClone(fp);
}

/** Assert exactly that at least one issue matching `re` is raised (robust to other rules firing). */
function assertFlags(fp: Fingerprint, re: RegExp): void {
  assert.ok(
    validateFingerprintCoherence(fp).some((i) => re.test(i)),
    `expected a coherence issue matching ${re}, got: ${JSON.stringify(validateFingerprintCoherence(fp))}`,
  );
}

test('applyGeoToFingerprint aligns timezone/locale/languages with the proxy geo', () => {
  const fp = deriveFingerprint('seed-de', { os: 'windows', engine: 'chromium' });
  const geo: GeoInfo = {
    ip: '1.2.3.4',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.4,
  };
  const out = applyGeoToFingerprint(fp, geo);

  assert.equal(out.locale.timezone, 'Europe/Berlin');
  assert.equal(out.locale.locale, 'de-DE');
  assert.equal(out.navigator.languages[0], 'de-DE');
  assert.ok(out.locale.acceptLanguage.startsWith('de-DE'));
  assert.deepEqual(out.locale.geolocation, { latitude: 52.52, longitude: 13.4, accuracy: 100 });
  assert.deepEqual(validateFingerprintCoherence(out), []);
});

test('unknown country keeps a coherent fallback locale and applies the timezone', () => {
  const fp = deriveFingerprint('seed-xx', { os: 'linux', engine: 'lobium' });
  const geo: GeoInfo = { ip: '9.9.9.9', countryCode: 'ZZ', timezone: 'Etc/UTC' };
  const out = applyGeoToFingerprint(fp, geo);

  assert.equal(out.locale.timezone, 'Etc/UTC');
  assert.equal(out.navigator.languages[0], out.locale.locale);
  assert.equal(out.locale.geolocation, undefined);
  assert.deepEqual(validateFingerprintCoherence(out), []);
});

test('flags a Sec-CH-UA brand version mismatched with the UA Chrome major', () => {
  const fp = coherentBase();
  fp.navigator.uaBrands = fp.navigator.uaBrands.map((b) =>
    b.brand === 'Google Chrome' || b.brand === 'Chromium' ? { ...b, version: '999' } : b,
  );
  assertFlags(fp, /Sec-CH-UA brand version/);
});

test('flags a uaFullVersion whose major disagrees with the UA', () => {
  const fp = coherentBase();
  fp.navigator.uaFullVersion = '99.0.1.2';
  assertFlags(fp, /uaFullVersion/);
});

test('flags a Sec-CH-UA-Platform that does not match the claimed OS', () => {
  const fp = coherentBase();
  fp.navigator.uaPlatform = 'macOS'; // base is windows
  assertFlags(fp, /Sec-CH-UA-Platform/);
});

test('flags a modern Chrome on an end-of-life Windows version (NT 6.1 + Chrome 122)', () => {
  const fp = coherentBase();
  fp.navigator.userAgent =
    'Mozilla/5.0 (Windows NT 6.1; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
  assertFlags(fp, /Windows NT 6\.x cannot run Chrome/);
});

test('flags a desktop profile that advertises itself as mobile', () => {
  const fp = coherentBase();
  fp.navigator.uaMobile = true;
  assertFlags(fp, /uaMobile is true/);
});

test('flags touch points on a non-mobile profile', () => {
  const fp = coherentBase();
  fp.navigator.maxTouchPoints = 5;
  assertFlags(fp, /maxTouchPoints/);
});

test('flags a HeadlessChrome (or any foreign/automation) Sec-CH-UA brand', () => {
  const fp = coherentBase();
  fp.navigator.uaBrands = [...fp.navigator.uaBrands, { brand: 'HeadlessChrome', version: '131' }];
  assertFlags(fp, /non-Chrome brand "HeadlessChrome"/);
});

test('flags a Chrome UA with no Chrome/Chromium brand at all (only a grease placeholder)', () => {
  const fp = coherentBase();
  fp.navigator.uaBrands = [{ brand: 'Not_A Brand', version: '99' }];
  assertFlags(fp, /no "Google Chrome"\/"Chromium" brand/);
});

test('accepts a Chromium-only brand set (real Linux Chromium ships no "Google Chrome" brand)', () => {
  const fp = coherentBase();
  const major = /Chrome\/(\d+)\./.exec(fp.navigator.userAgent)?.[1] ?? '131';
  fp.navigator.uaBrands = [
    { brand: 'Not_A Brand', version: '99' },
    { brand: 'Chromium', version: major },
  ];
  assert.deepEqual(validateFingerprintCoherence(fp), []);
});

test('accepts a greased "Not A;Brand" placeholder in any punctuation', () => {
  const fp = coherentBase();
  const major = /Chrome\/(\d+)\./.exec(fp.navigator.userAgent)?.[1] ?? '131';
  fp.navigator.uaBrands = [
    { brand: 'Not/A)Brand', version: '99' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ];
  assert.ok(
    !validateFingerprintCoherence(fp).some((i) => /non-Chrome brand/.test(i)),
    'a greased placeholder must not be treated as a foreign brand',
  );
});

test('flags deviceMemory above the spec cap of 8 (a hard tell)', () => {
  const fp = coherentBase();
  fp.navigator.deviceMemory = 16;
  assertFlags(fp, /deviceMemory/);
});

test('flags an implausibly low desktop deviceMemory (0.25 GB / 256 MB)', () => {
  const low = coherentBase();
  low.navigator.deviceMemory = 0.25; // on the spec ladder, but impossible on a desktop
  assertFlags(low, /implausibly low for a desktop/);
  const two = coherentBase();
  two.navigator.deviceMemory = 2;
  assertFlags(two, /implausibly low for a desktop/);
});

test('flags an implausible hardwareConcurrency, OS-aware (96 cores ok on Windows, not on macOS)', () => {
  const zero = coherentBase();
  zero.navigator.hardwareConcurrency = 0;
  assertFlags(zero, /hardwareConcurrency/);

  const mac = structuredClone(
    deriveFingerprint('mac-hw-base', { os: 'macos', engine: 'chromium' }),
  );
  assert.deepEqual(validateFingerprintCoherence(mac), [], 'mac base must be coherent');
  mac.navigator.hardwareConcurrency = 96; // > 56, impossible on macOS
  assertFlags(mac, /hardwareConcurrency .* range for "macos"/);

  const win = coherentBase();
  win.navigator.hardwareConcurrency = 96; // fine on Windows
  assert.ok(!validateFingerprintCoherence(win).some((i) => /hardwareConcurrency/.test(i)));
});

test('flags an unrealistic colorDepth and devicePixelRatio, but allows fractional scaling', () => {
  const depth = coherentBase();
  depth.screen.colorDepth = 32;
  assertFlags(depth, /colorDepth/);

  const tooBig = coherentBase();
  tooBig.screen.devicePixelRatio = 5;
  assertFlags(tooBig, /devicePixelRatio/);

  const zero = coherentBase();
  zero.screen.devicePixelRatio = 0;
  assertFlags(zero, /devicePixelRatio/);

  // A genuine fractional-scaling / zoomed display (DPR < 1) must NOT be flagged.
  const fractional = coherentBase();
  fractional.screen.devicePixelRatio = 0.5;
  assert.ok(!validateFingerprintCoherence(fractional).some((i) => /devicePixelRatio/.test(i)));
});

test('normalizeDeviceMemory snaps onto the spec ladder and caps at 8', () => {
  assert.equal(normalizeDeviceMemory(16), 8);
  assert.equal(normalizeDeviceMemory(8), 8);
  assert.equal(normalizeDeviceMemory(6), 4);
  assert.equal(normalizeDeviceMemory(3), 2);
  assert.equal(normalizeDeviceMemory(0.1), 0.25);
  for (const v of [16, 8, 6, 3, 1, 0.1]) {
    assert.ok(DEVICE_MEMORY_VALUES.includes(normalizeDeviceMemory(v)));
  }
});

test('normalizeColorDepth keeps 24/30 and snaps oddities to 24', () => {
  assert.equal(normalizeColorDepth(24), 24);
  assert.equal(normalizeColorDepth(30), 30);
  assert.equal(normalizeColorDepth(32), 24);
  assert.equal(normalizeColorDepth(16), 24);
});
