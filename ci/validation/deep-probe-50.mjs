#!/usr/bin/env node
// PURE-NATIVE 50-profile deep fingerprint probe. No CDP fingerprint overlay (exactly what real
// Lobium profiles get from --lobium-fp-config). Serves a comprehensive probe on a loopback secure
// origin, launches 50 diverse personas, extracts window.__FP, and writes one JSON for analysis.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyGeoToFingerprint, deriveAndroidFingerprint, deriveFingerprint } from '@lobster/fingerprint';
import {
  buildAndroidLobiumConfig, buildDevShmArgs, buildLaunchOptions, buildLobiumConfig,
  lobiumConfigArg, resolveGpuMode, resolveLobiumBinary, writeLobiumConfig,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const LOBIUM = resolveLobiumBinary();
const GPU_MODE = resolveGpuMode();
// Resolved against this file, never an absolute developer path: the probe used to be read from a
// scratch directory that existed on exactly one machine, so this script threw ENOENT at module load
// everywhere else while the docs listed it as part of the gate that "runs anywhere".
const PROBE_HTML = await readFile(join(here, 'fixtures', 'fp-probe.html'), 'utf8');

const GEOS = {
  US: { ip: '0.0.0.0', countryCode: 'US', timezone: 'America/New_York', latitude: 40.71, longitude: -74.0 },
  DE: { ip: '0.0.0.0', countryCode: 'DE', timezone: 'Europe/Berlin', latitude: 52.52, longitude: 13.4 },
  JP: { ip: '0.0.0.0', countryCode: 'JP', timezone: 'Asia/Tokyo', latitude: 35.68, longitude: 139.69 },
  GB: { ip: '0.0.0.0', countryCode: 'GB', timezone: 'Europe/London', latitude: 51.5, longitude: -0.12 },
  BR: { ip: '0.0.0.0', countryCode: 'BR', timezone: 'America/Sao_Paulo', latitude: -23.55, longitude: -46.63 },
  AU: { ip: '0.0.0.0', countryCode: 'AU', timezone: 'Australia/Sydney', latitude: -33.87, longitude: 151.2 },
};
const geoKeys = Object.keys(GEOS);

// Build 50 personas with DISTINCT full fingerprints (distinct seeds → distinct farbling/canvas/audio),
// spread across OS + geo. Device classes may repeat (the catalog has a finite set); the analysis reports
// how many DISTINCT device classes those 50 cover.
function buildPersonas() {
  const out = [];
  const plan = [{ os: 'windows', n: 15 }, { os: 'macos', n: 14 }, { os: 'linux', n: 11 }];
  let gi = 0;
  for (const { os, n } of plan) {
    for (let i = 0; i < n; i++) {
      const seed = `deep-${os}-${i}`;
      const fp = deriveFingerprint(seed, { os, engine: 'lobium' });
      const geo = GEOS[geoKeys[gi++ % geoKeys.length]];
      out.push({ os, seed, geo: geo.countryCode, fingerprint: applyGeoToFingerprint(fp, geo), android: false });
    }
  }
  for (let i = 0; i < 10; i++) {
    const seed = `deep-android-${i}`;
    const fp = deriveAndroidFingerprint(seed, { engine: 'lobium' });
    const geo = GEOS[geoKeys[gi++ % geoKeys.length]];
    out.push({ os: 'android', seed, geo: geo.countryCode, fingerprint: applyGeoToFingerprint(fp, geo), android: true });
  }
  return out;
}

function startProbeServer() {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end(PROBE_HTML); });
    srv.listen(0, '127.0.0.1', () => resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }));
  });
}

async function readCdpEndpoint(userDataDir, retries = 200) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < retries; i++) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine) return `ws://127.0.0.1:${port}${pathLine.trim()}`;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no CDP endpoint');
}

async function runPersona(persona, probeUrl) {
  const fp = persona.fingerprint;
  const userDataDir = await mkdtemp(join(tmpdir(), `deep-${persona.os}-`));
  const cfg = persona.android
    ? buildAndroidLobiumConfig(fp, { seed: persona.seed })
    : buildLobiumConfig(fp, { seed: persona.seed });
  const cfgPath = await writeLobiumConfig(userDataDir, cfg);
  const launch = buildLaunchOptions({ profileId: `deep-${persona.os}`, engine: 'lobium', userDataDir, fingerprint: fp, headless: true });
  const args = [
    '--headless=new', '--no-sandbox', ...buildDevShmArgs(),
    ...(GPU_MODE === 'gpu' ? [] : ['--enable-unsafe-swiftshader']),
    `--user-data-dir=${userDataDir}`, lobiumConfigArg(cfgPath),
    '--remote-debugging-port=0', '--no-first-run', '--no-default-browser-check', ...launch.args,
  ];
  // Faithfully replicate the sidecar's child env: Chromium's native timezone/locale come from the
  // process environment on desktop Linux (lobium-launcher sets TZ/LANG/LC_ALL/FC_LANG per persona).
  const localeUnix = `${fp.locale.locale.replaceAll('-', '_')}.UTF-8`;
  const childEnv = {
    ...process.env,
    TZ: fp.locale.timezone,
    LANG: localeUnix,
    LC_ALL: localeUnix,
    FC_LANG: fp.locale.locale,
  };
  const proc = spawn(LOBIUM, args, { stdio: 'ignore', env: childEnv });
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      // PURE NATIVE: intentionally NO applyCdpFingerprint here.
      await page.goto(probeUrl, { waitUntil: 'domcontentloaded' });
      // wait for the probe to finish (title flips to FP_READY)
      for (let i = 0; i < 100; i++) {
        const t = await page.title().catch(() => '');
        if (t === 'FP_READY') break;
        await new Promise((r) => setTimeout(r, 150));
      }
      // Read from the DOM (isolated-world safe): the probe serializes the readout into #out.textContent.
      const raw = await page.evaluate(() => document.getElementById('out')?.textContent || '');
      const data = raw && raw !== 'FP_READY' ? JSON.parse(raw) : null;
      return { intended: intendedSummary(fp), observed: data };
    } finally { await browser.close(); }
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 200));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}

function intendedSummary(fp) {
  return {
    userAgent: fp.navigator.userAgent, platform: fp.navigator.platform,
    hardwareConcurrency: fp.navigator.hardwareConcurrency, deviceMemory: fp.navigator.deviceMemory,
    maxTouchPoints: fp.navigator.maxTouchPoints, languages: fp.navigator.languages,
    screen: { width: fp.screen.width, height: fp.screen.height, dpr: fp.screen.devicePixelRatio, colorDepth: fp.screen.colorDepth },
    webglUnmaskedRenderer: fp.webgl.unmaskedRenderer, webglUnmaskedVendor: fp.webgl.unmaskedVendor,
    timezone: fp.locale.timezone, locale: fp.locale.locale, os: fp.os, arch: fp.arch,
  };
}

async function main() {
  let personas = buildPersonas();
  // Optional: run a small representative subset (one per geo) for a fast confirmation.
  if (process.env.LIMIT === 'geo') {
    const byGeo = new Map();
    for (const p of personas) if (!byGeo.has(p.geo)) byGeo.set(p.geo, p);
    personas = [...byGeo.values()];
  } else if (process.env.LIMIT) {
    personas = personas.slice(0, Number(process.env.LIMIT));
  }
  const { srv, url } = await startProbeServer();
  const results = [];
  console.error(`launching ${personas.length} personas (pure-native, ${GPU_MODE} gpu)…`);
  for (let i = 0; i < personas.length; i++) {
    const p = personas[i];
    process.stderr.write(`[${i + 1}/${personas.length}] ${p.os} ${p.seed} ${p.geo} … `);
    try {
      const r = await runPersona(p, url);
      results.push({ os: p.os, seed: p.seed, geo: p.geo, ...r });
      process.stderr.write('ok\n');
    } catch (e) {
      results.push({ os: p.os, seed: p.seed, geo: p.geo, error: String(e && e.message || e) });
      process.stderr.write('ERR ' + (e && e.message) + '\n');
    }
  }
  srv.close();
  const outPath = join(here, 'reports', `deep-probe-50-${Date.now()}.json`);
  await writeFile(outPath, JSON.stringify({ kind: 'deep-probe-50', gpuMode: GPU_MODE, binary: LOBIUM, count: results.length, results }, null, 2));
  console.log('SAVED ' + outPath);
}
main().catch((e) => { console.error(e); process.exit(1); });
