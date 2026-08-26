#!/usr/bin/env node
/**
 * Generate a spread of persona configs for QA measurement, without touching a real profile.
 *
 * WHY THIS EXISTS. Phases 1 and 2 of the 2026-08-26 Windows QA brief both need `lobium-fp.json`
 * documents for personas the operator chooses (a Windows one, an Android one, one whose claimed GPU
 * is nothing like the host's, twenty spanning the persona space). Reading them out of
 * `%APPDATA%\com.lobster.browser\profiles` would mean driving a browser against the user's real
 * cookies and logins, which the operations rules forbid, and would only ever produce the two
 * personas that happen to exist on this machine.
 *
 * So this derives personas the way the product does — `deriveFingerprint` / `deriveAndroidFingerprint`
 * from the seed, then `buildLobiumConfig` — and writes each to its own throwaway directory. The
 * configs are therefore the same documents the launcher would write, which is what makes a
 * measurement taken against them mean anything about the product.
 *
 *   node scripts/qa-generate-personas.mjs --out qa-out/personas --set phase1
 *   node scripts/qa-generate-personas.mjs --out qa-out/personas --set phase2
 */
import { mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { deriveFingerprint, deriveAndroidFingerprint, applyGeoToFingerprint } from '@lobster/fingerprint';
import { buildLobiumConfig, writeLobiumConfig, planFontAliases } from '@lobster/engine-runner';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

// stageNativeFontPack is not re-exported by lib.ts and the package's exports map has no subpath, so
// reach the built module by file URL. It is what the launcher calls, and a Windows config without it
// is not the document the product would write — see the FONT PACKS note below.
const requireFrom = createRequire(import.meta.url);
const { stageNativeFontPack } = await import(
  pathToFileURL(
    join(requireFrom.resolve('@lobster/engine-runner'), '..', 'fonts.js'),
  ).href
);

const argv = process.argv.slice(2);
const flag = (n, d) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};
const OUT = resolve(flag('out', 'qa-out/personas'));
const SET = flag('set', 'phase1');
/** The verified font pack beside the engine runtime; see the FONT PACKS note below. */
const FONTS_BASE = flag('fonts', process.env.LOBSTER_FONTS_DIR ?? '');

/**
 * Phase 1 asks for three specific cases, the third being "a persona whose claimed GPU differs
 * sharply from the host's real one — the case most likely to expose a cap the backend cannot
 * honour". On this host every persona qualifies (there is no GPU at all, see the understanding
 * doc), so the third slot instead picks the persona claiming the largest discrete GPU the seed
 * search can find, which is the strongest form of the same test.
 */
const PHASE1 = [
  { name: 'win-desktop', os: 'windows' },
  { name: 'android-mobile', os: 'android' },
  { name: 'gpu-mismatch', os: 'windows', preferDiscrete: true },
];

/**
 * Twenty profiles spanning the persona space.
 *
 * Each carries a country + timezone rather than the en-US default, so the set actually exercises the
 * ICU, navigator.languages and Accept-Language paths — the locale itself is DERIVED from the country
 * by applyGeoToFingerprint below, exactly as the product derives it from a proxy exit IP. Two carry
 * a proxy so the WebRTC policy that only exists with one is covered.
 */
const PHASE2 = [
  { name: 'win-01', os: 'windows', country: 'US', tz: 'America/New_York' },
  { name: 'win-02', os: 'windows', country: 'DE', tz: 'Europe/Berlin' },
  { name: 'win-03', os: 'windows', country: 'JP', tz: 'Asia/Tokyo' },
  { name: 'win-04', os: 'windows', country: 'BR', tz: 'America/Sao_Paulo' },
  { name: 'win-05', os: 'windows', country: 'GB', tz: 'Europe/London', proxy: true },
  { name: 'win-06', os: 'windows', country: 'FR', tz: 'Europe/Paris', preferDiscrete: true },
  { name: 'mac-01', os: 'macos', arch: 'x86_64', country: 'US', tz: 'America/Los_Angeles' },
  { name: 'mac-02', os: 'macos', arch: 'x86_64', country: 'ES', tz: 'Europe/Madrid' },
  { name: 'mac-03', os: 'macos', arch: 'x86_64', country: 'IT', tz: 'Europe/Rome' },
  { name: 'macarm-01', os: 'macos', arch: 'arm64', country: 'US', tz: 'America/Chicago' },
  { name: 'macarm-02', os: 'macos', arch: 'arm64', country: 'NL', tz: 'Europe/Amsterdam' },
  { name: 'macarm-03', os: 'macos', arch: 'arm64', country: 'KR', tz: 'Asia/Seoul', proxy: true },
  { name: 'linux-01', os: 'linux', country: 'US', tz: 'America/Denver' },
  { name: 'linux-02', os: 'linux', country: 'PL', tz: 'Europe/Warsaw' },
  { name: 'linux-03', os: 'linux', country: 'SE', tz: 'Europe/Stockholm' },
  { name: 'android-01', os: 'android', country: 'US', tz: 'America/New_York' },
  { name: 'android-02', os: 'android', country: 'DE', tz: 'Europe/Berlin' },
  { name: 'android-03', os: 'android', country: 'TR', tz: 'Europe/Istanbul' },
  { name: 'android-04', os: 'android', country: 'ID', tz: 'Asia/Jakarta' },
  { name: 'android-05', os: 'android', country: 'IN', tz: 'Asia/Kolkata' },
];

/** Rough "is this a big discrete part" test, used only to pick a seed — never shipped in a config. */
function discreteScore(renderer) {
  const r = String(renderer ?? '');
  if (/RTX\s?(40|50)\d\d/i.test(r)) return 4;
  if (/RTX|Radeon\s?RX|Arc\s?A\d/i.test(r)) return 3;
  if (/GTX|Radeon\s?Pro/i.test(r)) return 2;
  if (/UHD|Iris|Vega|Graphics/i.test(r)) return 0;
  return 1;
}

/**
 * Derive one persona. `preferDiscrete` searches seeds for the strongest claimed GPU rather than
 * taking the first: the seed fixes the whole device, so this is the only way to aim the persona at
 * a particular hardware class without hand-editing a field and breaking coherence.
 */
function derive(spec) {
  const seedOf = (i) => `qa-${spec.name}-${i}`;
  if (spec.os === 'android') {
    return { seed: seedOf(0), fp: deriveAndroidFingerprint(seedOf(0), { engine: 'lobium' }) };
  }
  const opts = { os: spec.os, engine: 'lobium', ...(spec.arch ? { arch: spec.arch } : {}) };
  if (!spec.preferDiscrete) {
    return { seed: seedOf(0), fp: deriveFingerprint(seedOf(0), opts) };
  }
  let best = null;
  for (let i = 0; i < 200; i += 1) {
    const seed = seedOf(i);
    const fp = deriveFingerprint(seed, opts);
    const score = discreteScore(fp.webgl?.renderer);
    if (!best || score > best.score) best = { seed, fp, score };
    if (score >= 4) break;
  }
  return best;
}

rmSync(OUT, { recursive: true, force: true });
mkdirSync(OUT, { recursive: true });

const specs = SET === 'phase2' ? PHASE2 : PHASE1;
const index = [];

for (const spec of specs) {
  const { seed, fp: base } = derive(spec);

  /*
   * Locale and timezone are an OVERLAY on the device identity, applied through the product's own
   * applyGeoToFingerprint — never by assigning fields here.
   *
   * The first version of this script did assign them by hand, and got it wrong in a way that was
   * invisible until the measurements came back: it wrote `fp.timezone` and `fp.locale.language`,
   * but LocaleFingerprint's fields are `locale.timezone`, `locale.locale` and
   * `locale.acceptLanguage`. Every override landed on a field nothing reads, so all 20 personas
   * silently kept the en-US / America/New_York seed default — and the capture then looked exactly
   * like a product that ignores persona locale entirely. A harness that fabricates a defect is
   * worse than no harness.
   *
   * Going through applyGeoToFingerprint also makes the personas more faithful than hand-set fields
   * could be: it DERIVES the locale, languages list and Accept-Language q-values from the country,
   * which is what the product does once a proxy exit IP is known.
   */
  const fp =
    spec.country && spec.tz
      ? applyGeoToFingerprint(base, { countryCode: spec.country, timezone: spec.tz })
      : base;

  const opts = {};
  if (spec.proxy) {
    // A summary only: type/host/port. Credentials never reach this document.
    opts.proxy = { type: 'http', host: '127.0.0.1', port: 3128 };
    opts.webrtcPolicy = 'disable_non_proxied_udp';
  }

  const dir = join(OUT, spec.name);
  mkdirSync(dir, { recursive: true });

  /*
   * FONT PACKS ARE NOT OPTIONAL ON WINDOWS.
   *
   * Windows resolves fonts through a restricted DirectWrite collection built in the browser process
   * from the pack this config names. Omitting the pack does not degrade to host fonts — the
   * collection ends up with nothing usable, BuildRestrictedFontFallback fails, and the browser comes
   * up without ever producing a page target. Measured: an Android persona (which claims Roboto /
   * Noto Sans / Droid Sans, none of them present on a stock Windows host) written without a pack
   * logs `lobium_fonts.cc:535 restricted Windows character fallback could not be built` and
   * /json/list never answers. A desktop Windows persona survives it only because it happens to claim
   * families Windows already has.
   *
   * So this mirrors buildLobiumLaunchArgs exactly rather than calling buildLobiumConfig bare: same
   * persona mapping (android for mobile, else the fingerprint OS), same staging, same alias plan.
   * A config generated any other way is not the document the product would write, and a measurement
   * taken against it would describe the generator rather than the product.
   */
  if (process.platform === 'win32' && FONTS_BASE) {
    const fontPersona = spec.os === 'android' ? 'android' : fp.os;
    const pack = await stageNativeFontPack(dir, fontPersona, FONTS_BASE);
    if (pack) {
      opts.fontPackDir = pack.dir;
      opts.fontFallbackFamilies = pack.physicalFamilies;
      opts.fontAliases = planFontAliases(fontPersona, pack.physicalFamilies, fp.fonts).aliases;
    }
  }

  const config = buildLobiumConfig(fp, opts);
  const path = await writeLobiumConfig(dir, config);

  const row = {
    name: spec.name,
    seed,
    os: spec.os,
    arch: fp.arch ?? spec.arch ?? null,
    config: path,
    ua: fp.navigator?.userAgent ?? fp.userAgent ?? null,
    renderer: fp.webgl?.renderer ?? null,
    vendor: fp.webgl?.vendor ?? null,
    screen: fp.screen ? `${fp.screen.width}x${fp.screen.height}` : null,
    dpr: fp.screen?.devicePixelRatio ?? null,
    colorDepth: fp.screen?.colorDepth ?? null,
    locale: fp.locale?.locale ?? null,
    acceptLanguage: fp.locale?.acceptLanguage ?? null,
    timezone: fp.locale?.timezone ?? null,
    country: spec.country ?? null,
    proxy: Boolean(spec.proxy),
  };
  index.push(row);
  console.log(
    `${spec.name.padEnd(16)} ${String(row.arch).padEnd(7)} ` +
      `${String(row.screen).padEnd(10)} cd=${String(row.colorDepth).padEnd(3)} ` +
      `${String(row.renderer).slice(0, 52)}`,
  );
}

writeFileSync(join(OUT, 'index.json'), `${JSON.stringify(index, null, 2)}\n`);
console.log(`\n${index.length} personas -> ${OUT}`);
