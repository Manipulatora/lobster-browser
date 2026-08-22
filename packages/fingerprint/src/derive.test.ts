import assert from 'node:assert/strict';
import test from 'node:test';
import type { CpuArch, EngineKind, GeoInfo, OsFamily } from '@lobster/shared-types';
import {
  DESKTOP_MIN_DEVICE_MEMORY,
  applyGeoToFingerprint,
  validateFingerprintCoherence,
} from './coherence.js';
import { deriveDevicePersona, deriveFingerprint, deriveFromPools } from './derive.js';
import { resolveSourcedRendererPreset } from './catalog.js';
import { isPlausibleDisplayMode } from './displays.js';
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
    // Windows/Linux: bottom taskbar => availTop=0, deficit at the bottom. The height differs by OS:
    // Windows 11's taskbar is 48 CSS px (and this persona announces Windows 11 through
    // Sec-CH-UA-Platform-Version 15.0.0), where the common Linux panel is 40. It is not divided by
    // dpr - Windows scales the taskbar with DPI and Chromium reports the work area already in DIP.
    for (const [os, taskbar] of [['windows', 48], ['linux', 40]] as const) {
      const s = deriveFingerprint(seed, { os, engine: 'lobium' }).screen;
      assert.equal(s.availTop, 0, `${os} availTop seed=${seed}`);
      assert.equal(s.availLeft, 0, `${os} availLeft seed=${seed}`);
      assert.equal(
        s.height - s.availHeight,
        taskbar,
        `${os} deficit must be the taskbar seed=${seed}`,
      );
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

// --- The seed-derived device the profile UI previews ------------------------------------------

test('deriveDevicePersona previews exactly the device the fingerprint launches with', () => {
  // The UI shows the persona; the sidecar launches the fingerprint. If they can disagree, the default
  // device the user was shown is not the one the page sees.
  for (let i = 0; i < 25; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const persona = deriveDevicePersona(seed, { os });
      const fp = deriveFingerprint(seed, { os, engine: 'lobium' });

      assert.equal(persona.arch, fp.arch, `arch ${os} seed=${seed}`);
      assert.deepEqual(persona.screen, fp.screen, `screen ${os} seed=${seed}`);
      assert.equal(persona.hardwareConcurrency, fp.navigator.hardwareConcurrency);
      assert.equal(persona.deviceMemory, fp.navigator.deviceMemory);
      assert.equal(persona.webgl.renderer, fp.webgl.renderer);
      assert.deepEqual(persona.fonts, fp.fonts);
      assert.ok(persona.gpuLabel.length > 0, `gpu label ${os} seed=${seed}`);
      assert.ok(
        !persona.gpuLabel.includes('ANGLE'),
        `gpu label is a model name, not the raw string`,
      );
    }
  }
});

test('two seeds describe two different MACHINES, not one machine with two noise patterns', () => {
  // The whole anti-detect premise: profiles created with default settings must not share a device.
  // Before the seed-derived default the modal pinned one screen, one GPU preset, one core count and
  // one memory size into every profile, so a hundred profiles were one machine a hundred times.
  for (const os of OSES) {
    const devices = new Set<string>();
    const screens = new Set<string>();
    const ratios = new Set<number>();
    for (let i = 0; i < 200; i++) {
      // FIXED seeds, not generateSeed(). Measured over 8 runs this metric lands anywhere in
      // 153..168 for macOS against a floor of 150, so with random seeds the assertion fails
      // occasionally for no reason anyone can reproduce - which is worse than no assertion, because
      // the next person to see it red assumes their change caused it. Fixed seeds keep the property
      // being tested (one seed, one machine; different seeds, different machines) and make the
      // number reproducible.
      const persona = deriveDevicePersona(`diversity-${os}-${i}`, { os });
      devices.add(
        [
          persona.webgl.renderer,
          persona.hardwareConcurrency,
          persona.deviceMemory,
          persona.screen.width,
          persona.screen.height,
          persona.screen.devicePixelRatio,
        ].join('|'),
      );
      screens.add(`${persona.screen.width}x${persona.screen.height}`);
      ratios.add(persona.screen.devicePixelRatio);
    }
    assert.ok(
      devices.size >= 150,
      `${os} produced only ${devices.size} distinct devices in 200 seeds`,
    );
    assert.ok(screens.size >= 4, `${os} produced only ${screens.size} distinct screens`);
    // Every Mac in the catalog is Retina, so macOS legitimately reports one ratio; a PC persona that
    // always claims 100% scaling would be hiding the fact that most laptops do not run at it.
    assert.ok(
      os === 'macos' ? ratios.size === 1 : ratios.size >= 2,
      `${os} devicePixelRatio spread (${[...ratios].join(', ')}) — scaling is part of the device`,
    );
  }
});

test('every seed-derived device is a machine the coherence gate accepts', () => {
  for (let i = 0; i < 150; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const persona = deriveDevicePersona(seed, { os });
      assert.ok(
        isPlausibleDisplayMode(os, {
          width: persona.screen.width,
          height: persona.screen.height,
          dpr: persona.screen.devicePixelRatio,
        }),
        `${os} seed=${seed} derived ${persona.screen.width}x${persona.screen.height}@${persona.screen.devicePixelRatio}`,
      );
      assert.deepEqual(
        validateFingerprintCoherence(deriveFingerprint(seed, { os, engine: 'lobium' })),
        [],
        `${os} seed=${seed} derived an incoherent machine`,
      );
    }
  }
});

test('a derived GPU is one the profile UI can name, and a string a driver could emit', () => {
  // Derivation used to draw from the RAW sourced arrays, which are provenance data: two thirds of the
  // Windows rows carry a pci.ids parser artefact ("GeForce 6800 Ultra]") or a card from 2004, and both
  // went straight into the page-visible ANGLE renderer string.
  for (let i = 0; i < 120; i++) {
    const seed = generateSeed();
    for (const os of OSES) {
      const persona = deriveDevicePersona(seed, { os });
      assert.doesNotMatch(persona.webgl.renderer, /[[\]]/, `${os} seed=${seed} renderer artefact`);
      assert.doesNotMatch(persona.gpuLabel, /[[\]]/, `${os} seed=${seed} label artefact`);
      if (persona.rendererPresetId !== undefined) {
        assert.ok(
          resolveSourcedRendererPreset(persona.rendererPresetId),
          `${os} seed=${seed} derived preset ${persona.rendererPresetId} is not one the UI can offer`,
        );
      }
    }
  }
});

test('a derived Mac is a Retina Mac and a derived PC keeps its own panel', () => {
  for (let i = 0; i < 40; i++) {
    const seed = generateSeed();
    const mac = deriveDevicePersona(seed, { os: 'macos', arch: 'arm64' });
    assert.equal(mac.screen.devicePixelRatio, 2, `Apple Silicon is always Retina seed=${seed}`);
    assert.equal(mac.screen.colorDepth, 30, `Apple Silicon panels are wide-gamut seed=${seed}`);
    assert.match(mac.webgl.renderer, /Apple M\d/, `Apple Silicon GPU seed=${seed}`);

    const win = deriveDevicePersona(seed, { os: 'windows' });
    assert.equal(win.arch, 'x86_64');
    assert.equal(win.screen.availTop, 0);
    assert.equal(win.screen.colorDepth, 24);
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
    // Bounds per OS, from what the SOURCE catalogs actually contain. A single ">= 300" floor was a
    // fabricated "depth requirement": Windows ships 141 font FAMILIES (the old 506 was the face
    // list, and 336 of those were style faces like "Arial Bold" that no font-family lookup
    // resolves), so the floor could only ever be met by claiming fonts that do not exist.
    const BOUNDS: Record<string, readonly [number, number]> = {
      windows: [60, 141], // 63 base + language packs, capped by the MS Learn family list
      macos: [200, 369], // Apple's installed-or-downloadable families, document-support excluded
      linux: [100, 314], // the verified Ubuntu package families
    };
    const [lo, hi] = BOUNDS[os]!;
    assert.ok(
      fonts.length >= lo && fonts.length <= hi,
      `${os} advertises ${fonts.length} fonts, outside the sourced range ${lo}..${hi}`,
    );
    const bad = fonts.filter((name) => unqueryable.test(name));
    assert.deepEqual(bad, [], `${os} claims font names no machine exposes`);
    assert.equal(fonts.includes('Accessories'), false, `${os} claims a catalog section as a font`);
    assert.equal(new Set(fonts).size, fonts.length, `${os} repeats a font family`);
  }
});

test('every Windows persona reports an 8-digit ANGLE device id, curated or generated alike', () => {
  // The two halves of the catalog drifted: the generated presets carried a device id and the
  // hand-curated pool did not, so three in fifty personas reported a Windows renderer with no
  // "(0x…)" at all. ANGLE's Renderer11 always emits one, sized by gl::FmtHex over a UINT.
  for (let i = 0; i < 60; i += 1) {
    const fp = deriveFingerprint(`win-devid-${i}`, { os: 'windows', engine: 'lobium' });
    const renderer = fp.webgl.unmaskedRenderer;
    assert.match(
      renderer,
      /\(0x[0-9A-F]{8}\) Direct3D11 vs_5_0 ps_5_0/,
      `no 8-digit device id in ${renderer}`,
    );
  }
});
