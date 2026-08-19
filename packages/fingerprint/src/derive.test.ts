import assert from 'node:assert/strict';
import test from 'node:test';
import type { CpuArch, EngineKind, GeoInfo, OsFamily } from '@lobster/shared-types';
import {
  DESKTOP_MIN_DEVICE_MEMORY,
  applyGeoToFingerprint,
  validateFingerprintCoherence,
} from './coherence.js';
import { deriveFingerprint, deriveFromPools } from './derive.js';
import { buildChromeBrands, DEVICE_TEMPLATES } from './pools.js';
import { generateSeed } from './seed.js';

const OSES: OsFamily[] = ['windows', 'macos', 'linux'];
const ENGINES: EngineKind[] = ['lobium'];

/** Extract the GPU vendor family from a WebGL vendor string like "Google Inc. (NVIDIA)". */
function gpuVendor(vendor: string): string {
  return vendor.match(/\(([^)]+)\)/)?.[1] ?? vendor;
}

test('deriveFingerprint is deterministic across 50 seeds x OS x engine', () => {
  for (let i = 0; i < 50; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const engine of ENGINES) {
        const a = deriveFingerprint(seed, { os, engine });
        const b = deriveFingerprint(seed, { os, engine });
        assert.deepEqual(a, b, `non-deterministic for ${os}/${engine} seed=${seed}`);
      }
    }
  }
});

test('a fixed seed produces byte-identical output (stable profile identity)', () => {
  const a = deriveFingerprint('fixed-seed-001', { os: 'windows', engine: 'lobium' });
  const b = deriveFingerprint('fixed-seed-001', { os: 'windows', engine: 'lobium' });
  assert.deepEqual(a, b);
});

test('generated fingerprints are internally coherent across 50 seeds x OS x engine', () => {
  for (let i = 0; i < 50; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const engine of ENGINES) {
        const fp = deriveFingerprint(seed, { os, engine });
        assert.deepEqual(
          validateFingerprintCoherence(fp),
          [],
          `incoherent ${os}/${engine} seed=${seed}`,
        );
      }
    }
  }
});

test('Lobium presents a Chrome UA + Sec-CH-UA brands', () => {
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const engine of ENGINES) {
        const fp = deriveFingerprint(seed, { os, engine });
        assert.match(fp.navigator.userAgent, /Chrome\//, `${engine} UA ${os} seed=${seed}`);
        assert.ok(fp.navigator.uaBrands.length > 0, `${engine} brands ${os} seed=${seed}`);
        assert.ok(fp.navigator.uaFullVersion.length > 0, `${engine} version ${os} seed=${seed}`);
      }
    }
  }
});

test('Chrome version is PINNED to the engine build, not seed-diverse (no UA-vs-engine lie)', () => {
  // Every profile runs the SAME engine binary, so all must claim ITS version. A seed-diverse version
  // pool (the old bug: 151 vs 152) is a lie the moment a detector reads getHighEntropyValues
  // fullVersionList — which returns the real engine build. So the UA major is identical across seeds,
  // the UA string is UA-reduced (major.0.0.0), and uaFullVersion carries the real build.
  const majors = new Set<string>();
  for (let i = 0; i < 40; i++) {
    const fp = deriveFingerprint(generateSeed(), { os: 'windows', engine: 'lobium' });
    const uaMajor = /Chrome\/(\d+)/.exec(fp.navigator.userAgent)?.[1];
    majors.add(uaMajor ?? '?');
    assert.match(fp.navigator.userAgent, /Chrome\/\d+\.0\.0\.0 /, `unreduced UA seed ${i}`);
    assert.equal(fp.navigator.uaBrands[0]?.version, uaMajor, `brand major seed ${i}`);
    assert.equal(
      fp.navigator.uaFullVersion.split('.')[0],
      uaMajor,
      `uaFullVersion major seed ${i}`,
    );
    assert.equal(
      fp.navigator.uaFullVersion.split('.').length,
      4,
      `uaFullVersion not a full build seed ${i}`,
    );
  }
  assert.equal(
    majors.size,
    1,
    `Chrome major must be pinned across seeds, saw ${[...majors].join(',')}`,
  );
});

test('browserVersion override pins the UA to a specified engine build (reduced + full forms)', () => {
  const fp = deriveFingerprint('v', {
    os: 'windows',
    engine: 'lobium',
    browserVersion: '140.0.1234.56',
  });
  assert.match(fp.navigator.userAgent, /Chrome\/140\.0\.0\.0 /); // reduced in the UA string
  assert.equal(fp.navigator.uaFullVersion, '140.0.1234.56'); // full build in high-entropy
  assert.equal(fp.navigator.uaBrands[0]?.version, '140');
});

test('screen availTop is coherent with the OS chrome (macOS menu bar vs Windows/Linux taskbar)', () => {
  for (let i = 0; i < 20; i++) {
    const seed = generateSeed();
    // macOS: top menu bar => availTop=25, the whole deficit at the top, no bottom inset.
    const mac = deriveFingerprint(seed, { os: 'macos', engine: 'lobium' }).screen;
    assert.equal(mac.availTop, 25, `macOS availTop seed=${seed}`);
    assert.equal(
      mac.height - mac.availHeight,
      25,
      `macOS deficit must be the menu bar seed=${seed}`,
    );
    // Windows/Linux: bottom taskbar => availTop=0, deficit at the bottom.
    for (const os of ['windows', 'linux'] as const) {
      const s = deriveFingerprint(seed, { os, engine: 'lobium' }).screen;
      assert.equal(s.availTop, 0, `${os} availTop seed=${seed}`);
      assert.equal(s.availLeft, 0, `${os} availLeft seed=${seed}`);
      assert.equal(s.height - s.availHeight, 40, `${os} deficit must be the taskbar seed=${seed}`);
    }
  }
});

test('derives coherent device data (rich fonts, real GPU, plausible screen) from the internal catalog', () => {
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const fp = deriveFingerprint(seed, { os, engine: 'lobium' });

      assert.ok(fp.fonts.length > 0, `fonts empty ${os} seed=${seed}`);
      assert.ok(fp.webgl.renderer.length > 0, `webgl renderer empty ${os} seed=${seed}`);
      assert.ok(fp.webgl.vendor.length > 0, `webgl vendor empty ${os} seed=${seed}`);
      assert.equal(fp.webgl.unmaskedRenderer, fp.webgl.renderer);
      assert.ok(fp.screen.width >= 1024, `screen width ${fp.screen.width} ${os} seed=${seed}`);
      assert.ok(fp.screen.height >= 600, `screen height ${fp.screen.height} ${os} seed=${seed}`);
      assert.ok(fp.screen.availWidth <= fp.screen.width);
      assert.ok(fp.screen.availHeight <= fp.screen.height);
      assert.ok(fp.navigator.hardwareConcurrency > 0);
      assert.equal(fp.locale.locale, fp.navigator.languages[0]);
    }
  }
});

test('no desktop profile advertises an implausibly low deviceMemory (>= 4 GB, capped at 8)', () => {
  for (let i = 0; i < 200; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const fp = deriveFingerprint(seed, { os, engine: 'lobium' });
      assert.ok(
        fp.navigator.deviceMemory >= DESKTOP_MIN_DEVICE_MEMORY && fp.navigator.deviceMemory <= 8,
        `deviceMemory ${fp.navigator.deviceMemory} out of [${DESKTOP_MIN_DEVICE_MEMORY},8] for ${os} seed=${seed}`,
      );
    }
  }
});

test('deriveFromPools is coherent for every OS/arch', () => {
  const ARCHES: CpuArch[] = ['x86_64', 'arm64'];
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      for (const arch of ARCHES) {
        const fp = deriveFromPools(seed, os, arch);
        assert.deepEqual(
          validateFingerprintCoherence(fp),
          [],
          `incoherent deriveFromPools ${os}/${arch} seed=${seed}`,
        );
      }
    }
  }
});

test('macOS architecture request selects a coherent Intel or Apple-Silicon device class', () => {
  for (let i = 0; i < 50; i++) {
    const seed = generateSeed();
    const intel = deriveFingerprint(seed, { os: 'macos', engine: 'lobium', arch: 'x86_64' });
    assert.equal(intel.arch, 'x86_64', `Intel Mac arch seed=${seed}`);
    assert.doesNotMatch(intel.webgl.renderer, /Apple M\d/, `Intel Mac GPU seed=${seed}`);

    const arm = deriveFingerprint(seed, { os: 'macos', engine: 'lobium', arch: 'arm64' });
    assert.equal(arm.arch, 'arm64', `Apple Silicon Mac arch seed=${seed}`);
    assert.match(arm.webgl.renderer, /Apple M\d/, `Apple Silicon Mac GPU seed=${seed}`);
  }
});

// --- Internal-catalog guarantees (senior-engineer hint) ---------------------------------------

test('EVERY catalog device class is coherent (exhaustive, not sampled)', () => {
  // Build the exact base fingerprint each device would yield and validate it directly, so a bad
  // catalog entry is caught even if no seed happened to select it.
  for (const os of OSES) {
    const tpl = DEVICE_TEMPLATES[os];
    assert.ok(tpl.devices.length >= 3, `catalog too thin for ${os}: ${tpl.devices.length} devices`);
    for (const device of tpl.devices) {
      // Mirror derive.ts's per-OS layout: Apple-Silicon Macs are arm64 with a 25px menu bar + P3 (30-bit)
      // display; everything else is x86_64 with a bottom taskbar + 24-bit sRGB.
      const appleSilicon = /Apple M\d/.test(device.webgl.renderer);
      const menuBarTop = os === 'macos' ? 25 : 0;
      const bottomBar = os === 'macos' ? 0 : 40;
      const fp = {
        os,
        arch: (appleSilicon ? 'arm64' : 'x86_64') as CpuArch,
        navigator: {
          userAgent: `Mozilla/5.0 (${tpl.osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36`,
          platform: tpl.platform,
          languages: ['en-US', 'en'],
          hardwareConcurrency: device.hardwareConcurrency,
          deviceMemory: device.deviceMemory,
          maxTouchPoints: 0,
          // Mirrors derive.ts, which builds this with Chrome's own seeded GREASE algorithm rather
          // than a literal. Hardcoding it here would re-introduce the exact staleness the algorithm
          // exists to prevent (the old literal was the M131 decoy, wrong for 152).
          uaBrands: buildChromeBrands('152'),
          uaPlatform: tpl.uaPlatform,
          uaPlatformVersion: tpl.uaPlatformVersion,
          uaMobile: false,
          uaFullVersion: '152.0.0.0',
          uaFormFactor: 'Desktop' as const,
        },
        screen: {
          width: device.screen.width,
          height: device.screen.height,
          availWidth: device.screen.width,
          availHeight: device.screen.height - menuBarTop - bottomBar,
          availLeft: 0,
          availTop: menuBarTop,
          colorDepth: appleSilicon ? 30 : 24,
          devicePixelRatio: device.screen.dpr,
        },
        webgl: { ...device.webgl },
        locale: { timezone: 'America/New_York', locale: 'en-US', acceptLanguage: 'en-US,en;q=0.9' },
        fonts: [...tpl.fonts],
      };
      assert.deepEqual(
        validateFingerprintCoherence(fp),
        [],
        `catalog device ${device.id} is incoherent`,
      );
    }
  }
});

test('different seeds select DIVERSE GPU vendors per OS (not one collapsed device)', () => {
  // The catalog spans Intel/NVIDIA/AMD on Windows+Linux and Apple on macOS. Over many seeds we must
  // actually see that spread — proof the derivation is coherent-but-varied, not fixed.
  const expected: Record<OsFamily, number> = { windows: 3, macos: 2, linux: 3 };
  for (const os of OSES) {
    const vendors = new Set<string>();
    for (let i = 0; i < 300; i++) {
      const fp = deriveFingerprint(generateSeed(), { os, engine: 'lobium' });
      vendors.add(gpuVendor(fp.webgl.vendor));
    }
    assert.ok(
      vendors.size >= expected[os],
      `expected >= ${expected[os]} GPU vendors for ${os}, saw ${[...vendors].join(', ')}`,
    );
  }
  // And the catalog as a whole must include all three desktop GPU vendors somewhere.
  const allVendors = new Set(
    OSES.flatMap((os) => DEVICE_TEMPLATES[os].devices.map((d) => gpuVendor(d.webgl.vendor))),
  );
  for (const v of ['NVIDIA', 'Intel', 'AMD', 'Apple']) {
    assert.ok(allVendors.has(v), `catalog is missing a ${v} device class`);
  }
});

test('proxy geo is an OVERLAY: it rewrites locale/timezone/languages but never the device identity', () => {
  const geo: GeoInfo = {
    ip: '203.0.113.7',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.405,
  };
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const base = deriveFingerprint(seed, { os, engine: 'lobium' });
      const geoed = applyGeoToFingerprint(base, geo);

      // Geo cluster tracks the proxy...
      assert.equal(geoed.locale.timezone, 'Europe/Berlin', `tz ${os} seed=${seed}`);
      assert.equal(geoed.locale.locale, 'de-DE', `locale ${os} seed=${seed}`);
      assert.equal(geoed.navigator.languages[0], 'de-DE', `languages ${os} seed=${seed}`);

      // ...while the DEVICE identity is byte-for-byte untouched.
      assert.equal(geoed.navigator.platform, base.navigator.platform);
      assert.equal(geoed.navigator.userAgent, base.navigator.userAgent);
      assert.equal(geoed.navigator.hardwareConcurrency, base.navigator.hardwareConcurrency);
      assert.equal(geoed.navigator.deviceMemory, base.navigator.deviceMemory);
      assert.equal(geoed.navigator.uaPlatform, base.navigator.uaPlatform);
      assert.deepEqual(geoed.webgl, base.webgl);
      assert.deepEqual(geoed.screen, base.screen);
      assert.deepEqual(geoed.fonts, base.fonts);

      // And the result stays fully coherent (device + new geo agree).
      assert.deepEqual(
        validateFingerprintCoherence(geoed),
        [],
        `geo overlay broke coherence ${os} seed=${seed}`,
      );
    }
  }
});

test('every claimed font is a name a page could actually match', () => {
  // A font probe asks for a FAMILY. Derivation used to emit raw catalog rows, so macOS personas
  // advertised 2,565 entries including `Academy Engraved LET Plain:1.0 16.0d1e1` and a bare
  // `Accessories`, and Linux personas advertised seven fonts in total. Each of those is worse than
  // an inaccuracy: a probe that gets a hit on a documentation artefact has found a string no real
  // machine answers to, which identifies the product rather than hiding it.
  const unqueryable = /\d+\.\d|\bVersion\b|\d+\.d\d|\(\d|:\d/;
  for (const os of ['windows', 'macos', 'linux'] as const) {
    const fonts = deriveFingerprint(`fonts-${os}`, { os, engine: 'lobium' }).fonts ?? [];
    assert.ok(fonts.length >= 300, `${os} advertises only ${fonts.length} fonts`);
    const bad = fonts.filter((name) => unqueryable.test(name));
    assert.deepEqual(bad, [], `${os} claims font names no machine exposes`);
    assert.equal(fonts.includes('Accessories'), false, `${os} claims a catalog section as a font`);
    assert.equal(new Set(fonts).size, fonts.length, `${os} repeats a font family`);
  }
});
