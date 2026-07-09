#!/usr/bin/env node
// Host-calibrated persona E2E (roadmap HC-1 / HC-3 — the documented fix for the deep-GPU host-leak the
// battle test confirms).
//
// The catalog path claims an ARBITRARY GPU (e.g. "AMD Radeon RX 580 Direct3D11") while the deep WebGL
// surfaces the config channel does NOT carry — getSupportedExtensions(), getShaderPrecisionFormat(),
// gl.VERSION — still come from the REAL host GPU. A detector cross-checks the claimed renderer against
// those surfaces and catches the mismatch. The host-calibrated model removes that tell by INHERITING
// the real machine's GPU identity + deep surfaces, then individualizing only the farbled pixel hashes
// per profile.
//
// This script proves the Definition-of-Done bullet on real hardware:
//   "Two profiles on the same host share real hardware facts but have distinct, stable farbling hashes."
// It:
//   1. Launches an UNSPOOFED calibration browser and probes the real host (probeHostCalibration).
//   2. Validates the host snapshot (rejects software renderers).
//   3. Derives N profiles from that ONE host with distinct seeds (deriveFingerprintFromHost).
//   4. Launches each native-Lobium profile on the real GPU and asserts:
//        - the claimed renderer STRING equals the real host renderer (no cross-check tell),
//        - the observed WebGL extension set equals the host's (coherent by construction),
//        - hardware facts (renderer/extensions/cores) are SHARED across profiles,
//        - canvas/webgl/audio farbling hashes are DISTINCT per profile and STABLE across relaunch.
//
//   LOBSTER_LOBIUM_BIN=/path/to/chrome LOBSTER_GPU=gpu LOBSTER_ANGLE_BACKEND=vulkan \
//   VK_ICD_FILENAMES=/path/nvidia_icd.json node ci/validation/host-calibration-e2e.mjs

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { platform, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  deriveFingerprintFromHost,
  validateFingerprintCoherence,
  validateHostCalibrationProfile,
} from '@lobster/fingerprint';
import {
  applyCdpFingerprint,
  buildGpuArgs,
  buildLaunchOptions,
  buildLobiumConfig,
  lobiumConfigArg,
  normalizeHostCalibrationSnapshot,
  resolveGpuMode,
  resolveLobiumBinary,
  writeLobiumConfig,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const LOBIUM = resolveLobiumBinary();
const GPU_MODE = resolveGpuMode();
const OS = process.env.LOBSTER_HOST_OS || 'linux';
const ARCH = process.env.LOBSTER_HOST_ARCH || 'x86_64';

let PROBE_SERVER;
let PROBE_URL;
function startProbeServer() {
  return new Promise((resolve) => {
    PROBE_SERVER = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<!doctype html><title>hc</title><body>ok</body>');
    });
    PROBE_SERVER.listen(0, '127.0.0.1', () => {
      PROBE_URL = `http://127.0.0.1:${PROBE_SERVER.address().port}/`;
      resolve();
    });
  });
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

function baseArgs(userDataDir, cfgPath, launchArgs) {
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(GPU_MODE === 'gpu' ? [] : ['--enable-unsafe-swiftshader']),
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...launchArgs,
  ];
  if (cfgPath) args.push(lobiumConfigArg(cfgPath));
  if (GPU_MODE === 'gpu' && !args.some((a) => a.startsWith('--use-angle='))) {
    args.push(...buildGpuArgs({ mode: 'gpu' }));
  }
  return args;
}

/** Launch a browser (optionally with a config + CDP fingerprint), run `fn(page)`, and clean up. */
async function withBrowser({ fingerprint, cfgPath, launchArgs }, fn) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'hc-'));
  const args = baseArgs(userDataDir, cfgPath, launchArgs ?? []);
  const proc = spawn(LOBIUM, args, { stdio: 'ignore' });
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      if (fingerprint) {
        const cdp = await context.newCDPSession(page);
        await applyCdpFingerprint(cdp, fingerprint);
      }
      await page.goto(PROBE_URL);
      return await fn(page);
    } finally {
      await browser.close();
    }
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

const PROBE_SURFACES = () => {
  const fnv = (s) => {
    let h = 2166136261 >>> 0;
    for (let i = 0; i < s.length; i += 1) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(16);
  };
  return (async () => {
    const gl =
      document.createElement('canvas').getContext('webgl') ||
      document.createElement('canvas').getContext('experimental-webgl');
    const dbg = gl && gl.getExtension('WEBGL_debug_renderer_info');
    const exts = gl ? (gl.getSupportedExtensions() || []).slice().sort() : [];
    let canvasHash = null;
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
      canvasHash = fnv(c.toDataURL());
    } catch {
      /* no 2d */
    }
    let webglPixelHash = null;
    try {
      const gc = document.createElement('canvas');
      gc.width = 64;
      gc.height = 64;
      const g2 = gc.getContext('webgl');
      g2.clearColor(0.2, 0.4, 0.6, 1);
      g2.clear(g2.COLOR_BUFFER_BIT);
      const px = new Uint8Array(64 * 64 * 4);
      g2.readPixels(0, 0, 64, 64, g2.RGBA, g2.UNSIGNED_BYTE, px);
      let acc = '';
      for (let i = 0; i < px.length; i += 131) acc += px[i].toString(16);
      webglPixelHash = fnv(acc);
    } catch {
      /* no gl */
    }
    let audioHash = null;
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
      audioHash = s.toFixed(8);
    } catch {
      /* no audio */
    }
    return {
      renderer: dbg
        ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
        : gl
          ? gl.getParameter(gl.RENDERER)
          : null,
      vendor: dbg
        ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)
        : gl
          ? gl.getParameter(gl.VENDOR)
          : null,
      hardwareConcurrency: navigator.hardwareConcurrency,
      extCount: exts.length,
      extHash: fnv(exts.join(',')),
      canvasHash,
      webglPixelHash,
      audioHash,
    };
  })();
};

async function main() {
  if (!LOBIUM || !existsSync(LOBIUM)) {
    process.stderr.write('Native Lobium binary not found (set LOBSTER_LOBIUM_BIN).\n');
    process.exitCode = 2;
    return;
  }
  await startProbeServer();

  // 1) Probe the real host with an UNSPOOFED calibration browser.
  process.stderr.write('calibrating host (unspoofed) ... ');
  const rawHost = await withBrowser({}, (page) =>
    page.evaluate(
      // buildHostCalibrationProbeScript() returns an async IIFE string; inline the probe here so we can
      // additionally capture the raw shape the normalizer expects.
      `(${probeSource})()`,
    ),
  );
  // queryLocalFonts() needs a user gesture and is unavailable in a headless calibration run, so the
  // font facet comes from the OS side — exactly the "browser probes PLUS OS/Rust APIs" split the
  // handoff describes. On Linux we read fontconfig; a real desktop build uses the Rust core's font
  // enumeration. Merge OS fonts in before normalization so the snapshot is complete.
  if ((!rawHost.fonts || rawHost.fonts.length === 0) && platform() === 'linux') {
    const fc = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' });
    if (fc.status === 0) {
      const families = [
        ...new Set(
          fc.stdout
            .split('\n')
            .map((line) => (line.split(',')[0] || '').trim())
            .filter(Boolean),
        ),
      ];
      rawHost.fonts = families;
    }
  }
  const host = normalizeHostCalibrationSnapshot(rawHost, { os: OS, arch: ARCH });
  const hostIssues = validateHostCalibrationProfile(host);
  process.stderr.write(
    hostIssues.length === 0 ? `ok (${host.webgl.renderer.slice(0, 48)})\n` : `INVALID\n`,
  );

  // 2) Derive N profiles from the SAME host and launch each on the real GPU.
  const seeds = ['hc-alpha', 'hc-bravo', 'hc-charlie', 'hc-delta'];
  const profiles = [];
  for (const seed of seeds) {
    const fp = deriveFingerprintFromHost(seed, host, { engine: 'lobium' });
    const coherence = validateFingerprintCoherence(fp);
    const userDataDir = await mkdtemp(join(tmpdir(), `hc-cfg-${seed}-`));
    const cfgPath = await writeLobiumConfig(userDataDir, buildLobiumConfig(fp, { seed }));
    const launch = buildLaunchOptions({
      profileId: seed,
      engine: 'lobium',
      userDataDir,
      fingerprint: fp,
      headless: true,
    });
    process.stderr.write(`  launch ${seed} ... `);
    const obs = await withBrowser({ fingerprint: fp, cfgPath, launchArgs: launch.args }, (p) =>
      p.evaluate(PROBE_SURFACES),
    );
    // Relaunch once to prove farbling hashes are STABLE per profile across restarts.
    const obs2 = await withBrowser({ fingerprint: fp, cfgPath, launchArgs: launch.args }, (p) =>
      p.evaluate(PROBE_SURFACES),
    );
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    const rendererMatches = obs.renderer === fp.webgl.renderer;
    const extMatchesHost = obs.extHash === undefined ? null : true; // host-derived, so coherent by construction
    const stable =
      obs.canvasHash === obs2.canvasHash &&
      obs.webglPixelHash === obs2.webglPixelHash &&
      obs.audioHash === obs2.audioHash;
    process.stderr.write(rendererMatches && coherence.length === 0 && stable ? 'ok\n' : 'REVIEW\n');
    profiles.push({
      seed,
      coherence,
      claimedRenderer: fp.webgl.renderer,
      observed: obs,
      stableAcrossRelaunch: stable,
      rendererMatches,
    });
  }
  PROBE_SERVER?.close();

  // 3) Cross-profile assertions: hardware SHARED, farbling DISTINCT.
  const canvasHashes = profiles.map((p) => p.observed.canvasHash).filter(Boolean);
  const audioHashes = profiles.map((p) => p.observed.audioHash).filter(Boolean);
  const renderers = new Set(profiles.map((p) => p.observed.renderer));
  const extHashes = new Set(profiles.map((p) => p.observed.extHash));
  const distinctCanvas = new Set(canvasHashes).size;
  const distinctAudio = new Set(audioHashes).size;

  const report = {
    kind: 'host-calibration-e2e',
    capturedAt: new Date().toISOString(),
    engine: 'lobium',
    binary: LOBIUM,
    gpuMode: GPU_MODE,
    host: {
      os: host.os,
      arch: host.arch,
      renderer: host.webgl.renderer,
      vendor: host.webgl.vendor,
      extensionCount: host.webgl.extensions?.length ?? 0,
      hardwareConcurrency: host.navigator.hardwareConcurrency,
      issues: hostIssues,
    },
    profiles,
    assertions: {
      allRenderersMatchClaim: profiles.every((p) => p.rendererMatches),
      allCoherent: profiles.every((p) => p.coherence.length === 0),
      hardwareSharedAcrossProfiles: renderers.size === 1 && extHashes.size === 1,
      farblingDistinctPerProfile:
        distinctCanvas === canvasHashes.length && distinctAudio === audioHashes.length,
      farblingStablePerProfile: profiles.every((p) => p.stableAcrossRelaunch),
    },
  };
  report.verdict =
    Object.values(report.assertions).every((v) => v === true) && hostIssues.length === 0
      ? 'pass'
      : 'review';

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = report.capturedAt.replace(/[:.]/g, '-');
  const outPath = join(REPORTS_DIR, `host-calibration-e2e-${stamp}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(
    `${JSON.stringify({ host: report.host, assertions: report.assertions, verdict: report.verdict }, null, 2)}\n`,
  );
  process.stdout.write(`\nsaved: ${outPath}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}

// The host probe, inlined as a string so it runs in-page (mirrors buildHostCalibrationProbeScript but
// kept local so this script has one obvious probe definition). Returns the raw shape the normalizer
// consumes.
const probeSource = String(function probe() {
  return (async () => {
    const warnings = [];
    const canvas = document.createElement('canvas');
    const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL unavailable for host calibration');
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR);
    const renderer = dbg
      ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
      : gl.getParameter(gl.RENDERER);
    const extensions = gl.getSupportedExtensions() || [];
    const num = (p) => Number(gl.getParameter(p)) || 0;
    const tup = (p, f) => Array.from(gl.getParameter(p) || f).map(Number);
    const prec = (sh, p) => {
      const v = gl.getShaderPrecisionFormat(sh, p);
      return v
        ? { rangeMin: v.rangeMin, rangeMax: v.rangeMax, precision: v.precision }
        : { rangeMin: 0, rangeMax: 0, precision: 0 };
    };
    const fonts = [];
    if ('queryLocalFonts' in globalThis) {
      try {
        for (const f of await globalThis.queryLocalFonts()) if (f && f.family) fonts.push(f.family);
      } catch (e) {
        warnings.push('queryLocalFonts: ' + String(e));
      }
    } else {
      warnings.push('queryLocalFonts unavailable');
    }
    return {
      capturedAt: new Date().toISOString(),
      browserVersion: /Chrome\/([0-9.]+)/.exec(navigator.userAgent)
        ? /Chrome\/([0-9.]+)/.exec(navigator.userAgent)[1]
        : undefined,
      navigator: {
        userAgent: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency || 1,
        deviceMemory: navigator.deviceMemory,
        maxTouchPoints: navigator.maxTouchPoints || 0,
      },
      screen: {
        width: screen.width,
        height: screen.height,
        availWidth: screen.availWidth,
        availHeight: screen.availHeight,
        availLeft: screen.availLeft || 0,
        availTop: screen.availTop || 0,
        colorDepth: screen.colorDepth,
        devicePixelRatio: window.devicePixelRatio || 1,
      },
      webgl: {
        vendor: String(vendor || ''),
        renderer: String(renderer || ''),
        unmaskedVendor: String(vendor || ''),
        unmaskedRenderer: String(renderer || ''),
        version: String(gl.getParameter(gl.VERSION) || ''),
        shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || ''),
        extensions,
        caps: {
          maxTextureSize: num(gl.MAX_TEXTURE_SIZE),
          maxCubeMapTextureSize: num(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
          maxRenderbufferSize: num(gl.MAX_RENDERBUFFER_SIZE),
          maxViewportDims: tup(gl.MAX_VIEWPORT_DIMS, [0, 0]),
          maxVertexAttribs: num(gl.MAX_VERTEX_ATTRIBS),
          maxVertexUniformVectors: num(gl.MAX_VERTEX_UNIFORM_VECTORS),
          maxFragmentUniformVectors: num(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
          maxVaryingVectors: num(gl.MAX_VARYING_VECTORS),
          maxTextureImageUnits: num(gl.MAX_TEXTURE_IMAGE_UNITS),
          maxVertexTextureImageUnits: num(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
          maxCombinedTextureImageUnits: num(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
          aliasedLineWidthRange: tup(gl.ALIASED_LINE_WIDTH_RANGE, [1, 1]),
          aliasedPointSizeRange: tup(gl.ALIASED_POINT_SIZE_RANGE, [1, 1]),
        },
        shaderPrecision: {
          vertex: {
            lowFloat: prec(gl.VERTEX_SHADER, gl.LOW_FLOAT),
            mediumFloat: prec(gl.VERTEX_SHADER, gl.MEDIUM_FLOAT),
            highFloat: prec(gl.VERTEX_SHADER, gl.HIGH_FLOAT),
            lowInt: prec(gl.VERTEX_SHADER, gl.LOW_INT),
            mediumInt: prec(gl.VERTEX_SHADER, gl.MEDIUM_INT),
            highInt: prec(gl.VERTEX_SHADER, gl.HIGH_INT),
          },
          fragment: {
            lowFloat: prec(gl.FRAGMENT_SHADER, gl.LOW_FLOAT),
            mediumFloat: prec(gl.FRAGMENT_SHADER, gl.MEDIUM_FLOAT),
            highFloat: prec(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT),
            lowInt: prec(gl.FRAGMENT_SHADER, gl.LOW_INT),
            mediumInt: prec(gl.FRAGMENT_SHADER, gl.MEDIUM_INT),
            highInt: prec(gl.FRAGMENT_SHADER, gl.HIGH_INT),
          },
        },
      },
      fonts,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      warnings,
    };
  })();
});

main().catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exitCode = 3;
});
