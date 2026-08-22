import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fingerprint, LaunchParams } from '@lobster/shared-types';
import { setBridgeOrigin } from './agent/bridge-registry.js';
import { DEFAULT_DISK_CACHE_BYTES, buildCdpEmulation, buildFingerprintInitScript, buildLaunchOptions, diskCacheBytes } from './launch.js';

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
    engine: 'lobium',
    userDataDir: '/data/p1',
    fingerprint: sampleFingerprint(),
    proxy: { id: 'x', type: 'socks5', host: 'h', port: 1080, username: 'u', password: 'p' },
  };
  const o = buildLaunchOptions(params);
  assert.equal(o.userDataDir, '/data/p1');
  assert.equal(o.headless, false);
  assert.deepEqual(o.proxy, { server: 'socks5://h:1080', username: 'u', password: 'p' });
  assert.ok(o.args.includes('--lang=de-DE'));
  // The automation workaround must NOT be on the command line: it raises Chromium's
  // "unsupported command-line flag" infobar and names itself on chrome://version. The engine
  // answers navigator.webdriver natively instead (Navigator::webdriver).
  assert.ok(
    !o.args.some((a) => a.includes('AutomationControlled')),
    'the automation flag must not be passed',
  );
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

test('buildLaunchOptions applies a proxy-aware WebRTC IP-handling policy (leak protection)', () => {
  // With a proxy: force all WebRTC through it so the real public IP can never leak via STUN.
  const withProxy = buildLaunchOptions({
    profileId: 'p',
    engine: 'lobium',
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
    proxy: { id: 'x', type: 'socks5', host: 'h', port: 1080 },
  });
  assert.ok(withProxy.args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'));

  // Without a proxy: still restrict to the default public interface (no multi-interface enumeration).
  const noProxy = buildLaunchOptions({
    profileId: 'p',
    engine: 'lobium',
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
  });
  assert.ok(
    noProxy.args.includes('--webrtc-ip-handling-policy=default_public_interface_only'),
  );
});

test('buildLaunchOptions honors an explicit WebRTC launch policy', () => {
  const explicitProxyOnly = buildLaunchOptions({
    profileId: 'p',
    engine: 'lobium',
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
    webrtcPolicy: 'proxy_only',
    proxy: { id: 'x', type: 'http', host: 'h', port: 8080 },
  });
  assert.ok(
    explicitProxyOnly.args.includes('--webrtc-ip-handling-policy=disable_non_proxied_udp'),
  );
  assert.throws(
    () =>
      buildLaunchOptions({
        profileId: 'p',
        engine: 'lobium',
        userDataDir: '/d',
        fingerprint: sampleFingerprint(),
        webrtcPolicy: 'proxy_only',
      }),
    /proxy_only policy requires a configured proxy/,
  );

  const explicitDefault = buildLaunchOptions({
    profileId: 'p',
    engine: 'lobium',
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
    webrtcPolicy: 'default_public_interface_only',
  });
  assert.ok(
    explicitDefault.args.includes(
      '--webrtc-ip-handling-policy=default_public_interface_only',
    ),
  );
  assert.throws(
    () =>
      buildLaunchOptions({
        profileId: 'p',
        engine: 'lobium',
        userDataDir: '/d',
        fingerprint: sampleFingerprint(),
        proxy: { id: 'x', type: 'http', host: 'h', port: 8080 },
        webrtcPolicy: 'default_public_interface_only',
      }),
    /unsafe with a proxy/,
  );
});

test('a proxied launch still lets the browser reach the sidecar agent bridge on loopback', () => {
  // `<-loopback>` removes Chromium's implicit localhost bypass, so a proxied profile hands even
  // 127.0.0.1 requests to the upstream — where loopback is the PROVIDER's machine. The Lobee side
  // panel talks to the sidecar bridge over exactly such a URL, so its own origin must be re-added
  // AFTER `<-loopback>` (which erases anything before it) or the panel is dead on every proxied profile.
  const params: LaunchParams = {
    profileId: 'p',
    engine: 'lobium',
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
    proxy: { id: 'x', type: 'http', host: 'proxy.example', port: 8080 },
  };

  const withoutBridge = buildLaunchOptions(params);
  assert.ok(
    withoutBridge.args.includes('--proxy-bypass-list=<-loopback>'),
    'no bridge running (CI harnesses, unit tests) must leave the hardening exactly as it was',
  );

  setBridgeOrigin('http://127.0.0.1:45231');
  try {
    const withBridge = buildLaunchOptions(params);
    assert.ok(withBridge.args.includes('--proxy-bypass-list=<-loopback>;127.0.0.1:45231'));
    // Chromium honors ONE value per switch, so the bypass rule must never be split across two flags.
    assert.equal(withBridge.args.filter((a) => a.startsWith('--proxy-bypass-list=')).length, 1);
    // An unproxied profile needs no bypass list at all — the implicit loopback bypass is intact.
    const { proxy: _proxy, ...unproxied } = params;
    const noProxy = buildLaunchOptions(unproxied);
    assert.ok(!noProxy.args.some((a) => a.startsWith('--proxy-bypass-list=')));
  } finally {
    setBridgeOrigin('');
  }
});

test('buildLaunchOptions pins no ANGLE backend by default and adds ANGLE flags when LOBSTER_GPU=gpu', () => {
  const base = {
    profileId: 'p',
    engine: 'lobium' as const,
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
  };
  const prev = process.env.LOBSTER_GPU;
  try {
    delete process.env.LOBSTER_GPU;
    const off = buildLaunchOptions(base);
    assert.ok(!off.args.some((a) => a.startsWith('--use-angle=')));

    // The software fallback is permitted in every mode so a GPU-less host still HAS WebGL.
    assert.ok(off.args.includes('--enable-unsafe-swiftshader'));

    process.env.LOBSTER_GPU = 'gpu';
    const on = buildLaunchOptions(base);
    assert.ok(on.args.includes('--use-gl=angle'));
    assert.ok(on.args.includes('--use-angle=vulkan'));
    // Never SELECTED as the backend, but still permitted as a last resort.
    assert.ok(!on.args.includes('--use-angle=swiftshader'));
  } finally {
    if (prev === undefined) delete process.env.LOBSTER_GPU;
    else process.env.LOBSTER_GPU = prev;
  }
});

test('buildCdpEmulation carries UA, UA-CH metadata, timezone/locale, and geolocation', () => {
  const e = buildCdpEmulation(sampleFingerprint());
  assert.match(e.userAgent, /Chrome\//);
  assert.equal(e.timezoneId, 'Europe/Berlin');
  assert.equal(e.locale, 'de-DE');
  assert.equal(e.userAgentMetadata.brands[0]?.brand, 'Chromium');
  assert.deepEqual(e.geolocation, { latitude: 52.5, longitude: 13.4, accuracy: 100 });
});

test('buildCdpEmulation sets a coherent fullVersionList (masks the real engine build, no leak)', () => {
  // Without this, getHighEntropyValues(['fullVersionList']) returns the REAL engine build (e.g.
  // 152.0.7977.42), contradicting a spoofed UA — a hard lie. The override must give each REAL brand the
  // full build (== uaFullVersion) and pad the GREASE brand, so high-entropy agrees with the UA.
  const fp = sampleFingerprint();
  fp.navigator.userAgent =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36';
  fp.navigator.uaFullVersion = '152.0.7977.42';
  fp.navigator.uaBrands = [
    { brand: 'Chromium', version: '152' },
    { brand: 'Google Chrome', version: '152' },
    { brand: 'Not_A Brand', version: '24' },
  ];
  const { fullVersionList } = buildCdpEmulation(fp).userAgentMetadata;
  assert.deepEqual(fullVersionList, [
    { brand: 'Chromium', version: '152.0.7977.42' }, // real brand -> full build
    { brand: 'Google Chrome', version: '152.0.7977.42' }, // real brand -> full build
    { brand: 'Not_A Brand', version: '24.0.0.0' }, // GREASE -> padded, not the engine build
  ]);
  // Every entry's major agrees with the UA major -> no version contradiction a detector can read.
  const uaMajor = /Chrome\/(\d+)/.exec(fp.navigator.userAgent)?.[1];
  for (const b of fullVersionList) {
    if (b.version.startsWith(`${uaMajor}.`)) continue; // real brand
    assert.equal(b.brand.includes('Brand'), true, `unexpected non-major brand ${b.brand}`);
  }
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

test('the per-profile HTTP cache is bounded rather than sized from free disk space', () => {
  // Chromium's net/disk_cache/cache_util.cc sizes the cache as `available / 100` on a large volume,
  // so on a 236 GB-free host every profile is entitled to ~2.36 GB. One profile per user is fine;
  // this product runs many profiles per user, each with its own --user-data-dir.
  const args = buildLaunchOptions({
    profileId: 'p',
    engine: 'lobium' as const,
    userDataDir: '/d',
    fingerprint: sampleFingerprint(),
  }).args;
  const flag = args.find((a) => a.startsWith('--disk-cache-size='));
  assert.ok(flag, 'the launcher must bound the disk cache');
  assert.equal(Number(flag.split('=')[1]), DEFAULT_DISK_CACHE_BYTES);
});

test('diskCacheBytes honours an override and refuses a nonsensical one', () => {
  assert.equal(diskCacheBytes({ LOBSTER_DISK_CACHE_MB: '64' }), 64 * 1024 * 1024);
  assert.equal(diskCacheBytes({}), DEFAULT_DISK_CACHE_BYTES);
  // A zero/negative/garbage value must not reach Chromium, where it would read as "size it yourself"
  // and silently restore the unbounded behaviour this exists to prevent.
  for (const bad of ['0', '-5', 'banana', '']) {
    assert.equal(diskCacheBytes({ LOBSTER_DISK_CACHE_MB: bad }), DEFAULT_DISK_CACHE_BYTES, bad);
  }
});
