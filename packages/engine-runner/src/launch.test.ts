import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fingerprint, LaunchParams } from '@lobster/shared-types';
import { buildCdpEmulation, buildFingerprintInitScript, buildLaunchOptions } from './launch.js';

function sampleFingerprint(): Fingerprint {
  return {
    os: 'windows',
    arch: 'x86_64',
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['de-DE', 'de'],
      hardwareConcurrency: 12,
      deviceMemory: 8,
      maxTouchPoints: 0,
      uaBrands: [{ brand: 'Chromium', version: '131' }],
      uaPlatform: 'Windows',
      uaPlatformVersion: '15.0.0',
      uaMobile: false,
      uaFullVersion: '131.0.0.0',
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: { vendor: 'v', renderer: 'r', unmaskedVendor: 'v', unmaskedRenderer: 'r' },
    locale: {
      timezone: 'Europe/Berlin',
      locale: 'de-DE',
      acceptLanguage: 'de-DE,de;q=0.9',
      geolocation: { latitude: 52.5, longitude: 13.4, accuracy: 100 },
    },
    fonts: ['Arial'],
  };
}

test('buildLaunchOptions maps userDataDir, headless default, proxy, and coherent args', () => {
  const params: LaunchParams = {
    profileId: 'p1',
    engine: 'chromium',
    userDataDir: '/data/p1',
    fingerprint: sampleFingerprint(),
    proxy: { id: 'x', type: 'socks5', host: 'h', port: 1080, username: 'u', password: 'p' },
  };
  const o = buildLaunchOptions(params);
  assert.equal(o.userDataDir, '/data/p1');
  assert.equal(o.headless, false);
  assert.deepEqual(o.proxy, { server: 'socks5://h:1080', username: 'u', password: 'p' });
  assert.ok(o.args.includes('--lang=de-DE'));
  assert.ok(o.args.includes('--disable-blink-features=AutomationControlled'));
});

test('buildLaunchOptions honors headless flag and omits proxy when absent', () => {
  const params: LaunchParams = {
    profileId: 'p2',
    engine: 'lobium',
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
    headless: true,
  };
  const o = buildLaunchOptions(params);
  assert.equal(o.headless, true);
  assert.equal(o.proxy, undefined);
});

test('buildCdpEmulation carries UA, UA-CH metadata, timezone/locale, and geolocation', () => {
  const e = buildCdpEmulation(sampleFingerprint());
  assert.match(e.userAgent, /Chrome\//);
  assert.equal(e.timezoneId, 'Europe/Berlin');
  assert.equal(e.locale, 'de-DE');
  assert.equal(e.userAgentMetadata.brands[0]?.brand, 'Chromium');
  assert.deepEqual(e.geolocation, { latitude: 52.5, longitude: 13.4, accuracy: 100 });
});

test('init script owns only the residual JS-only surfaces (deviceMemory, maxTouchPoints)', () => {
  const s = buildFingerprintInitScript(sampleFingerprint());
  assert.match(s, /deviceMemory/);
  assert.match(s, /maxTouchPoints/);
  // languages/hardwareConcurrency/platform are CDP-owned; touching them from JS throws (they're
  // pinned non-configurable) so they must NOT appear in the init script.
  assert.doesNotMatch(s, /navigator, "languages"/);
  assert.doesNotMatch(s, /hardwareConcurrency/);
  // Each override is wrapped so one failure can't abort the rest.
  assert.match(s, /try \{/);
  // Deep surfaces must never be spoofed from JS (detectable) — assert they're absent.
  assert.doesNotMatch(s, /canvas|webgl|audiocontext|toDataURL|getImageData/i);
});

test('init script isolates each override: a throwing def cannot abort the rest', () => {
  const s = buildFingerprintInitScript(sampleFingerprint());
  // Mock navigator whose `deviceMemory` is non-configurable, so the first def() THROWS — exactly the
  // condition (a CDP-pinned property) that used to abort the whole IIFE and leave maxTouchPoints unset.
  const nav: Record<string, unknown> = {};
  Object.defineProperty(nav, 'deviceMemory', { value: 99, configurable: false });
  // Run the produced script with our mock in place of the global `navigator`.
  new Function('navigator', s)(nav);
  assert.equal(
    nav.deviceMemory,
    99,
    'the throwing def must be caught, leaving the pinned value intact',
  );
  assert.equal(
    nav.maxTouchPoints,
    0,
    'the second override must still apply despite the first throwing',
  );
});
