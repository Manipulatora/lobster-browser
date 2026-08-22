import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fingerprint, FingerprintOverrides, GeoInfo } from '@lobster/shared-types';
import {
  DESKTOP_DEVICE_MEMORY_VALUES,
  DEVICE_MEMORY_VALUES,
  applyGeoToFingerprint,
  languagesToAcceptLanguage,
  normalizeColorDepth,
  normalizeDeviceMemory,
  resolveFingerprintPersonaModes,
  validateFingerprintCoherence,
} from './coherence.js';
import { applyOverrides } from './overrides.js';
import { deriveFingerprint } from './derive.js';
import { buildChromeBrands } from './pools.js';

/** A coherent, freshly derived Windows fingerprint to mutate in the rule tests below. */
function coherentBase(): Fingerprint {
  const fp = deriveFingerprint('coherence-rule-base', { os: 'windows', engine: 'lobium' });
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
  const fp = deriveFingerprint('seed-de', { os: 'windows', engine: 'lobium' });
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

test('persona modes resolve independent manual/real/based-IP values without stale overrides', () => {
  const base = deriveFingerprint('persona-modes', { os: 'windows', engine: 'lobium' });
  const overrides: FingerprintOverrides = {
    languageMode: 'manual',
    timezoneMode: 'real',
    geolocationMode: 'based_ip',
    fontsMode: 'real',
    navigator: { languages: ['fr-FR', 'fr'] },
    locale: {
      // A stale manual timezone must be undone when mode changes back to Real.
      timezone: 'Asia/Tokyo',
      geolocation: { latitude: 1, longitude: 2, accuracy: 3 },
    },
    fonts: ['Stale Manual Font'],
  };
  const overridden = applyOverrides(base, overrides);
  const out = resolveFingerprintPersonaModes(base, overridden, overrides, {
    ip: '203.0.113.7',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.405,
  });

  assert.deepEqual(out.navigator.languages, ['fr-FR', 'fr']);
  assert.equal(out.locale.locale, 'fr-FR');
  assert.equal(out.locale.acceptLanguage, 'fr-FR,fr;q=0.9');
  assert.equal(out.locale.timezone, base.locale.timezone, 'real mode restores the base timezone');
  assert.deepEqual(out.locale.geolocation, {
    latitude: 52.52,
    longitude: 13.405,
    accuracy: 100,
  });
  assert.deepEqual(out.fonts, base.fonts, 'real mode restores base fonts');
});

test('based-IP mode without resolved geo falls back to base, not stale manual values', () => {
  const base = deriveFingerprint('persona-no-geo', { os: 'linux', engine: 'lobium' });
  const overrides: FingerprintOverrides = {
    languageMode: 'based_ip',
    timezoneMode: 'based_ip',
    geolocationMode: 'based_ip',
    navigator: { languages: ['ja-JP', 'ja'] },
    locale: {
      timezone: 'Asia/Tokyo',
      locale: 'ja-JP',
      acceptLanguage: 'ja-JP,ja;q=0.9',
      geolocation: { latitude: 1, longitude: 2, accuracy: 3 },
    },
  };
  const out = resolveFingerprintPersonaModes(base, applyOverrides(base, overrides), overrides);
  assert.deepEqual(out.navigator.languages, base.navigator.languages);
  assert.deepEqual(out.locale, base.locale);
});

test('unmapped country derives the language from a real foreign timezone (no en-US mismatch)', () => {
  // ZZ is not a real country, so this exercises the timezone-derived fallback. A `Europe/Stockholm`
  // exit must yield a Swedish locale/language — keeping the seed-default en-US here would be a
  // navigator.language-vs-timezone mismatch (a top bot signal), which the coherence rule now flags.
  const fp = deriveFingerprint('seed-xx', { os: 'linux', engine: 'lobium' });
  const geo: GeoInfo = { ip: '9.9.9.9', countryCode: 'ZZ', timezone: 'Europe/Stockholm' };
  const out = applyGeoToFingerprint(fp, geo);

  assert.equal(out.locale.timezone, 'Europe/Stockholm');
  assert.equal(out.locale.locale, 'sv-SE');
  assert.equal(out.navigator.languages[0], 'sv-SE');
  assert.ok(out.locale.acceptLanguage.startsWith('sv-SE'));
  assert.deepEqual(validateFingerprintCoherence(out), []);
});

test('unknown country AND unknown timezone (Etc/UTC) keeps a coherent seed-default locale', () => {
  const fp = deriveFingerprint('seed-xx', { os: 'linux', engine: 'lobium' });
  const geo: GeoInfo = { ip: '9.9.9.9', countryCode: 'ZZ', timezone: 'Etc/UTC' };
  const out = applyGeoToFingerprint(fp, geo);

  assert.equal(out.locale.timezone, 'Etc/UTC');
  assert.equal(out.navigator.languages[0], out.locale.locale);
  assert.equal(out.locale.geolocation, undefined);
  assert.deepEqual(validateFingerprintCoherence(out), []);
});

test('a mapped foreign country (SE) gets its primary locale coherent with the timezone', () => {
  const fp = deriveFingerprint('seed-se', { os: 'windows', engine: 'lobium' });
  const geo: GeoInfo = { ip: '5.5.5.5', countryCode: 'SE', timezone: 'Europe/Stockholm' };
  const out = applyGeoToFingerprint(fp, geo);

  assert.equal(out.locale.locale, 'sv-SE');
  assert.equal(out.navigator.languages[0], 'sv-SE');
  assert.deepEqual(validateFingerprintCoherence(out), []);
});

test('allows a browser language different from the timezone country (normal multilingual/expat case)', () => {
  const fp = coherentBase();
  fp.locale.timezone = 'Europe/Stockholm';
  assert.deepEqual(validateFingerprintCoherence(fp), []);
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
  // An unbranded Chromium sends the same seeded list minus the product brand. It must still MATCH
  // that algorithm: the previous literal here paired an arbitrary decoy token and version with an
  // arbitrary order, which no Chromium of any version emits.
  fp.navigator.uaBrands = buildChromeBrands(major, { branded: false });
  assert.deepEqual(validateFingerprintCoherence(fp), []);
});

test('rejects a stale GREASE decoy that is right for a DIFFERENT Chrome major', () => {
  // The regression that motivated the algorithmic check: "Not_A Brand" is the M131 decoy. On a 152
  // persona it is wrong in both spelling and position, and Sec-CH-UA rides every request.
  const fp = coherentBase();
  const major = /Chrome\/(\d+)\./.exec(fp.navigator.userAgent)?.[1] ?? '152';
  fp.navigator.uaBrands = [
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
    { brand: 'Not_A Brand', version: '24' },
  ];
  const issues = validateFingerprintCoherence(fp);
  assert.ok(
    issues.some((i) => /Sec-CH-UA brand list is not one Chrome/.test(i)),
    `expected a brand-conformance issue, got: ${JSON.stringify(issues)}`,
  );
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

test('flags deviceMemory above the platform clamp, which is 32 on desktop and 8 on Android', () => {
  // This used to flag 16 as "above the spec cap of 8". Chromium clamps to [2, 32] on desktop
  // (crbug.com/454354290), so 16 and 32 are ordinary desktop values; 64 is not.
  const ok = coherentBase();
  ok.navigator.deviceMemory = 16;
  assert.deepEqual(validateFingerprintCoherence(ok), []);
  const tooMuch = coherentBase();
  tooMuch.navigator.deviceMemory = 64;
  assertFlags(tooMuch, /deviceMemory/);
});

test('flags a desktop deviceMemory below Chromium own floor of 2', () => {
  // 0.25 and 0.5 are not "low" - Chromium cannot emit them at all, on any platform, so they are
  // rejected as off-ladder rather than as implausible. 1 is legal on Android and below the desktop
  // floor. 2 IS a desktop value now: it is exactly kMinMemory.
  const offLadder = coherentBase();
  offLadder.navigator.deviceMemory = 0.25;
  assertFlags(offLadder, /deviceMemory/);
  const androidOnly = coherentBase();
  androidOnly.navigator.deviceMemory = 1;
  assertFlags(androidOnly, /below the desktop clamp/);
  // 2 is Chromium's own kMinMemory, so the CLAMP must not object to it. The GPU-tier envelope may
  // still reject it as unrealistic for a given card - that is a separate, deliberate rule - so this
  // asserts only that the clamp check stays quiet.
  const atFloor = coherentBase();
  atFloor.navigator.deviceMemory = 2;
  assert.equal(
    validateFingerprintCoherence(atFloor).some((i) => /clamp/.test(i)),
    false,
    'deviceMemory 2 is exactly the desktop floor and must not trip the clamp check',
  );
});

test('flags an implausible hardwareConcurrency, OS-aware (96 cores ok on Windows, not on macOS)', () => {
  const zero = coherentBase();
  zero.navigator.hardwareConcurrency = 0;
  assertFlags(zero, /hardwareConcurrency/);

  const mac = structuredClone(deriveFingerprint('mac-hw-base', { os: 'macos', engine: 'lobium' }));
  assert.deepEqual(validateFingerprintCoherence(mac), [], 'mac base must be coherent');
  mac.navigator.hardwareConcurrency = 96; // > 56, impossible on macOS
  assertFlags(mac, /hardwareConcurrency .* range for "macos"/);

  // 96 threads is fine on Windows — on the workstation this GPU says it is.
  const win = coherentBase();
  win.webgl = {
    ...win.webgl,
    renderer: 'ANGLE (NVIDIA, NVIDIA RTX A6000 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA RTX A6000 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  };
  win.navigator.hardwareConcurrency = 96;
  assert.ok(!validateFingerprintCoherence(win).some((i) => /hardwareConcurrency/.test(i)));
});

test('flags an unrealistic colorDepth, and a devicePixelRatio off the OS scale ladder', () => {
  const depth = coherentBase();
  depth.screen.colorDepth = 32;
  assertFlags(depth, /colorDepth/);

  const tooBig = coherentBase();
  tooBig.screen.devicePixelRatio = 5;
  assertFlags(tooBig, /devicePixelRatio/);

  const zero = coherentBase();
  zero.screen.devicePixelRatio = 0;
  assertFlags(zero, /devicePixelRatio/);

  // Windows scales in 25% steps and a page reads the ratio directly, so a value between the steps —
  // or below 1, which only page zoom produces — is a setting no display offers.
  const offLadder = coherentBase();
  offLadder.screen.devicePixelRatio = 1.1;
  assertFlags(offLadder, /devicePixelRatio/);

  const zoomedOut = coherentBase();
  zoomedOut.screen.devicePixelRatio = 0.5;
  assertFlags(zoomedOut, /devicePixelRatio/);
});

test('flags a screen size and devicePixelRatio that no panel and scale step can produce', () => {
  // 1920x1080 at 125% is the 2400x1350 panel that was never built; the same CSS size at 200% is a
  // 4K panel at the scaling every 4K laptop ships with, and must stay legal.
  const invented = coherentBase();
  invented.screen = { ...invented.screen, width: 1920, height: 1080, devicePixelRatio: 1.25 };
  assertFlags(invented, /not a mode any real windows display produces/);

  for (const [width, height, dpr] of [
    [1920, 1080, 2],
    [1536, 864, 1.25],
    [1280, 720, 1.5],
    [1707, 960, 1.5],
    [2560, 1440, 1.5],
    [3440, 1440, 1],
  ] as const) {
    const real = coherentBase();
    real.screen = {
      ...real.screen,
      width,
      height,
      availWidth: width,
      availHeight: height - 40,
      devicePixelRatio: dpr,
    };
    assert.ok(
      !validateFingerprintCoherence(real).some((issue) => /display produces/.test(issue)),
      `${width}x${height}@${dpr} is a real Windows display mode`,
    );
  }
});

test('a Retina Mac reports one of Apple s scaled modes, never the panel at dpr 2', () => {
  const mac = deriveFingerprint('mac-display-modes', { os: 'macos', engine: 'lobium' });
  const scaled = structuredClone(mac);
  // The 16" MacBook Pro panel IS 3456x2234, but macOS reports it as "looks like 1728x1117" at dpr 2.
  // A persona stating the panel itself at dpr 2 claims a 6912x4468 display.
  scaled.screen = {
    ...scaled.screen,
    width: 3456,
    height: 2234,
    availWidth: 3456,
    availHeight: 2209,
    devicePixelRatio: 2,
  };
  assertFlags(scaled, /not a mode any real macos display produces/);

  const real = structuredClone(mac);
  real.screen = {
    ...real.screen,
    width: 1728,
    height: 1117,
    availWidth: 1728,
    availHeight: 1092,
    devicePixelRatio: 2,
  };
  assert.ok(!validateFingerprintCoherence(real).some((issue) => /display produces/.test(issue)));
});

test('rejects hardware combinations no machine ships, without rejecting real ones', () => {
  // The reported case: every value individually legal, the machine impossible.
  const implausible = coherentBase();
  implausible.webgl = {
    ...implausible.webgl,
    vendor: 'Google Inc. (Intel)',
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedVendor: 'Google Inc. (Intel)',
    unmaskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  };
  implausible.navigator.hardwareConcurrency = 24;
  implausible.navigator.deviceMemory = 4;
  assertFlags(implausible, /24-thread machine/);

  // A discrete GPU is never found next to 4 GB of RAM...
  const starvedGpu = coherentBase();
  starvedGpu.webgl = {
    ...starvedGpu.webgl,
    renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 4070 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  };
  starvedGpu.navigator.hardwareConcurrency = 12;
  starvedGpu.navigator.deviceMemory = 4;
  assertFlags(starvedGpu, /below the high-discrete GPU tier's minimum/);

  // ...but the same GPU behind an ageing 4-core CPU is an ordinary upgrade path, and an office laptop
  // with an integrated GPU and 4 GB is the commonest machine there is. Neither may be rejected.
  const upgraded = structuredClone(starvedGpu);
  upgraded.navigator.hardwareConcurrency = 4;
  upgraded.navigator.deviceMemory = 8;
  assert.deepEqual(validateFingerprintCoherence(upgraded), []);

  const office = coherentBase();
  office.webgl = {
    ...office.webgl,
    renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    unmaskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
  };
  office.navigator.hardwareConcurrency = 4;
  office.navigator.deviceMemory = 4;
  assert.deepEqual(validateFingerprintCoherence(office), []);
});

test('an M-series Mac never reports fewer cores than Apple has ever shipped', () => {
  const mac = deriveFingerprint('mac-tier-base', { os: 'macos', engine: 'lobium', arch: 'arm64' });
  const fp = structuredClone(mac);
  fp.navigator.hardwareConcurrency = 4; // the base M1 already has 8
  assertFlags(fp, /outside the apple-silicon GPU tier's plausible/);
});

test('the desktop deviceMemory choices are exactly the spec rungs a desktop may report', () => {
  assert.deepEqual([...DESKTOP_DEVICE_MEMORY_VALUES], [2, 4, 8, 16, 32]);
  for (const value of DEVICE_MEMORY_VALUES) {
    const fp = coherentBase();
    // An integrated-GPU laptop: the tier with the lowest memory floor there is, so what remains is
    // the desktop floor itself.
    fp.webgl = {
      ...fp.webgl,
      renderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
      unmaskedRenderer: 'ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)',
    };
    fp.navigator.deviceMemory = value;
    fp.navigator.hardwareConcurrency = 8;
    // Only the LADDER/CLAMP rule is under test here. A GPU tier may additionally refuse a value it
    // considers unrealistic for that card - an integrated part with 2 GB, say - and that is a
    // separate, deliberate rule with its own tests; folding the two together is what made this
    // assertion wrong when the clamp floor moved from 4 to 2.
    const clampIssue = validateFingerprintCoherence(fp).some((issue) => /clamp|not a spec value/.test(issue));
    assert.equal(
      clampIssue,
      !DESKTOP_DEVICE_MEMORY_VALUES.includes(value),
      `deviceMemory ${value} must be ${DESKTOP_DEVICE_MEMORY_VALUES.includes(value) ? 'on' : 'off'} the desktop ladder`,
    );
  }
  // Values Chromium cannot emit at all must be rejected whatever the GPU.
  for (const bad of [0.25, 0.5, 64]) {
    const fp = coherentBase();
    fp.navigator.deviceMemory = bad;
    assert.ok(
      validateFingerprintCoherence(fp).some((i) => /deviceMemory/.test(i)),
      `deviceMemory ${bad} is not a value Chrome 152 reports`,
    );
  }
});

/** A coherent, freshly derived macOS fingerprint to mutate in the WebGL rule tests. */
function coherentMacBase(): Fingerprint {
  const fp = deriveFingerprint('coherence-mac-base', { os: 'macos', engine: 'lobium' });
  assert.deepEqual(validateFingerprintCoherence(fp), [], 'mac base fixture must start coherent');
  return structuredClone(fp);
}

/** A coherent, freshly derived Linux fingerprint to mutate in the WebGL rule tests. */
function coherentLinuxBase(): Fingerprint {
  const fp = deriveFingerprint('coherence-linux-base', { os: 'linux', engine: 'lobium' });
  assert.deepEqual(validateFingerprintCoherence(fp), [], 'linux base fixture must start coherent');
  return structuredClone(fp);
}

test('flags a SwiftShader software renderer on macOS (no real GPU is an automation tell)', () => {
  const fp = coherentMacBase();
  fp.webgl.vendor = 'Google Inc. (Google)';
  fp.webgl.renderer =
    'ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)), SwiftShader driver)';
  fp.webgl.unmaskedVendor = fp.webgl.vendor;
  fp.webgl.unmaskedRenderer = fp.webgl.renderer;
  assertFlags(fp, /software renderer/);
});

test('flags an llvmpipe software renderer on Linux', () => {
  const fp = coherentLinuxBase();
  fp.webgl.vendor = 'Google Inc. (Mesa/X.org)';
  fp.webgl.renderer = 'ANGLE (Mesa/X.org, llvmpipe (LLVM 15.0.6 256 bits), OpenGL 4.5)';
  fp.webgl.unmaskedVendor = fp.webgl.vendor;
  fp.webgl.unmaskedRenderer = fp.webgl.renderer;
  assertFlags(fp, /software renderer/);
});

test('flags a Windows profile whose renderer is not the ANGLE/Direct3D backend', () => {
  const fp = coherentBase(); // windows
  fp.webgl.vendor = 'Google Inc.';
  fp.webgl.renderer = 'Intel Inc. Intel(R) HD Graphics 630'; // macOS-format, no ANGLE/Direct3D
  fp.webgl.unmaskedVendor = fp.webgl.vendor;
  fp.webgl.unmaskedRenderer = fp.webgl.renderer;
  assertFlags(fp, /must use the ANGLE Direct3D backend/);
});

test('flags a Windows profile carrying a macOS/Apple-format GPU vendor (Intel Inc. + Direct3D)', () => {
  const fp = coherentBase(); // windows
  // Real generator sample: an ANGLE/Direct3D renderer but the Apple-OpenGL "Intel Inc." vendor.
  fp.webgl.vendor = 'Intel Inc.';
  fp.webgl.renderer = 'ANGLE (Intel(R) HD Graphics Family Direct3D11 vs_5_0 ps_5_0)';
  fp.webgl.unmaskedVendor = fp.webgl.vendor;
  fp.webgl.unmaskedRenderer = fp.webgl.renderer;
  assertFlags(fp, /macOS\/Apple-format GPU string/);
});

test('flags a Windows profile carrying a legacy "OpenGL Engine" (macOS) renderer', () => {
  const fp = coherentBase(); // windows
  fp.webgl.vendor = 'Intel Inc.';
  fp.webgl.renderer = 'Intel Iris OpenGL Engine';
  fp.webgl.unmaskedVendor = fp.webgl.vendor;
  fp.webgl.unmaskedRenderer = fp.webgl.renderer;
  assertFlags(fp, /macOS\/Apple-format GPU string/);
});

test('normalizeDeviceMemory snaps onto the rungs Chromium can emit', () => {
  assert.equal(normalizeDeviceMemory(64), 32); // above the desktop clamp -> the clamp
  assert.equal(normalizeDeviceMemory(32), 32);
  assert.equal(normalizeDeviceMemory(24), 16);
  assert.equal(normalizeDeviceMemory(16), 16); // was 8: 16 is a value real desktop Chrome reports
  assert.equal(normalizeDeviceMemory(8), 8);
  assert.equal(normalizeDeviceMemory(6), 4);
  assert.equal(normalizeDeviceMemory(3), 2);
  assert.equal(normalizeDeviceMemory(0.1), 1); // 0.25/0.5 are off the ladder entirely now
  for (const v of [64, 32, 16, 8, 6, 3, 1, 0.1]) {
    assert.ok(DEVICE_MEMORY_VALUES.includes(normalizeDeviceMemory(v)));
  }
});

test('normalizeColorDepth keeps 24/30 and snaps oddities to 24', () => {
  assert.equal(normalizeColorDepth(24), 24);
  assert.equal(normalizeColorDepth(30), 30);
  assert.equal(normalizeColorDepth(32), 24);
  assert.equal(normalizeColorDepth(16), 24);
});

test('navigator.languages matches Chromium own per-locale default, not a two-entry stub', () => {
  // navigator.languages IS the accept-languages preference, and Chromium seeds that preference from
  // IDS_ACCEPT_LANGUAGES in components/strings/components_locale_settings_<locale>.xtb. The
  // derivation used to return at most two entries for every locale on earth; of the 52 locales
  // Chromium ships a default for, the counts run 2-6 and FOUR is the commonest. Two entries for
  // de/fr/ru is distinguishable from a default install of the browser the profile claims to be.
  const base = deriveFingerprint('lang-fixture', { os: 'windows', engine: 'lobium' });
  const CHROMIUM_DEFAULTS: ReadonlyArray<readonly [string, string, readonly string[]]> = [
    ['DE', 'Europe/Berlin', ['de-DE', 'de', 'en-US', 'en']],
    ['FR', 'Europe/Paris', ['fr-FR', 'fr', 'en-US', 'en']],
    ['RU', 'Europe/Moscow', ['ru-RU', 'ru', 'en-US', 'en']],
    ['BR', 'America/Sao_Paulo', ['pt-BR', 'pt', 'en-US', 'en']],
    ['NL', 'Europe/Amsterdam', ['nl-NL', 'nl', 'en-US', 'en']],
    ['GB', 'Europe/London', ['en-GB', 'en-US', 'en']],
    // Region-free heads: Chromium's own defaults carry no region for these, so neither may we.
    ['JP', 'Asia/Tokyo', ['ja', 'en-US', 'en']],
    ['LT', 'Europe/Vilnius', ['lt', 'en-US', 'en', 'ru', 'pl']],
  ];
  for (const [countryCode, timezone, expected] of CHROMIUM_DEFAULTS) {
    const fp = applyGeoToFingerprint(base, { ip: '203.0.113.7', countryCode, timezone });
    assert.deepEqual(
      fp.navigator.languages,
      [...expected],
      `${countryCode}: navigator.languages must equal Chromium's default for this locale`,
    );
    assert.equal(
      fp.locale.locale,
      expected[0],
      `${countryCode}: navigator.language is the head of that list`,
    );
    assert.equal(
      fp.locale.acceptLanguage,
      languagesToAcceptLanguage(expected),
      `${countryCode}: the Accept-Language header must agree with navigator.languages`,
    );
  }
});
