#!/usr/bin/env node
/**
 * FINGERPRINT CONFORMANCE — does a profile actually report what its config asked for?
 *
 * WHY THIS EXISTS. The repo already launches fleets of profiles and scores them with detector
 * panels (battle-test-fleet, detector-matrix, antibot-exam), and `deep-probe-50` even computes an
 * `intendedSummary(fp)` for every persona. But nothing compares intended against observed:
 * deep-probe-50 writes both into its JSON and then decides pass/fail with
 * `isCompleteDeepProbeReadout`, which asserts only that a userAgent and a screen width came back at
 * all. A profile that reported the HOST's identity on every surface would pass it.
 *
 * That is the difference between "the browser answered" and "the browser lied as instructed", and it
 * is the only question that matters for an anti-detect engine. This harness asks it: for each
 * persona it compares every spoofed surface field by field against the config that produced it, and
 * fails on a mismatch.
 *
 * THREE VERDICTS PER FIELD, not two:
 *   MATCH      observed == intended.
 *   MISMATCH   observed != intended — the hook is missing, broken, or clamped.
 *   VACUOUS    observed == intended AND intended == the host's own value. The field agrees, but the
 *              run proves nothing: an unhooked surface that happens to coincide with the persona is
 *              indistinguishable from a working one. These are reported separately so a green run
 *              cannot be built out of coincidences, which is how a fleet on one machine flatters
 *              itself.
 * A host baseline is therefore captured first, with no persona at all.
 *
 * It also records CONTRADICTIONS: pairs of surfaces that are individually correct but cannot both be
 * true of one real device (colorDepth 30 beside a CSS `(color: 8)`; a Chrome brand that rejects
 * Widevine; a macOS persona advertising Dolby Vision, which only a Windows build has).
 *
 * WHICH RENDERER PATH THIS MEASURES. Personas here come from the catalog (deriveFingerprint), which
 * is the path a profile takes when no host calibration exists. The product's DEFAULT renderer policy
 * is `host`, and start-profile then derives the persona from the machine's real GPU, so its caps are
 * ones the host can actually execute. That difference shows up directly in the results: on a host
 * whose GPU cannot back the catalog persona, webgl-runtime-safety clamps MAX_TEXTURE_SIZE and
 * friends down to what the backend can do, and the profile then reports caps that contradict the GPU
 * it names. That is a true finding for the uncalibrated path and NOT evidence about the calibrated
 * one, so do not read a clamp here as a product-wide defect - read it as the cost of shipping a
 * catalog GPU onto a host that cannot back it, which is exactly what happens on a GPU-less VPS when
 * calibration is unavailable.
 *
 *   node ci/validation/fingerprint-conformance.mjs                 # 24 personas
 *   node ci/validation/fingerprint-conformance.mjs --count 40
 *   node ci/validation/fingerprint-conformance.mjs --only windows,macos_arm
 *   LOBSTER_GPU=gpu node ci/validation/fingerprint-conformance.mjs # on a real-GPU host
 */
import { createServer } from 'node:http';
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  applyGeoToFingerprint,
  deriveAndroidFingerprint,
  deriveFingerprint,
} from '@lobster/fingerprint';
import { resolveGpuMode, resolveLobiumBinary } from '@lobster/engine-runner';
import { DEFAULT_CAPABILITY_PROBE_POLICY } from '@lobster/engine-runner';
import { launchNativePersona } from './e2e/native-lobium.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTS = join(HERE, 'reports');
const GPU_MODE = resolveGpuMode();

const argv = process.argv.slice(2);
const argOf = (name, fallback) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};
const COUNT = Number(argOf('count', '24'));
/**
 * Headful by default, because that is what the product runs.
 *
 * The first fleet probed headless and mis-measured WebGPU: headless reports navigator.gpu PRESENT
 * with requestAdapter() returning null, while the same binary headful does not define navigator.gpu
 * at all. Those are different tells, and only the second one is what a user ships. A benchmark that
 * measures a configuration nobody runs is worse than no benchmark, because it reports green for the
 * wrong build. Pass --headless to compare the two deliberately.
 */
const HEADLESS = argv.includes('--headless');
const ONLY = argOf('only', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// --- the probe -------------------------------------------------------------------------------
// Everything a persona claims, read the way a detector reads it. Serialized into #out rather than
// returned, so it survives an isolated world.
const PROBE = `
<!doctype html><meta charset="utf-8"><title>PROBE</title><pre id="out"></pre><script>
(async () => {
  const P = {};
  const safe = (fn, d = null) => { try { const v = fn(); return v === undefined ? d : v; } catch (e) { return d; } };

  const n = navigator;
  P.navigator = {
    userAgent: safe(() => n.userAgent), platform: safe(() => n.platform),
    languages: safe(() => [...n.languages]), language: safe(() => n.language),
    hardwareConcurrency: safe(() => n.hardwareConcurrency), deviceMemory: safe(() => n.deviceMemory),
    maxTouchPoints: safe(() => n.maxTouchPoints), webdriver: safe(() => n.webdriver),
    pdfViewerEnabled: safe(() => n.pdfViewerEnabled), vendor: safe(() => n.vendor),
    plugins: safe(() => n.plugins.length),
  };
  const uad = n.userAgentData;
  P.uaCh = uad ? await safe(async () => {
    const hi = await uad.getHighEntropyValues(['platform','platformVersion','architecture','bitness','model','uaFullVersion','fullVersionList','wow64']);
    return { brands: uad.brands, mobile: uad.mobile, platform: uad.platform, ...hi };
  }, null) : null;

  const s = screen;
  P.screen = {
    width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight,
    colorDepth: s.colorDepth, pixelDepth: s.pixelDepth, dpr: devicePixelRatio,
    orientation: safe(() => s.orientation && s.orientation.type),
  };
  // The CSS side of the same claims. A screen hook that the media queries do not agree with is a
  // one-line contradiction, which is why these are read here and not inferred.
  const mq = (q) => matchMedia(q).matches;
  P.css = {
    deviceWidth: safe(() => { for (let w = 320; w <= 8192; w++) if (mq('(max-device-width: ' + w + 'px)')) return w; return null; }),
    colorBits: safe(() => { for (let b = 1; b <= 16; b++) if (mq('(color: ' + b + ')')) return b; return null; }),
    dynamicRangeHigh: mq('(dynamic-range: high)'),
    colorGamutP3: mq('(color-gamut: p3)'), colorGamutSrgb: mq('(color-gamut: srgb)'),
    anyPointerFine: mq('(any-pointer: fine)'), anyHoverHover: mq('(any-hover: hover)'),
    pointerCoarse: mq('(pointer: coarse)'),
  };

  const glInfo = (ctx) => {
    const c = document.createElement('canvas'); const gl = c.getContext(ctx);
    if (!gl) return null;
    const d = gl.getExtension('WEBGL_debug_renderer_info');
    const G = (k) => safe(() => gl.getParameter(gl[k]));
    const out = {
      version: G('VERSION'), shadingLanguageVersion: G('SHADING_LANGUAGE_VERSION'),
      vendor: G('VENDOR'), renderer: G('RENDERER'),
      unmaskedVendor: d ? safe(() => gl.getParameter(d.UNMASKED_VENDOR_WEBGL)) : null,
      unmaskedRenderer: d ? safe(() => gl.getParameter(d.UNMASKED_RENDERER_WEBGL)) : null,
      maxTextureSize: G('MAX_TEXTURE_SIZE'), maxCubeMapTextureSize: G('MAX_CUBE_MAP_TEXTURE_SIZE'),
      maxRenderbufferSize: G('MAX_RENDERBUFFER_SIZE'),
      maxViewportDims: safe(() => Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS))),
      maxVertexAttribs: G('MAX_VERTEX_ATTRIBS'),
      maxVertexUniformVectors: G('MAX_VERTEX_UNIFORM_VECTORS'),
      maxFragmentUniformVectors: G('MAX_FRAGMENT_UNIFORM_VECTORS'),
      maxVaryingVectors: G('MAX_VARYING_VECTORS'),
      maxTextureImageUnits: G('MAX_TEXTURE_IMAGE_UNITS'),
      maxVertexTextureImageUnits: G('MAX_VERTEX_TEXTURE_IMAGE_UNITS'),
      maxCombinedTextureImageUnits: G('MAX_COMBINED_TEXTURE_IMAGE_UNITS'),
      aliasedLineWidthRange: safe(() => Array.from(gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE))),
      aliasedPointSizeRange: safe(() => Array.from(gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE))),
      extensions: safe(() => gl.getSupportedExtensions().slice().sort()),
    };
    // An extension named but not obtainable is a lie a 3D renderer trips over.
    out.extensionsNull = safe(() => (gl.getSupportedExtensions() || []).filter((e) => gl.getExtension(e) === null));
    return out;
  };
  P.webgl = glInfo('webgl');
  P.webgl2 = glInfo('webgl2');

  P.webgpu = await safe(async () => {
    if (!navigator.gpu) return { present: false };
    const a = await navigator.gpu.requestAdapter();
    if (!a) return { present: true, adapter: null };
    const info = a.info ?? (a.requestAdapterInfo ? await a.requestAdapterInfo() : null);
    return { present: true, adapter: info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description } : {} };
  }, { present: false });

  P.locale = {
    timezone: safe(() => Intl.DateTimeFormat().resolvedOptions().timeZone),
    offsetMinutes: safe(() => new Date().getTimezoneOffset()),
    resolvedLocale: safe(() => Intl.DateTimeFormat().resolvedOptions().locale),
    numberingSystem: safe(() => Intl.DateTimeFormat().resolvedOptions().numberingSystem),
  };

  // Codec support. Dolby Vision is the clean tell: enable_platform_dolby_vision is is_win-only, so a
  // macOS or Linux persona advertising it is unmasked by one call.
  const v = document.createElement('video');
  const can = (t) => safe(() => v.canPlayType(t), '');
  P.codecs = {
    h264: can('video/mp4; codecs="avc1.42E01E"'), aac: can('audio/mp4; codecs="mp4a.40.2"'),
    hevc: can('video/mp4; codecs="hvc1.1.6.L93.B0"'), dolbyVision: can('video/mp4; codecs="dvh1.05.07"'),
    ac3: can('audio/mp4; codecs="ac-3"'), eac3: can('audio/mp4; codecs="ec-3"'),
    vp9: can('video/webm; codecs="vp9"'), av1: can('video/mp4; codecs="av01.0.08M.08"'),
  };
  // Every real Chrome resolves Widevine. A build with enable_widevine=false cannot.
  P.eme = await safe(async () => {
    try {
      const cfg = [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.42E01E"' }] }];
      const a = await navigator.requestMediaKeySystemAccess('com.widevine.alpha', cfg);
      return { widevine: !!a, keySystem: a.keySystem };
    } catch (e) { return { widevine: false, error: String(e.name || e) }; }
  }, { widevine: false });

  P.mediaDevices = await safe(async () => {
    const list = await navigator.mediaDevices.enumerateDevices();
    return list.map((d) => ({ kind: d.kind, label: d.label, hasId: !!d.deviceId }));
  }, null);

  P.misc = {
    hasChromeObj: safe(() => typeof window.chrome === 'object'),
    permissionsQuery: await safe(async () => (await navigator.permissions.query({ name: 'notifications' })).state, null),
    battery: safe(() => typeof navigator.getBattery === 'function'),
  };

  document.getElementById('out').textContent = JSON.stringify(P);
  document.title = 'FP_READY';
})();
</script>`;

// --- comparison ------------------------------------------------------------------------------
const get = (obj, path) => path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Fields whose MISMATCH is a KNOWN, OPEN, DOCUMENTED defect rather than a regression.
 *
 * These are still measured and still reported — silencing them would hide the very thing this
 * harness exists to surface — but they do not gate the run, because a gate that can never go green
 * is a gate nobody looks at.
 *
 * `css.colorBits` is here because it CANNOT pass today on an ordinary display. derive.ts:234 gives
 * every arm64/Apple-Silicon persona screen.colorDepth = 30, Screen::colorDepth IS hooked, and the
 * CSS `(color:)` media feature is NOT hooked by any patch in the series — so the page reads the
 * host's 8 bits/component next to a claimed 30-bit depth. Until a patch hooks
 * MediaValues::CalculateColorBitsPerComponent, any run including a macos_arm persona would fail on
 * this one field alone and drag every other result down with it.
 *
 * Removing a name from this set is how the fix gets enforced: hook the surface, delete the entry,
 * and the gate starts requiring it.
 */
const KNOWN_OPEN_MISMATCHES = new Map([
  [
    'css.colorBits',
    'the CSS (color:) media feature is unhooked while screen.colorDepth is hooked — ' +
      'see docs/subsystems/engine-audit.md and derive.ts:234',
  ],
]);

/**
 * One row per surface we claim to control. `intent` reads the persona, `actual` reads the probe.
 * `critical` fields fail the run; non-critical are reported but do not gate, because they describe
 * realism rather than a broken hook. A field named in KNOWN_OPEN_MISMATCHES is reported under its
 * own verdict and never gates, whatever its `critical` flag says.
 */
const FIELDS = [
  ['navigator.userAgent', (f) => f.navigator.userAgent, (o) => get(o, 'navigator.userAgent'), true],
  ['navigator.platform', (f) => f.navigator.platform, (o) => get(o, 'navigator.platform'), true],
  ['navigator.languages', (f) => f.navigator.languages, (o) => get(o, 'navigator.languages'), true],
  ['navigator.hardwareConcurrency', (f) => f.navigator.hardwareConcurrency, (o) => get(o, 'navigator.hardwareConcurrency'), true],
  ['navigator.deviceMemory', (f) => f.navigator.deviceMemory, (o) => get(o, 'navigator.deviceMemory'), true],
  ['navigator.maxTouchPoints', (f) => f.navigator.maxTouchPoints, (o) => get(o, 'navigator.maxTouchPoints'), true],
  ['navigator.webdriver', () => false, (o) => get(o, 'navigator.webdriver'), true],
  ['uaCh.platform', (f) => f.navigator.uaPlatform ?? null, (o) => get(o, 'uaCh.platform'), false],
  ['uaCh.mobile', (f) => Boolean(f.navigator.uaMobile), (o) => get(o, 'uaCh.mobile'), true],
  ['uaCh.architecture', (f) => f.navigator.uaArchitecture ?? null, (o) => get(o, 'uaCh.architecture'), false],
  ['screen.width', (f) => f.screen.width, (o) => get(o, 'screen.width'), true],
  ['screen.height', (f) => f.screen.height, (o) => get(o, 'screen.height'), true],
  ['screen.colorDepth', (f) => f.screen.colorDepth, (o) => get(o, 'screen.colorDepth'), true],
  ['screen.pixelDepth', (f) => f.screen.colorDepth, (o) => get(o, 'screen.pixelDepth'), true],
  ['screen.dpr', (f) => f.screen.devicePixelRatio, (o) => get(o, 'screen.dpr'), true],
  ['css.deviceWidth', (f) => f.screen.width, (o) => get(o, 'css.deviceWidth'), true],
  // The known contradiction: colorDepth is hooked, the CSS `(color:)` feature is not.
  ['css.colorBits', (f) => Math.round(f.screen.colorDepth / 3), (o) => get(o, 'css.colorBits'), true],
  ['webgl.unmaskedVendor', (f) => f.webgl.unmaskedVendor, (o) => get(o, 'webgl.unmaskedVendor'), true],
  ['webgl.unmaskedRenderer', (f) => f.webgl.unmaskedRenderer, (o) => get(o, 'webgl.unmaskedRenderer'), true],
  ['webgl.version', (f) => f.webgl.version, (o) => get(o, 'webgl.version'), true],
  ['webgl.shadingLanguageVersion', (f) => f.webgl.shadingLanguageVersion, (o) => get(o, 'webgl.shadingLanguageVersion'), true],
  ['webgl.maxTextureSize', (f) => f.webgl.caps.maxTextureSize, (o) => get(o, 'webgl.maxTextureSize'), true],
  ['webgl.maxRenderbufferSize', (f) => f.webgl.caps.maxRenderbufferSize, (o) => get(o, 'webgl.maxRenderbufferSize'), true],
  ['webgl.maxViewportDims', (f) => f.webgl.caps.maxViewportDims, (o) => get(o, 'webgl.maxViewportDims'), true],
  ['webgl.maxVaryingVectors', (f) => f.webgl.caps.maxVaryingVectors, (o) => get(o, 'webgl.maxVaryingVectors'), true],
  ['webgl.maxVertexUniformVectors', (f) => f.webgl.caps.maxVertexUniformVectors, (o) => get(o, 'webgl.maxVertexUniformVectors'), true],
  ['webgl.maxFragmentUniformVectors', (f) => f.webgl.caps.maxFragmentUniformVectors, (o) => get(o, 'webgl.maxFragmentUniformVectors'), true],
  ['webgl.maxTextureImageUnits', (f) => f.webgl.caps.maxTextureImageUnits, (o) => get(o, 'webgl.maxTextureImageUnits'), true],
  ['webgl.extensions', (f) => [...f.webgl.extensions].sort(), (o) => get(o, 'webgl.extensions'), true],
  ['webgl2.extensions', (f) => (f.webgl.extensions2 ? [...f.webgl.extensions2].sort() : null), (o) => get(o, 'webgl2.extensions'), true],
  // WebGPU adapter identity. vendor/architecture are the two fields real Chrome populates; see the
  // contradiction rule for why device/description must stay empty.
  ['webgpu.vendor', (f) => f.webgpu?.vendor ?? null, (o) => get(o, 'webgpu.adapter.vendor'), true],
  ['webgpu.architecture', (f) => f.webgpu?.architecture ?? null, (o) => get(o, 'webgpu.adapter.architecture'), true],
  ['locale.timezone', (f) => f.locale.timezone, (o) => get(o, 'locale.timezone'), true],
  ['locale.resolvedLocale', (f) => f.locale.locale, (o) => get(o, 'locale.resolvedLocale'), false],
];

/** Pairs that can each be individually right and still cannot both be true of one device. */
function contradictions(fp, o) {
  const out = [];
  const isApple = fp.os === 'macos';
  // The Chrome BRAND lives in the Sec-CH-UA brand list, not in the UA string.
  //
  // This used to be /Chrome\//.test(navigator.userAgent). Every persona's UA contains
  // "Chrome/152.0.0.0" — that is the whole point of the product — so the test was always true and
  // the Widevine contradiction below fired for every persona regardless of what brand it claimed,
  // which made the signal worthless. Chromium-derived browsers that do NOT claim to be Google Chrome
  // still carry "Chrome/" in the UA while advertising a different brand entry, and it is the brand
  // claim that creates the Widevine expectation.
  const brands = get(o, 'uaCh.brands');
  const claimsChrome = Array.isArray(brands)
    ? brands.some((b) => /^Google Chrome$/i.test(String(b?.brand ?? '').trim()))
    // No userAgentData at all (a non-secure context, or a build without UA-CH): fall back to the UA
    // string rather than skipping the check, but this is the weaker signal.
    : /Chrome\//.test(String(get(o, 'navigator.userAgent') ?? ''));

  const bits = get(o, 'css.colorBits');
  const depth = get(o, 'screen.colorDepth');
  if (bits != null && depth != null && bits * 3 !== depth) {
    out.push({ id: 'colorDepth-vs-css-color', detail: `screen.colorDepth ${depth} implies (color: ${depth / 3}) but CSS answers (color: ${bits})` });
  }
  if (claimsChrome && get(o, 'eme.widevine') === false) {
    out.push({ id: 'chrome-without-widevine', detail: 'the persona claims the Chrome brand but rejects com.widevine.alpha; every real Chrome resolves it' });
  }
  // Dolby Vision is baked to the BUILD OS, not to the persona: no patch hooks canPlayType and the
  // persona config carries no codec field, so the answer is a pure function of the GN args of the
  // binary, not the persona: `enable_platform_dolby_vision = proprietary_codecs &&
  // (is_cast_media_device || is_win)` (media/media_options.gni), and no Lobium patch touches media/.
  // So the tell is one-directional — a NON-WINDOWS persona that advertises Dolby Vision is unmasked,
  // because real Chrome on macOS or Linux reports "" for it. See engine-audit.md
  // `dolby-vision-baked-to-build-os`.
  //
  // Direction matters and was briefly wrong here: an inverted version fired on the personas that
  // were CORRECT and stayed silent on the one case that is actually contradicted.
  //
  // It is also only meaningful when the build advertises Dolby Vision AT ALL. Measured 2026-08-26 on
  // a Windows QA host: this build reports "" for every dvh1/dvhe/dva1 string — and so does stock
  // Chrome 152.0.7977.42 on the same machine, because platform Dolby Vision additionally needs a
  // host decoder that VM has not got. A run there cannot distinguish "correctly absent" from "never
  // checked", so say so rather than reporting a clean pass.
  const dv = get(o, 'codecs.dolbyVision');
  if (!dv) {
    out.push({
      id: 'dolby-vision-not-exercised',
      vacuous: true,
      detail:
        'this build advertises no Dolby Vision on any persona, so the is_win-only codec tell could ' +
        'not be exercised. Confirm against a host with a Dolby Vision decoder before treating it as absent.',
    });
  } else if (fp.os !== 'windows') {
    out.push({
      id: 'dolby-vision-persona-mismatch',
      detail: `a ${fp.os} persona reports Dolby Vision support ("${dv}"), which only a Windows build has; real Chrome on ${fp.os} reports ""`,
    });
  }
  const nulls = get(o, 'webgl.extensionsNull') ?? [];
  if (nulls.length) {
    out.push({ id: 'webgl-extension-advertised-but-null', detail: `getSupportedExtensions names ${nulls.join(', ')} but getExtension returns null` });
  }
  const gpuPresent = get(o, 'webgpu.present');
  const adapter = get(o, 'webgpu.adapter');
  const renderer = get(o, 'webgl.unmaskedRenderer');
  if (renderer && gpuPresent === false) {
    // Chrome 152 defines navigator.gpu on every desktop platform it ships to. A persona that names a
    // discrete GPU in WebGL and has no WebGPU object at all is claiming a machine that cannot exist.
    out.push({ id: 'webgpu-absent-entirely', detail: `WebGL names "${String(renderer).slice(0, 48)}" but navigator.gpu is undefined; every real Chrome 152 desktop defines it` });
  } else if (renderer && gpuPresent && adapter === null) {
    out.push({ id: 'webgl-gpu-without-webgpu-adapter', detail: 'WebGL names a discrete GPU while navigator.gpu.requestAdapter() returns null' });
  }
  // Real Chrome 152 masks these two for privacy: measured on stock Chrome on this host, an adapter
  // comes back as { vendor, architecture, device: "", description: "" }. Filling them in with the
  // persona's real device id would therefore be a tell in the opposite direction - a browser that
  // volunteers more than Chrome does.
  const adapterInfo = get(o, 'webgpu.adapter');
  if (adapterInfo && (adapterInfo.device || adapterInfo.description)) {
    out.push({
      id: 'webgpu-adapter-overshares',
      detail: `GPUAdapterInfo exposes device "${adapterInfo.device}" / description "${adapterInfo.description}"; real Chrome 152 leaves both empty`,
    });
  }
  if (/SwiftShader|llvmpipe|Software/i.test(String(get(o, 'webgl.unmaskedRenderer') ?? ''))) {
    out.push({ id: 'software-renderer-leaked', detail: 'the WebGL renderer names a software rasteriser — a headless tell the persona was supposed to replace' });
  }
  // The same leak one surface over: WebGL can be perfectly spoofed while the WebGPU adapter still
  // announces the software backend underneath it.
  if (/swiftshader|llvmpipe|software|warp/i.test(String(adapterInfo?.architecture ?? '')) ||
      /swiftshader|llvmpipe|software|warp/i.test(String(adapterInfo?.vendor ?? ''))) {
    out.push({
      id: 'webgpu-adapter-leaks-software',
      detail: `GPUAdapterInfo reports vendor "${adapterInfo?.vendor}" / architecture "${adapterInfo?.architecture}" — the WebGPU adapter names the software backend the WebGL renderer hides`,
    });
  }
  return out;
}

function comparePersona(fp, observed, hostObserved) {
  const fields = [];
  for (const [name, intentOf, actualOf, critical] of FIELDS) {
    let intended;
    try { intended = intentOf(fp); } catch { intended = undefined; }
    if (intended === undefined || intended === null) continue;
    const actual = actualOf(observed);
    const hostValue = hostObserved ? actualOf(hostObserved) : undefined;
    const match = eq(intended, actual);
    // Agreeing with the persona AND with the host proves nothing about the hook.
    const vacuous = match && hostValue !== undefined && eq(intended, hostValue);
    // A known-open defect is reported as its own verdict so it stays visible in every run, but it is
    // not counted as a regression. If one ever starts passing, it reports MATCH and the entry in
    // KNOWN_OPEN_MISMATCHES can be deleted to lock the fix in.
    const knownOpen = KNOWN_OPEN_MISMATCHES.get(name);
    const verdict = match ? (vacuous ? 'VACUOUS' : 'MATCH') : knownOpen ? 'KNOWN-OPEN' : 'MISMATCH';
    fields.push({
      field: name,
      critical,
      intended,
      actual,
      verdict,
      ...(verdict === 'KNOWN-OPEN' ? { knownOpen } : {}),
    });
  }
  return { fields, contradictions: contradictions(fp, observed) };
}

// --- personas --------------------------------------------------------------------------------
/**
 * Exit geographies, applied as the overlay the product applies once a proxy's exit IP is known.
 *
 * Without this every persona keeps the seed default of en-US, which is also the build host's
 * language — so `navigator.languages` and `locale.resolvedLocale` came back VACUOUS for all 24
 * personas in the first run: correct, and proving nothing, because agreement with a persona that
 * agrees with the host is not evidence of a hook. Diversity here is what converts those fields from
 * unprovable into tested.
 */
const GEOS = [
  { ip: '203.0.113.10', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 52.52, longitude: 13.405 },
  { ip: '203.0.113.11', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 },
  { ip: '203.0.113.12', countryCode: 'BR', timezone: 'America/Sao_Paulo', latitude: -23.55, longitude: -46.63 },
  { ip: '203.0.113.13', countryCode: 'FR', timezone: 'Europe/Paris', latitude: 48.86, longitude: 2.35 },
  { ip: '203.0.113.14', countryCode: 'PL', timezone: 'Europe/Warsaw', latitude: 52.23, longitude: 21.01 },
  { ip: '203.0.113.15', countryCode: 'KR', timezone: 'Asia/Seoul', latitude: 37.57, longitude: 126.98 },
];

function buildPersonas(count) {
  const desktop = [
    { os: 'windows', arch: 'x86_64' }, { os: 'macos', arch: 'x86_64' },
    { os: 'macos', arch: 'arm64' }, { os: 'linux', arch: 'x86_64' },
  ];
  // Android carries the only non-zero maxTouchPoints and the only uaCh.mobile=true in the product,
  // so without it those two fields can never be anything but VACUOUS.
  const mobile = [{ os: 'android', formFactor: 'phone' }, { os: 'android', formFactor: 'tablet' }];
  const all = [...desktop, ...mobile].filter(
    (t) => !ONLY.length || ONLY.includes(t.os) || ONLY.includes(`${t.os}_${t.arch === 'arm64' ? 'arm' : 'x64'}`),
  );
  const out = [];
  for (let i = 0; out.length < count && i < count * 4; i++) {
    const t = all[i % all.length];
    const geo = GEOS[i % GEOS.length];
    const seed = `conformance-${t.os}-${t.arch ?? t.formFactor}-${String(i).padStart(3, '0')}`;
    try {
      const base =
        t.os === 'android'
          ? deriveAndroidFingerprint(seed, { engine: 'lobium', deviceType: t.formFactor })
          : deriveFingerprint(seed, { os: t.os, arch: t.arch, engine: 'lobium' });
      out.push({
        id: seed,
        seed,
        os: t.os,
        arch: t.arch ?? t.formFactor,
        android: t.os === 'android',
        ...(t.formFactor ? { formFactor: t.formFactor } : {}),
        geo,
        fingerprint: applyGeoToFingerprint(base, geo),
      });
    } catch (e) {
      console.error(`  ! persona ${seed} could not be derived: ${e.message}`);
    }
  }
  return out;
}

// --- run -------------------------------------------------------------------------------------
async function probeWith(bin, url, persona) {
  const { chromium } = await import('patchright');
  const engine = await launchNativePersona({
    bin,
    profileId: persona.id,
    fingerprint: persona.fingerprint,
    fingerprintSeed: persona.seed,
    fingerprintPolicy: DEFAULT_CAPABILITY_PROBE_POLICY,
    ...(persona.android ? { isMobileProfile: true, mobileFormFactor: persona.formFactor } : {}),
    headless: HEADLESS,
  });
  try {
    const browser = await chromium.connectOverCDP(engine.ws);
    try {
      return await readProbe(browser, url);
    } finally { await browser.close(); }
  } finally { await engine.close(); }
}

/**
 * The host's own values, read from the RAW binary with no persona and no launcher.
 *
 * Deliberately not routed through launchNativePersona: a baseline that passes through the layer
 * under test is not a baseline. It is also what makes the VACUOUS verdict possible — without it,
 * an unhooked surface that happens to agree with the persona is indistinguishable from a working
 * hook, and a fleet run on one machine quietly grades itself on coincidences.
 */
async function probeHost(bin, url) {
  const { chromium } = await import('patchright');
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const userDataDir = await mkdtemp(join(tmpdir(), 'conformance-host-'));
  const browser = await chromium.launchPersistentContext(userDataDir, {
    executablePath: bin,
    headless: HEADLESS,
    args: ['--no-sandbox', '--enable-unsafe-swiftshader'],
  });
  try {
    return await readProbe(browser, url, true);
  } finally {
    await browser.close().catch(() => {});
    await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
  }
}

async function readProbe(browserOrContext, url, isContext = false) {
  const ctx = isContext ? browserOrContext : browserOrContext.contexts()[0];
  const page = ctx.pages()[0] ?? (await ctx.newPage());
  for (let attempt = 0; attempt < 4; attempt++) {
    try { await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 }); break; }
    catch (e) { if (attempt === 3) throw e; await new Promise((r) => setTimeout(r, 400)); }
  }
  for (let i = 0; i < 120; i++) {
    if ((await page.title().catch(() => '')) === 'FP_READY') break;
    await new Promise((r) => setTimeout(r, 150));
  }
  const raw = await page.evaluate(() => document.getElementById('out')?.textContent || '');
  return raw ? JSON.parse(raw) : null;
}

async function main() {
  const bin = resolveLobiumBinary();
  if (!bin) { console.error('CONFORMANCE: BLOCKED — no Lobium binary (set LOBSTER_LOBIUM_BIN)'); process.exitCode = 2; return; }

  const server = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PROBE); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}/`;

  try {
    console.error(`fingerprint conformance — binary ${bin}, gpu=${GPU_MODE}`);
    console.error('capturing the host baseline (no persona) …');
    const host = await probeHost(bin, url).catch((e) => { console.error(`  ! host baseline failed: ${e.message}`); return null; });
    if (host) console.error(`  host: ${String(host.navigator?.platform)} / ${String(host.webgl?.unmaskedRenderer).slice(0, 60)}`);

    const personas = buildPersonas(COUNT);
    console.error(`running ${personas.length} personas …`);
    const results = [];
    for (const [i, persona] of personas.entries()) {
      process.stderr.write(`  [${i + 1}/${personas.length}] ${persona.id} … `);
      try {
        const observed = await probeWith(bin, url, persona);
        if (!observed) throw new Error('probe returned nothing');
        const cmp = comparePersona(persona.fingerprint, observed, host);
        const bad = cmp.fields.filter((f) => f.verdict === 'MISMATCH' && f.critical).length;
        const vac = cmp.fields.filter((f) => f.verdict === 'VACUOUS').length;
        console.error(`${bad ? `${bad} MISMATCH` : 'ok'}${vac ? `, ${vac} vacuous` : ''}${cmp.contradictions.length ? `, ${cmp.contradictions.length} contradiction(s)` : ''}`);
        results.push({ id: persona.id, os: persona.os, arch: persona.arch, ...cmp, observed });
      } catch (e) {
        console.error(`FAILED (${e.message})`);
        results.push({ id: persona.id, os: persona.os, arch: persona.arch, error: String(e.message), fields: [], contradictions: [] });
      }
    }

    // --- aggregate: which FIELD is broken, not which profile ---
    const byField = new Map();
    // Verdict -> counter key. Spelled out rather than derived from the verdict string: 'KNOWN-OPEN'
    // lower-cased is not a valid identifier, and an unmapped verdict would silently increment
    // `undefined` into NaN and take the whole per-field row with it.
    const COUNTER = { MATCH: 'match', MISMATCH: 'mismatch', VACUOUS: 'vacuous', 'KNOWN-OPEN': 'knownOpen' };
    for (const r of results) for (const f of r.fields) {
      const e = byField.get(f.field) ?? { field: f.field, critical: f.critical, match: 0, mismatch: 0, vacuous: 0, knownOpen: 0, examples: [], knownOpenReason: null };
      const key = COUNTER[f.verdict];
      if (key) e[key] += 1;
      if (f.verdict === 'KNOWN-OPEN') e.knownOpenReason ??= f.knownOpen ?? null;
      if ((f.verdict === 'MISMATCH' || f.verdict === 'KNOWN-OPEN') && e.examples.length < 3) e.examples.push({ persona: r.id, intended: f.intended, actual: f.actual });
      byField.set(f.field, e);
    }
    const fieldRows = [...byField.values()].sort((a, b) => b.mismatch - a.mismatch || b.knownOpen - a.knownOpen || a.field.localeCompare(b.field));
    const contraCounts = new Map();
    for (const r of results) for (const c of r.contradictions) {
      const e = contraCounts.get(c.id) ?? { id: c.id, count: 0, detail: c.detail };
      e.count += 1; contraCounts.set(c.id, e);
    }

    const brokenFields = fieldRows.filter((f) => f.critical && f.mismatch > 0);
    const errored = results.filter((r) => r.error).length;
    const verdict = brokenFields.length === 0 && errored === 0 ? 'pass' : 'fail';

    console.error('\n──────── per-field conformance ────────');
    for (const f of fieldRows) {
      const flag = f.mismatch
        ? (f.critical ? 'FAIL' : 'warn')
        : f.knownOpen
          ? 'KNOWN'
          : f.vacuous === f.match + f.vacuous && f.vacuous > 0
            ? 'VACUOUS'
            : 'ok  ';
      console.error(`  ${flag.padEnd(7)} ${f.field.padEnd(34)} match ${String(f.match).padStart(3)}  mismatch ${String(f.mismatch).padStart(3)}  vacuous ${String(f.vacuous).padStart(3)}${f.knownOpen ? `  known-open ${String(f.knownOpen).padStart(3)}` : ''}`);
      if (f.knownOpen && f.knownOpenReason) console.error(`          known open: ${f.knownOpenReason}`);
      if ((f.mismatch || f.knownOpen) && f.examples[0]) console.error(`          e.g. ${f.examples[0].persona}: intended ${JSON.stringify(f.examples[0].intended).slice(0, 70)} · actual ${JSON.stringify(f.examples[0].actual).slice(0, 70)}`);
    }
    if (contraCounts.size) {
      console.error('\n──────── contradictions ────────');
      for (const c of [...contraCounts.values()].sort((a, b) => b.count - a.count)) {
        console.error(`  ${String(c.count).padStart(3)}/${results.length}  ${c.id}`);
        console.error(`          ${c.detail}`);
      }
    }
    // Known-open fields are named in the verdict line, not just buried in the table. A run that says
    // PASS while a documented defect is still live should say so on the line people actually read.
    const knownOpenFields = fieldRows.filter((f) => f.knownOpen > 0);
    console.error(`\nVERDICT: ${verdict.toUpperCase()} — ${results.length - errored}/${results.length} personas probed, ${brokenFields.length} critical field(s) broken, ${contraCounts.size} contradiction kind(s)${knownOpenFields.length ? `, ${knownOpenFields.length} known-open (${knownOpenFields.map((f) => f.field).join(', ')})` : ''}`);

    await mkdir(REPORTS, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const out = join(REPORTS, `fingerprint-conformance-${stamp}.json`);
    await writeFile(out, JSON.stringify({ when: stamp, binary: bin, gpuMode: GPU_MODE, verdict, host, fields: fieldRows, knownOpen: knownOpenFields.map((f) => ({ field: f.field, count: f.knownOpen, reason: f.knownOpenReason })), contradictions: [...contraCounts.values()], personas: results }, null, 2));
    console.error(`report → ${out}`);
    if (verdict !== 'pass') process.exitCode = 1;
  } finally {
    server.close();
  }
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => { console.error(e); process.exitCode = 1; });
}
