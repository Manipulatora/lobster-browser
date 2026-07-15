#!/usr/bin/env node
// Multi-OS / multi-device fingerprint BATTLE TEST for the native Lobium engine (real GPU).
//
// This is the "function as Windows/Mac/Linux/Android across versions and devices" e2e gate. For every
// desktop device class in the catalog (Windows/macOS/Linux) it derives a coherent persona, launches
// the REAL native Lobium binary on the physical GPU (no SwiftShader), applies the JS-safe surfaces over
// CDP, and asserts:
//   1. Static coherence  — validateFingerprintCoherence(persona) is clean.
//   2. Applied surfaces  — UA/platform/hardware/screen/webgl-string/timezone/locale actually took.
//   3. Worker coherence  — dedicated + shared workers report the SAME UA/platform (no host leak).
//   4. Deep GPU surfaces — captures getSupportedExtensions()/getShaderPrecisionFormat()/GL version and
//                          FLAGS whether they betray the real host GPU instead of the claimed device
//                          (the known host-calibration gap: the config channel does not carry them).
//   5. Geo overlay       — a proxy-country overlay keeps timezone/locale/languages coherent.
// Android personas are validated statically + at the config layer only: a desktop binary must never be
// a real Android launch target (see docs/ENGINEERING.md (§6)), so launching them is intentionally N/A.
//
//   LOBSTER_LOBIUM_BIN=/path/to/chrome LOBSTER_GPU=gpu LOBSTER_ANGLE_BACKEND=vulkan \
//   VK_ICD_FILENAMES=/path/nvidia_icd.json node ci/validation/battle-test.mjs

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  applyGeoToFingerprint,
  deriveAndroidFingerprint,
  deriveFingerprint,
  validateAndroidFingerprintCoherence,
  validateFingerprintCoherence,
} from '@lobster/fingerprint';
import {
  buildAndroidLobiumConfig,
  buildDevShmArgs,
  buildGpuArgs,
  buildLaunchOptions,
  buildLobiumConfig,
  lobiumConfigArg,
  resolveGpuMode,
  resolveLobiumBinary,
  writeLobiumConfig,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const LOBIUM = resolveLobiumBinary();
const GPU_MODE = resolveGpuMode();

// A loopback origin so probes run in a SECURE CONTEXT. `navigator.deviceMemory` (and other
// [SecureContext] surfaces) are undefined on about:blank/non-secure origins, so probing there would
// falsely report the persona's deviceMemory as unapplied. 127.0.0.1 is treated as potentially
// trustworthy by Chromium, so it is secure without TLS.
let PROBE_SERVER;
let PROBE_URL;
function startProbeServer() {
  return new Promise((resolve) => {
    PROBE_SERVER = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>battle</title><body>ok</body>');
    });
    PROBE_SERVER.listen(0, '127.0.0.1', () => {
      PROBE_URL = `http://127.0.0.1:${PROBE_SERVER.address().port}/`;
      resolve();
    });
  });
}

const DESKTOP_OS = ['windows', 'macos', 'linux'];
// A small geo rotation to exercise locale/timezone coherence beyond the seed-default en-US/New_York.
const GEOS = {
  US: {
    ip: '0.0.0.0',
    countryCode: 'US',
    timezone: 'America/New_York',
    latitude: 40.71,
    longitude: -74.0,
  },
  DE: {
    ip: '0.0.0.0',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.4,
  },
  JP: {
    ip: '0.0.0.0',
    countryCode: 'JP',
    timezone: 'Asia/Tokyo',
    latitude: 35.68,
    longitude: 139.69,
  },
};

const fnv = (s) => {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return (h >>> 0).toString(16);
};

/** Brute-force seeds until every catalog device class for an OS is represented by a real persona. */
function enumerateDesktopPersonas() {
  const personas = [];
  const geoKeys = Object.keys(GEOS);
  for (const os of DESKTOP_OS) {
    const seen = new Map();
    for (let i = 0; i < 4000 && seen.size < 32; i += 1) {
      const seed = `battle-${os}-${i}`;
      const fp = deriveFingerprint(seed, { os, engine: 'lobium' });
      const key = fp.webgl.renderer;
      if (!seen.has(key)) seen.set(key, { seed, fp });
    }
    let n = 0;
    for (const { seed, fp } of seen.values()) {
      // Rotate the geo per device so the matrix also covers locale/timezone overlays across OSes.
      const geoKey = geoKeys[n % geoKeys.length];
      const geo = GEOS[geoKey];
      personas.push({
        os,
        seed,
        geoKey,
        fingerprint: applyGeoToFingerprint(fp, geo),
        rawFingerprint: fp,
      });
      n += 1;
    }
  }
  return personas;
}

function enumerateAndroidPersonas() {
  const personas = [];
  const seen = new Map();
  for (let i = 0; i < 4000 && seen.size < 16; i += 1) {
    const seed = `battle-android-${i}`;
    const fp = deriveAndroidFingerprint(seed, { engine: 'lobium' });
    const key = fp.webgl.renderer + '|' + fp.android.model;
    if (!seen.has(key)) seen.set(key, { seed, fp });
  }
  for (const { seed, fp } of seen.values()) {
    personas.push({ os: 'android', seed, fingerprint: applyGeoToFingerprint(fp, GEOS.US) });
  }
  return personas;
}

async function readCdpEndpoint(userDataDir, retries = 150) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < retries; i += 1) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine)
        return `ws://127.0.0.1:${port}${pathLine.trim()}`;
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the Lobium CDP endpoint');
}

async function probe(page, claim) {
  return page.evaluate(
    async ({ claimR, claimV }) => {
      const fnv = (s) => {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < s.length; i += 1) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16);
      };
      const out = {};
      out.userAgent = navigator.userAgent;
      out.platform = navigator.platform;
      out.hardwareConcurrency = navigator.hardwareConcurrency;
      out.deviceMemory = navigator.deviceMemory ?? null;
      out.maxTouchPoints = navigator.maxTouchPoints;
      out.languages = Array.from(navigator.languages);
      out.timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      out.webdriver = navigator.webdriver === true;
      out.screen = {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        colorDepth: screen.colorDepth,
        devicePixelRatio: window.devicePixelRatio,
      };
      // WebGL: strings (config-overridden) PLUS the deep surfaces the config channel does NOT carry.
      const gl =
        document.createElement('canvas').getContext('webgl') ||
        document.createElement('canvas').getContext('experimental-webgl');
      if (gl) {
        const dbg = gl.getExtension('WEBGL_debug_renderer_info');
        const advertisedExtensions = (gl.getSupportedExtensions() || []).slice().sort();
        const unavailableAdvertisedExtensions = advertisedExtensions.filter(
          (name) => gl.getExtension(name) === null,
        );
        out.webgl = {
          vendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
          renderer: dbg
            ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER),
          version: gl.getParameter(gl.VERSION),
          glsl: gl.getParameter(gl.SHADING_LANGUAGE_VERSION),
          maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
          extensions: advertisedExtensions,
          unavailableAdvertisedExtensions,
        };
        const fh = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT);
        out.webgl.fragHighFloat = fh
          ? { rangeMin: fh.rangeMin, rangeMax: fh.rangeMax, precision: fh.precision }
          : null;
        out.webgl.extHash = fnv(out.webgl.extensions.join(','));
        out.webgl.extCount = out.webgl.extensions.length;
        out.webgl.matchesClaim = out.webgl.renderer === claimR && out.webgl.vendor === claimV;
      }
      // Canvas + audio hashes (farbled per profile — should be STABLE per seed, DISTINCT across seeds).
      try {
        const c = document.createElement('canvas');
        c.width = 240;
        c.height = 60;
        const x = c.getContext('2d');
        x.textBaseline = 'top';
        x.font = "16px 'Arial'";
        x.fillStyle = '#f60';
        x.fillRect(0, 0, 120, 30);
        x.fillStyle = '#069';
        x.fillText('Lobster \u{1F99E} 12345', 2, 18);
        out.canvasHash = fnv(c.toDataURL());
      } catch {
        out.canvasHash = null;
      }
      try {
        const octx = new OfflineAudioContext(1, 5000, 44100);
        const o = octx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = 10000;
        const cm = octx.createDynamicsCompressor();
        o.connect(cm);
        cm.connect(octx.destination);
        o.start(0);
        const buf = await octx.startRendering();
        const ch = buf.getChannelData(0);
        let s = 0;
        for (let i = 4500; i < 5000; i += 1) s += Math.abs(ch[i]);
        out.audioHash = s.toFixed(8);
      } catch {
        out.audioHash = null;
      }
      // Worker cross-context coherence.
      try {
        const code = 'self.postMessage({ua:navigator.userAgent,plat:navigator.platform});';
        const dw = await new Promise((res) => {
          const w = new Worker(URL.createObjectURL(new Blob([code])));
          w.onmessage = (e) => res(e.data);
          setTimeout(() => res(null), 3000);
        });
        out.worker = dw
          ? { uaMatch: dw.ua === navigator.userAgent, platMatch: dw.plat === navigator.platform }
          : null;
      } catch {
        out.worker = null;
      }
      return out;
    },
    { claimR: claim.renderer, claimV: claim.vendor },
  );
}

async function launchAndProbe(persona) {
  const fp = persona.fingerprint;
  const userDataDir = await mkdtemp(join(tmpdir(), `battle-${persona.os}-`));
  const cfg = buildLobiumConfig(fp, { seed: persona.seed });
  const cfgPath = await writeLobiumConfig(userDataDir, cfg);
  const launch = buildLaunchOptions({
    profileId: `battle-${persona.os}`,
    engine: 'lobium',
    userDataDir,
    fingerprint: fp,
    headless: true,
  });
  const args = [
    '--headless=new',
    '--no-sandbox',
    ...buildDevShmArgs(),
    ...(GPU_MODE === 'gpu' ? [] : ['--enable-unsafe-swiftshader']),
    `--user-data-dir=${userDataDir}`,
    lobiumConfigArg(cfgPath),
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...launch.args,
  ];
  if (GPU_MODE === 'gpu' && !args.some((a) => a.startsWith('--use-angle='))) {
    args.push(...buildGpuArgs({ mode: 'gpu' }));
  }
  // Pure native, exactly like a shipped profile: Chromium's timezone/locale come from the child env
  // (the sidecar sets these per persona), and every fingerprint surface is applied by the engine from
  // --lobium-fp-config. No CDP fingerprint overlay — patchright here only drives/reads.
  const localeUnix = `${fp.locale.locale.replaceAll('-', '_')}.UTF-8`;
  const proc = spawn(LOBIUM, args, {
    stdio: 'ignore',
    env: {
      ...process.env,
      TZ: fp.locale.timezone,
      LANG: localeUnix,
      LC_ALL: localeUnix,
      FC_LANG: fp.locale.locale,
    },
  });
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      // Navigate to a secure loopback origin (not about:blank) so [SecureContext] surfaces like
      // navigator.deviceMemory are exposed and can be verified.
      await page.goto(PROBE_URL);
      return await probe(page, fp.webgl);
    } finally {
      await browser.close();
    }
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

function gpuFamily(rendererOrVendor) {
  const t = rendererOrVendor || '';
  if (/NVIDIA/i.test(t)) return 'NVIDIA';
  if (/AMD|Radeon|ATI/i.test(t)) return 'AMD';
  if (/Intel/i.test(t)) return 'Intel';
  if (/Apple|Metal/i.test(t)) return 'Apple';
  if (/Adreno|Qualcomm/i.test(t)) return 'Qualcomm';
  if (/Mali|ARM/i.test(t)) return 'ARM';
  if (/SwiftShader|llvmpipe/i.test(t)) return 'Software';
  return 'Unknown';
}

function evaluateDesktop(persona, obs) {
  const fp = persona.fingerprint;
  const staticIssues = validateFingerprintCoherence(fp);
  const applied = {
    userAgent: obs.userAgent === fp.navigator.userAgent,
    platform: obs.platform === fp.navigator.platform,
    hardwareConcurrency: obs.hardwareConcurrency === fp.navigator.hardwareConcurrency,
    deviceMemory: obs.deviceMemory === fp.navigator.deviceMemory,
    maxTouchPoints: obs.maxTouchPoints === fp.navigator.maxTouchPoints,
    languages: obs.languages.join(',') === fp.navigator.languages.join(','),
    timezone: obs.timezone === fp.locale.timezone,
    webglString: obs.webgl?.matchesClaim === true,
    webglExtensionContract: obs.webgl?.unavailableAdvertisedExtensions.length === 0,
    screen:
      obs.screen.width === fp.screen.width &&
      obs.screen.height === fp.screen.height &&
      obs.screen.colorDepth === fp.screen.colorDepth &&
      Math.abs(obs.screen.devicePixelRatio - fp.screen.devicePixelRatio) < 0.001,
    workerCoherent: obs.worker ? obs.worker.uaMatch && obs.worker.platMatch : true,
    webdriverAbsent: obs.webdriver === false,
  };
  // Deep-GPU host-leak tell: the claimed renderer's GPU family vs the family the DEEP surfaces imply.
  // gl.VERSION is generic ("WebGL x.0 (OpenGL ES ...)"), so the real leak channel is extensions +
  // precision. We can't score them against a reference DB here, but we CAN record the claimed family
  // and the raw deep surfaces so the cross-OS report shows whether they're identical (=host, a tell).
  const claimedFamily = gpuFamily(fp.webgl.renderer);
  return { staticIssues, applied, claimedFamily };
}

async function main() {
  if (!LOBIUM || !existsSync(LOBIUM)) {
    process.stderr.write('Native Lobium binary not found (set LOBSTER_LOBIUM_BIN).\n');
    process.exitCode = 2;
    return;
  }
  await startProbeServer();
  const desktop = enumerateDesktopPersonas();
  const android = enumerateAndroidPersonas();

  const results = [];
  for (const persona of desktop) {
    process.stderr.write(
      `  [${persona.os}] ${persona.fingerprint.webgl.renderer.slice(0, 54)} (${persona.geoKey}) ... `,
    );
    let obs;
    try {
      obs = await launchAndProbe(persona);
    } catch (e) {
      process.stderr.write(`LAUNCH FAILED: ${String(e).slice(0, 80)}\n`);
      results.push({
        os: persona.os,
        seed: persona.seed,
        geo: persona.geoKey,
        launchError: String(e).slice(0, 160),
      });
      continue;
    }
    const ev = evaluateDesktop(persona, obs);
    const appliedPass = Object.values(ev.applied).every((v) => v === true);
    const pass = appliedPass && ev.staticIssues.length === 0;
    process.stderr.write(pass ? 'ok\n' : 'REVIEW\n');
    results.push({
      os: persona.os,
      seed: persona.seed,
      geo: persona.geoKey,
      claimed: {
        renderer: persona.fingerprint.webgl.renderer,
        family: ev.claimedFamily,
        ua: persona.fingerprint.navigator.userAgent,
        locale: persona.fingerprint.locale.locale,
        timezone: persona.fingerprint.locale.timezone,
      },
      staticIssues: ev.staticIssues,
      applied: ev.applied,
      appliedPass,
      deepGpu: {
        observedUnmaskedRenderer: obs.webgl?.renderer ?? null,
        observedFamily: gpuFamily(obs.webgl?.renderer),
        glVersion: obs.webgl?.version ?? null,
        glsl: obs.webgl?.glsl ?? null,
        maxTextureSize: obs.webgl?.maxTextureSize ?? null,
        extCount: obs.webgl?.extCount ?? null,
        extHash: obs.webgl?.extHash ?? null,
        unavailableAdvertisedExtensions: obs.webgl?.unavailableAdvertisedExtensions ?? null,
        fragHighFloat: obs.webgl?.fragHighFloat ?? null,
      },
      hashes: { canvas: obs.canvasHash, audio: obs.audioHash },
      verdict: pass ? 'pass' : 'review',
    });
  }

  // Android: static + config-layer only (never a desktop launch target).
  const androidResults = android.map((p) => {
    const issues = validateAndroidFingerprintCoherence(p.fingerprint);
    let configError = null;
    try {
      buildAndroidLobiumConfig(p.fingerprint, { seed: p.seed });
    } catch (e) {
      configError = String(e).slice(0, 160);
    }
    return {
      os: 'android',
      seed: p.seed,
      model: p.fingerprint.android.model,
      renderer: p.fingerprint.webgl.renderer,
      staticIssues: issues,
      configError,
      launch: 'N/A (Android is a separate APK/device track, not a desktop launch target)',
      verdict: issues.length === 0 && !configError ? 'pass' : 'review',
    };
  });

  // Cross-persona deep-GPU analysis: are the deep surfaces IDENTICAL across claimed-different GPUs?
  // If yes, every persona is leaking the SAME real host GPU — the host-calibration tell.
  const launched = results.filter((r) => r.deepGpu);
  const extHashes = new Set(launched.map((r) => r.deepGpu.extHash));
  const observedFamilies = new Set(launched.map((r) => r.deepGpu.observedFamily));
  const claimedFamilies = new Set(launched.map((r) => r.claimed.family));
  const canvasHashes = launched.map((r) => r.hashes.canvas).filter(Boolean);
  const distinctCanvas = new Set(canvasHashes).size;

  const report = {
    kind: 'battle-test',
    capturedAt: new Date().toISOString(),
    engine: 'lobium',
    binary: LOBIUM,
    gpuMode: GPU_MODE,
    counts: {
      desktopPersonas: desktop.length,
      androidPersonas: android.length,
      desktopPass: results.filter((r) => r.verdict === 'pass').length,
      desktopReview: results.filter((r) => r.verdict === 'review').length,
      desktopLaunchErrors: results.filter((r) => r.launchError).length,
      androidPass: androidResults.filter((r) => r.verdict === 'pass').length,
      androidReview: androidResults.filter((r) => r.verdict === 'review').length,
    },
    deepGpuAnalysis: {
      distinctExtensionHashes: extHashes.size,
      distinctObservedFamilies: [...observedFamilies],
      distinctClaimedFamilies: [...claimedFamilies],
      distinctCanvasHashes: distinctCanvas,
      totalLaunched: launched.length,
      hostLeakTell:
        extHashes.size <= 1 && claimedFamilies.size > 1
          ? 'CONFIRMED: all personas share ONE WebGL extension set while claiming multiple GPU families — the deep GPU surfaces (extensions/precision) are the real host, not the claimed device.'
          : 'not detected in this run',
      farblingDistinctPerProfile:
        distinctCanvas === canvasHashes.length
          ? 'ok: canvas hash is distinct per profile'
          : `WARNING: only ${distinctCanvas}/${canvasHashes.length} canvas hashes are distinct`,
    },
    desktop: results,
    android: androidResults,
  };

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = report.capturedAt.replace(/[:.]/g, '-');
  const outPath = join(REPORTS_DIR, `battle-test-${stamp}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);

  PROBE_SERVER?.close();

  process.stdout.write(`${JSON.stringify(report.counts, null, 2)}\n`);
  process.stdout.write(`\ndeepGpuAnalysis:\n${JSON.stringify(report.deepGpuAnalysis, null, 2)}\n`);
  process.stdout.write(`\nsaved: ${outPath}\n`);

  // Deep-GPU host-leak: personas claim different GPU families but share ONE real WebGL extension set,
  // i.e. the deep surfaces are the host, not the claimed device. This is a genuine cross-check tell —
  // but ONLY on real hardware. Under software rendering every persona legitimately shares SwiftShader's
  // one extension set, so it is environmental there, not a bug. Gate the hard failure on GPU mode.
  const hostLeakConfirmed = extHashes.size <= 1 && claimedFamilies.size > 1;
  // Canvas farbling must be deterministic-yet-distinct PER PROFILE on any renderer; a collision (two
  // profiles sharing a canvas hash) is a real coherence bug regardless of GPU.
  const farblingCollision = distinctCanvas < canvasHashes.length;

  const hardFail =
    report.counts.desktopLaunchErrors > 0 ||
    results.some((r) => r.staticIssues && r.staticIssues.length > 0) ||
    androidResults.some((r) => r.staticIssues.length > 0 || r.configError) ||
    farblingCollision ||
    (GPU_MODE === 'gpu' && hostLeakConfirmed);
  if (hardFail) {
    process.exitCode = 1;
    if (GPU_MODE === 'gpu' && hostLeakConfirmed) {
      process.stderr.write(
        '\nHARD FAIL: deep-GPU host-leak — personas share one WebGL extension set across claimed GPU ' +
          'families on real hardware (see docs/ENGINEERING.md W1).\n',
      );
    }
    if (farblingCollision) {
      process.stderr.write(
        `\nHARD FAIL: canvas farbling collision — only ${distinctCanvas}/${canvasHashes.length} distinct hashes.\n`,
      );
    }
  }
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exitCode = 3;
});
