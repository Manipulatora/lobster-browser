#!/usr/bin/env node
/**
 * CreepJS real-battle matrix against native Lobium (100+ situations).
 *
 * Criteria: CreepJS `window.Fingerprint` — totalLies, lie keys, headless/stealth ratings.
 * Launches the rebuilt Lobium binary with the native config channel (no Patchright production path).
 *
 *   LOBSTER_LOBIUM_BIN=/path/to/chrome node ci/validation/creepjs-battle.mjs
 *   LOBSTER_CREEPJS_LIMIT=120 LOBSTER_CREEPJS_CONCURRENCY=1 ...
 *
 * On software-GPU hosts (this build VPS), personas that claim a discrete NVIDIA/AMD/Apple GPU will
 * still mismatch pixel/capability reality; we attach captured HOST deep WebGL (version/extensions/
 * precision) via HC-4 so those surfaces are coherent, and we still score every CreepJS lie.
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { spawnSync } from 'node:child_process';
import { platform as nodePlatform } from 'node:os';

import {
  applyGeoToFingerprint,
  deriveFingerprint,
  deriveFingerprintFromHost,
  validateFingerprintCoherence,
} from '@lobster/fingerprint';
import {
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
const LOBIUM = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
const GPU_MODE = resolveGpuMode();
const LIMIT = Number(process.env.LOBSTER_CREEPJS_LIMIT || 120);
const CREEPJS_URL = process.env.LOBSTER_CREEPJS_URL || 'https://abrahamjuliot.github.io/creepjs/';
const WAIT_ROUNDS = Number(process.env.LOBSTER_CREEPJS_WAIT_ROUNDS || 25);
const WAIT_MS = Number(process.env.LOBSTER_CREEPJS_WAIT_MS || 2000);

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
  BR: {
    ip: '0.0.0.0',
    countryCode: 'BR',
    timezone: 'America/Sao_Paulo',
    latitude: -23.55,
    longitude: -46.63,
  },
  GB: {
    ip: '0.0.0.0',
    countryCode: 'GB',
    timezone: 'Europe/London',
    latitude: 51.5,
    longitude: -0.12,
  },
  AU: {
    ip: '0.0.0.0',
    countryCode: 'AU',
    timezone: 'Australia/Sydney',
    latitude: -33.87,
    longitude: 151.21,
  },
  IN: {
    ip: '0.0.0.0',
    countryCode: 'IN',
    timezone: 'Asia/Kolkata',
    latitude: 28.61,
    longitude: 77.21,
  },
  SG: {
    ip: '0.0.0.0',
    countryCode: 'SG',
    timezone: 'Asia/Singapore',
    latitude: 1.35,
    longitude: 103.82,
  },
};

const NOISE_VARIANTS = [
  { id: 'noise-all', hardwareNoise: { webgl: true, canvas: true, audio: true, clientRects: true } },
  {
    id: 'noise-default',
    hardwareNoise: { webgl: true, canvas: true, audio: true, clientRects: false },
  },
  {
    id: 'noise-canvas-off',
    hardwareNoise: { webgl: true, canvas: false, audio: true, clientRects: false },
  },
  {
    id: 'noise-minimal',
    hardwareNoise: { webgl: false, canvas: false, audio: false, clientRects: false },
  },
];

const MEDIA_VARIANTS = [
  {
    id: 'media-default',
    mediaDevices: { cameras: 1, microphones: 1, speakers: 2, stableDeviceIds: true },
  },
  {
    id: 'media-rich',
    mediaDevices: { cameras: 2, microphones: 2, speakers: 4, stableDeviceIds: true },
  },
  {
    id: 'media-sparse',
    mediaDevices: { cameras: 0, microphones: 1, speakers: 1, stableDeviceIds: true },
  },
];

function attachHostDeepWebgl(fp, host) {
  if (!host?.webgl) return fp;
  const webgl = { ...fp.webgl };
  if (host.webgl.version) webgl.version = host.webgl.version;
  if (host.webgl.shadingLanguageVersion) {
    webgl.shadingLanguageVersion = host.webgl.shadingLanguageVersion;
  }
  if (host.webgl.extensions?.length) webgl.extensions = [...host.webgl.extensions];
  if (host.webgl.shaderPrecision) {
    webgl.shaderPrecision = structuredClone(host.webgl.shaderPrecision);
  }
  // Keep claimed unmasked strings; deep surfaces come from host so HC-4 closes the extension leak.
  return { ...fp, webgl };
}

/** Build ≥100 situations: OS × seed × geo × noise × media × (catalog | host-calibrated). */
function buildSituations(host) {
  const situations = [];
  const geos = Object.entries(GEOS);
  const osList = ['windows', 'macos', 'linux'];
  let n = 0;
  // Catalog personas — many seeds per OS for diversity.
  for (const os of osList) {
    for (let i = 0; i < 80 && situations.length < LIMIT; i += 1) {
      const seed = `creep-${os}-${i}`;
      let fp = deriveFingerprint(seed, { os, engine: 'lobium' });
      const [geoKey, geo] = geos[n % geos.length];
      fp = applyGeoToFingerprint(fp, geo);
      fp = attachHostDeepWebgl(fp, host);
      const noise = NOISE_VARIANTS[n % NOISE_VARIANTS.length];
      const media = MEDIA_VARIANTS[n % MEDIA_VARIANTS.length];
      const issues = validateFingerprintCoherence(fp);
      situations.push({
        id: `catalog-${os}-${i}-${geoKey}-${noise.id}-${media.id}`,
        mode: 'catalog',
        os,
        seed,
        geoKey,
        noise,
        media,
        fingerprint: fp,
        staticIssues: issues,
      });
      n += 1;
    }
  }
  // Host-calibrated situations — inherit real GPU identity (including software on this build VPS).
  // Product validateHostCalibrationProfile rejects SwiftShader; for CreepJS battle we still want the
  // host-matched path so lies reflect spoof bugs, not "claimed RTX on SwiftShader".
  if (host) {
    for (let i = 0; i < 40 && situations.length < LIMIT; i += 1) {
      const seed = `creep-host-${i}`;
      const [geoKey, geo] = geos[i % geos.length];
      let fp = deriveFingerprintFromHost(seed, host, { engine: 'lobium' });
      fp = applyGeoToFingerprint(fp, geo);
      const noise = NOISE_VARIANTS[i % NOISE_VARIANTS.length];
      const media = MEDIA_VARIANTS[i % MEDIA_VARIANTS.length];
      situations.push({
        id: `host-${host.os}-${i}-${geoKey}-${noise.id}-${media.id}`,
        mode: 'host-calibrated',
        os: host.os,
        seed,
        geoKey,
        noise,
        media,
        fingerprint: fp,
        staticIssues: validateFingerprintCoherence(fp),
      });
    }
  }
  return situations.slice(0, LIMIT);
}

async function readCdpEndpoint(userDataDir, retries = 200) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < retries; i += 1) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine) {
        return `ws://127.0.0.1:${port}${pathLine.trim()}`;
      }
    } catch {
      /* not ready */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for Lobium CDP');
}

async function scrapeCreepjs(page, cdp) {
  let best = {
    available: false,
    lies: null,
    lieItems: [],
    lieData: {},
    headless: null,
    workerScope: null,
    iframeScope: null,
    resistance: null,
    notes: [],
  };
  for (let i = 0; i < WAIT_ROUNDS; i += 1) {
    await new Promise((r) => setTimeout(r, WAIT_MS));
    const { result } = await cdp
      .send('Runtime.evaluate', {
        expression: `(() => {
          const fp = window.Fingerprint;
          if (!fp) return { ready: false };
          return {
            ready: true,
            lies: fp.lies?.totalLies ?? null,
            lieItems: Object.keys(fp.lies?.data || {}),
            lieData: fp.lies?.data || {},
            headless: {
              headlessRating: fp.headless?.headlessRating ?? null,
              likeHeadlessRating: fp.headless?.likeHeadlessRating ?? null,
              stealthRating: fp.headless?.stealthRating ?? null,
              platformEstimate: fp.headless?.platformEstimate ?? null,
            },
            workerScope: fp.workerScope ? {
              lies: fp.workerScope.lies ?? null,
              userAgent: fp.workerScope.userAgent ?? null,
              platform: fp.workerScope.platform ?? null,
            } : null,
            iframeScope: fp.iframeScope ? { lies: fp.iframeScope.lies ?? null } : null,
            resistance: fp.resistance ? {
              privacy: fp.resistance.privacy ?? null,
              security: fp.resistance.security ?? null,
              mode: fp.resistance.mode ?? null,
            } : null,
            canvas2d: fp.canvas2d ? { dataURI: !!fp.canvas2d.dataURI, lied: fp.canvas2d.lied } : null,
            webgl: fp.webgl ? {
              renderer: fp.webgl.rendererUnmasked || fp.webgl.renderer,
              vendor: fp.webgl.vendorUnmasked || fp.webgl.vendor,
              lied: fp.webgl.lied,
            } : null,
            screen: fp.screen ? { width: fp.screen.width, height: fp.screen.height, lied: fp.screen.lied } : null,
            timezone: fp.timezone?.zone ?? null,
          };
        })()`,
        returnByValue: true,
      })
      .catch(() => ({ result: { value: null } }));
    const v = result?.value;
    if (v?.ready) {
      best = { available: true, ...v };
      if (typeof v.lies === 'number') break;
    }
  }
  // DOM fallback for lie count text
  if (best.lies === null) {
    const dom = await page
      .evaluate(() => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const lies = /lies?\s*\((\d+)\)/i.exec(text) || /(\d+)\s*lies\b/i.exec(text);
        return { lies: lies ? Number(lies[1]) : null, sample: text.slice(0, 400) };
      })
      .catch(() => ({ lies: null }));
    if (dom.lies !== null) {
      best.lies = dom.lies;
      best.available = true;
    }
  }
  return best;
}

async function runSituation(sit) {
  const fp = sit.fingerprint;
  const userDataDir = await mkdtemp(join(tmpdir(), 'creep-battle-'));
  const cfg = buildLobiumConfig(fp, {
    seed: sit.seed,
    hardwareNoise: sit.noise.hardwareNoise,
    mediaDevices: sit.media.mediaDevices,
  });
  const cfgPath = await writeLobiumConfig(userDataDir, cfg);
  const launch = buildLaunchOptions({
    profileId: `creep-${sit.id}`,
    engine: 'lobium',
    userDataDir,
    fingerprint: fp,
    headless: true,
  });
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // Never force SwiftShader during an explicit real-GPU run. The strict gate checks the host probe,
    // but the detector situations themselves must also exercise the physical driver; otherwise a
    // real-GPU label can hide 120 software-rendered situations.
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
  // Pure native, exactly as shipped: timezone/locale come from the child env; every fingerprint
  // surface is applied by the engine from --lobium-fp-config. No CDP overlay — patchright only
  // drives/reads CreepJS.
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
      const cdp = await context.newCDPSession(page);
      await page.goto(CREEPJS_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
      const creep = await scrapeCreepjs(page, cdp);
      const pass =
        creep.available &&
        typeof creep.lies === 'number' &&
        creep.lies === 0 &&
        sit.staticIssues.length === 0;
      return {
        id: sit.id,
        mode: sit.mode,
        os: sit.os,
        seed: sit.seed,
        geo: sit.geoKey,
        noise: sit.noise.id,
        media: sit.media.id,
        claimedRenderer: fp.webgl.unmaskedRenderer || fp.webgl.renderer,
        softwareFallbackForced: args.includes('--enable-unsafe-swiftshader'),
        staticIssues: sit.staticIssues,
        creep,
        verdict: pass ? 'pass' : creep.available ? 'fail' : 'unavailable',
      };
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

function aggregateLies(results) {
  const counts = new Map();
  for (const r of results) {
    for (const key of r.creep?.lieItems || []) {
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([lie, count]) => ({ lie, count, rate: count / Math.max(1, results.length) }));
}

async function captureHost() {
  // Unspoofed Lobium probe — captures deep WebGL for HC-4 attachment. Allows software GPUs here
  // (this build VPS has no NVIDIA); product host-calibration still rejects them for shipping.
  const userDataDir = await mkdtemp(join(tmpdir(), 'creep-host-'));
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    // The host snapshot is the gate's hardware evidence. Forcing SwiftShader here made an explicit
    // `LOBSTER_GPU=gpu` run fail (or, worse, tempted readers to trust the spoofed persona renderer).
    ...(GPU_MODE === 'gpu' ? [] : ['--enable-unsafe-swiftshader']),
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
  ];
  const proc = spawn(LOBIUM, args, { stdio: 'ignore' });
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      // Secure loopback so deviceMemory etc. exist.
      const server = createServer((_req, res) => {
        res.writeHead(200, { 'content-type': 'text/html' });
        res.end('<!doctype html><title>h</title>');
      });
      await new Promise((r) => server.listen(0, '127.0.0.1', r));
      const url = `http://127.0.0.1:${server.address().port}/`;
      await page.goto(url);
      const raw = await page.evaluate(async () => {
        const warnings = [];
        const nav = {
          userAgent: navigator.userAgent,
          platform: navigator.platform,
          hardwareConcurrency: navigator.hardwareConcurrency,
          deviceMemory: navigator.deviceMemory,
          maxTouchPoints: navigator.maxTouchPoints,
        };
        const screenFp = {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          availLeft: screen.availLeft || 0,
          availTop: screen.availTop || 0,
          colorDepth: screen.colorDepth,
          devicePixelRatio: window.devicePixelRatio,
        };
        const canvas = document.createElement('canvas');
        const gl = canvas.getContext('webgl') || canvas.getContext('experimental-webgl');
        let webgl = {
          vendor: 'unknown',
          renderer: 'unknown',
          unmaskedVendor: 'unknown',
          unmaskedRenderer: 'unknown',
        };
        if (gl) {
          const dbg = gl.getExtension('WEBGL_debug_renderer_info');
          const vendor = dbg
            ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)
            : gl.getParameter(gl.VENDOR);
          const renderer = dbg
            ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)
            : gl.getParameter(gl.RENDERER);
          const readPrec = (shader, prec) => {
            const f = gl.getShaderPrecisionFormat(shader, prec);
            return { rangeMin: f.rangeMin, rangeMax: f.rangeMax, precision: f.precision };
          };
          const stage = (shader) => ({
            lowFloat: readPrec(shader, gl.LOW_FLOAT),
            mediumFloat: readPrec(shader, gl.MEDIUM_FLOAT),
            highFloat: readPrec(shader, gl.HIGH_FLOAT),
            lowInt: readPrec(shader, gl.LOW_INT),
            mediumInt: readPrec(shader, gl.MEDIUM_INT),
            highInt: readPrec(shader, gl.HIGH_INT),
          });
          webgl = {
            vendor: String(gl.getParameter(gl.VENDOR) || vendor),
            renderer: String(gl.getParameter(gl.RENDERER) || renderer),
            unmaskedVendor: String(vendor),
            unmaskedRenderer: String(renderer),
            version: String(gl.getParameter(gl.VERSION) || ''),
            shadingLanguageVersion: String(gl.getParameter(gl.SHADING_LANGUAGE_VERSION) || ''),
            extensions: (gl.getSupportedExtensions() || []).slice().sort(),
            shaderPrecision: {
              vertex: stage(gl.VERTEX_SHADER),
              fragment: stage(gl.FRAGMENT_SHADER),
            },
            caps: {
              maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
              maxCubeMapTextureSize: gl.getParameter(gl.MAX_CUBE_MAP_TEXTURE_SIZE),
              maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
              maxViewportDims: Array.from(gl.getParameter(gl.MAX_VIEWPORT_DIMS) || [0, 0]),
              maxVertexAttribs: gl.getParameter(gl.MAX_VERTEX_ATTRIBS),
              maxVertexUniformVectors: gl.getParameter(gl.MAX_VERTEX_UNIFORM_VECTORS),
              maxFragmentUniformVectors: gl.getParameter(gl.MAX_FRAGMENT_UNIFORM_VECTORS),
              maxVaryingVectors: gl.getParameter(gl.MAX_VARYING_VECTORS),
              maxTextureImageUnits: gl.getParameter(gl.MAX_TEXTURE_IMAGE_UNITS),
              maxVertexTextureImageUnits: gl.getParameter(gl.MAX_VERTEX_TEXTURE_IMAGE_UNITS),
              maxCombinedTextureImageUnits: gl.getParameter(gl.MAX_COMBINED_TEXTURE_IMAGE_UNITS),
              aliasedLineWidthRange: Array.from(
                gl.getParameter(gl.ALIASED_LINE_WIDTH_RANGE) || [0, 0],
              ),
              aliasedPointSizeRange: Array.from(
                gl.getParameter(gl.ALIASED_POINT_SIZE_RANGE) || [0, 0],
              ),
            },
          };
        } else {
          warnings.push('no webgl');
        }
        let fonts = [];
        try {
          if (queryLocalFonts) {
            const local = await queryLocalFonts();
            fonts = [...new Set(local.map((f) => f.family))].sort();
          }
        } catch {
          warnings.push('queryLocalFonts unavailable');
        }
        return {
          capturedAt: new Date().toISOString(),
          navigator: nav,
          screen: screenFp,
          webgl,
          fonts,
          timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          warnings,
        };
      });
      server.close();
      if ((!raw.fonts || raw.fonts.length === 0) && nodePlatform() === 'linux') {
        const fc = spawnSync('fc-list', [':', 'family'], { encoding: 'utf8' });
        if (fc.status === 0) {
          raw.fonts = [
            ...new Set(
              fc.stdout
                .split('\n')
                .map((line) => (line.split(',')[0] || '').trim())
                .filter(Boolean),
            ),
          ];
        }
      }
      const profile = normalizeHostCalibrationSnapshot(raw, {
        os: 'linux',
        arch: 'x86_64',
      });
      return {
        profile,
        issues: [],
        source: 'lobium-unspoofed',
        softwareFallbackForced: args.includes('--enable-unsafe-swiftshader'),
      };
    } finally {
      await browser.close().catch(() => {});
    }
  } catch (e) {
    return { profile: null, issues: [String(e)], source: 'probe-failed' };
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

async function main() {
  if (!LOBIUM || !existsSync(LOBIUM)) {
    process.stderr.write('Native Lobium binary not found (set LOBSTER_LOBIUM_BIN).\n');
    process.exitCode = 2;
    return;
  }
  process.stderr.write(`CreepJS battle: binary=${LOBIUM} limit=${LIMIT} gpuMode=${GPU_MODE}\n`);
  process.stderr.write('Capturing host calibration for HC-4 deep surfaces...\n');
  const hostInfo = await captureHost();
  if (hostInfo.profile) {
    process.stderr.write(
      `  host os=${hostInfo.profile.os} renderer=${hostInfo.profile.webgl?.unmaskedRenderer || hostInfo.profile.webgl?.renderer}\n`,
    );
  } else {
    process.stderr.write(`  host probe: ${hostInfo.source} ${hostInfo.issues.join('; ')}\n`);
  }

  const situations = buildSituations(hostInfo.profile);
  process.stderr.write(`Situations: ${situations.length}\n`);

  const results = [];
  for (let i = 0; i < situations.length; i += 1) {
    const sit = situations[i];
    process.stderr.write(`[${i + 1}/${situations.length}] ${sit.id} ... `);
    try {
      const r = await runSituation(sit);
      results.push(r);
      const lieN = r.creep?.lies;
      process.stderr.write(
        `${r.verdict}${typeof lieN === 'number' ? ` lies=${lieN}` : ''} ${(r.creep?.lieItems || []).slice(0, 4).join(',')}\n`,
      );
    } catch (e) {
      process.stderr.write(`ERROR ${String(e).slice(0, 100)}\n`);
      results.push({
        id: sit.id,
        mode: sit.mode,
        os: sit.os,
        seed: sit.seed,
        error: String(e).slice(0, 300),
        verdict: 'error',
      });
    }
    // Checkpoint every 10
    if ((i + 1) % 10 === 0) {
      await mkdir(REPORTS_DIR, { recursive: true });
      await writeFile(
        join(REPORTS_DIR, 'creepjs-battle-partial.json'),
        JSON.stringify({ at: new Date().toISOString(), done: i + 1, results }, null, 2),
      );
    }
  }

  const scored = results.filter((r) => r.verdict === 'pass' || r.verdict === 'fail');
  const lieFreq = aggregateLies(scored);
  const report = {
    schemaVersion: 1,
    kind: 'creepjs-battle',
    capturedAt: new Date().toISOString(),
    binary: LOBIUM,
    gpuMode: GPU_MODE,
    headless: true,
    creepjsUrl: CREEPJS_URL,
    host: hostInfo.profile
      ? {
          os: hostInfo.profile.os,
          arch: hostInfo.profile.arch,
          renderer: hostInfo.profile.webgl?.unmaskedRenderer || hostInfo.profile.webgl?.renderer,
          extCount: hostInfo.profile.webgl?.extensions?.length ?? 0,
          source: hostInfo.source,
          softwareFallbackForced: hostInfo.softwareFallbackForced,
        }
      : { source: hostInfo.source, issues: hostInfo.issues },
    counts: {
      situations: situations.length,
      pass: results.filter((r) => r.verdict === 'pass').length,
      fail: results.filter((r) => r.verdict === 'fail').length,
      unavailable: results.filter((r) => r.verdict === 'unavailable').length,
      error: results.filter((r) => r.verdict === 'error').length,
      zeroLies: scored.filter((r) => r.creep?.lies === 0).length,
      meanLies:
        scored.length === 0
          ? null
          : scored.reduce((s, r) => s + (r.creep?.lies || 0), 0) / scored.length,
    },
    topLies: lieFreq.slice(0, 40),
    results,
  };

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outPath = join(REPORTS_DIR, `creepjs-battle-${stamp}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(
    join(REPORTS_DIR, 'creepjs-battle-latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  process.stdout.write(
    JSON.stringify(
      {
        outPath,
        counts: report.counts,
        topLies: report.topLies.slice(0, 15),
        host: report.host,
      },
      null,
      2,
    ) + '\n',
  );
  process.exitCode = report.counts.fail + report.counts.error > 0 ? 1 : 0;
}

main().catch((e) => {
  process.stderr.write(String(e) + '\n');
  process.exitCode = 2;
});
