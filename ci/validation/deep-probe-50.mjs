#!/usr/bin/env node
// PURE-NATIVE 50-profile deep fingerprint probe. No CDP fingerprint overlay (exactly what real
// Lobium profiles get from --lobium-fp-config). Serves a comprehensive probe on a loopback secure
// origin, launches 50 diverse personas, extracts window.__FP, and writes one JSON for analysis.
import { createServer } from 'node:http';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';


/**
 * Navigate, tolerating the browser finishing its OWN startup navigation first.
 *
 * The engine is launched with `about:blank`, but Chromium can still navigate to
 * `chrome://new-tab-page/` shortly AFTER the first page target appears. A goto issued the moment the
 * target exists then dies with "interrupted by another navigation to chrome://new-tab-page/".
 * Measured: 3 of 38 persona launches (~8%) across windows/macos, and it is what makes
 * gpu-baseline.mjs exit 3 intermittently. The interruption is the browser settling, not a failure of
 * the navigation we asked for, so retry it rather than scoring the persona as broken.
 */
async function gotoSettled(page, url, opts) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await page.goto(url, opts);
    } catch (err) {
      lastError = err;
      if (!/interrupted by another navigation/i.test(String(err && err.message))) throw err;
      await new Promise((resolve) => setTimeout(resolve, 300));
    }
  }
  throw lastError;
}

import {
  applyGeoToFingerprint,
  deriveAndroidFingerprint,
  deriveFingerprint,
} from '@lobster/fingerprint';
import { resolveGpuMode, resolveLobiumBinary } from '@lobster/engine-runner';
import { launchNativePersona } from './e2e/native-lobium.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const LOBIUM = resolveLobiumBinary();
const GPU_MODE = resolveGpuMode();
// Resolved against this file, never an absolute developer path: the probe used to be read from a
// scratch directory that existed on exactly one machine, so this script threw ENOENT at module load
// everywhere else while the docs listed it as part of the gate that "runs anywhere".
const PROBE_HTML = await readFile(join(here, 'fixtures', 'fp-probe.html'), 'utf8');

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
  GB: {
    ip: '0.0.0.0',
    countryCode: 'GB',
    timezone: 'Europe/London',
    latitude: 51.5,
    longitude: -0.12,
  },
  BR: {
    ip: '0.0.0.0',
    countryCode: 'BR',
    timezone: 'America/Sao_Paulo',
    latitude: -23.55,
    longitude: -46.63,
  },
  AU: {
    ip: '0.0.0.0',
    countryCode: 'AU',
    timezone: 'Australia/Sydney',
    latitude: -33.87,
    longitude: 151.2,
  },
};
const geoKeys = Object.keys(GEOS);

// Build 50 personas with DISTINCT full fingerprints (distinct seeds → distinct farbling/canvas/audio),
// spread across OS + geo. Device classes may repeat (the catalog has a finite set); the analysis reports
// how many DISTINCT device classes those 50 cover.
function buildPersonas() {
  const out = [];
  const plan = [
    { os: 'windows', n: 15 },
    { os: 'macos', n: 14 },
    { os: 'linux', n: 11 },
  ];
  let gi = 0;
  for (const { os, n } of plan) {
    for (let i = 0; i < n; i++) {
      const seed = `deep-${os}-${i}`;
      const fp = deriveFingerprint(seed, { os, engine: 'lobium' });
      const geo = GEOS[geoKeys[gi++ % geoKeys.length]];
      out.push({
        os,
        seed,
        geo: geo.countryCode,
        fingerprint: applyGeoToFingerprint(fp, geo),
        android: false,
      });
    }
  }
  for (let i = 0; i < 10; i++) {
    const seed = `deep-android-${i}`;
    const fp = deriveAndroidFingerprint(seed, { engine: 'lobium' });
    const geo = GEOS[geoKeys[gi++ % geoKeys.length]];
    out.push({
      os: 'android',
      seed,
      geo: geo.countryCode,
      fingerprint: applyGeoToFingerprint(fp, geo),
      android: true,
    });
  }
  return out;
}

function startProbeServer() {
  return new Promise((resolve) => {
    const srv = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(PROBE_HTML);
    });
    srv.listen(0, '127.0.0.1', () =>
      resolve({ srv, url: `http://127.0.0.1:${srv.address().port}/` }),
    );
  });
}

async function runPersona(persona, probeUrl) {
  const fp = persona.fingerprint;
  // Use the shipping launcher around the pre-derived fingerprint. On Windows this is what verifies
  // and stages the persona-specific DirectWrite pack; a hand-written config silently omitted that
  // transport and therefore did not represent a product profile.
  const engine = await launchNativePersona({
    bin: LOBIUM,
    profileId: `deep-${persona.os}-${persona.seed}`,
    fingerprint: fp,
    fingerprintSeed: persona.seed,
    headless: true,
    isMobileProfile: persona.android,
    ...(persona.android ? { mobileFormFactor: 'phone' } : {}),
  });
  try {
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(engine.ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      // PURE NATIVE: intentionally NO applyCdpFingerprint here.
      await gotoSettled(page, probeUrl, { waitUntil: 'domcontentloaded' });
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
    } finally {
      await browser.close();
    }
  } finally {
    await engine.close();
  }
}

function intendedSummary(fp) {
  return {
    userAgent: fp.navigator.userAgent,
    platform: fp.navigator.platform,
    hardwareConcurrency: fp.navigator.hardwareConcurrency,
    deviceMemory: fp.navigator.deviceMemory,
    maxTouchPoints: fp.navigator.maxTouchPoints,
    languages: fp.navigator.languages,
    screen: {
      width: fp.screen.width,
      height: fp.screen.height,
      dpr: fp.screen.devicePixelRatio,
      colorDepth: fp.screen.colorDepth,
    },
    webglUnmaskedRenderer: fp.webgl.unmaskedRenderer,
    webglUnmaskedVendor: fp.webgl.unmaskedVendor,
    timezone: fp.locale.timezone,
    locale: fp.locale.locale,
    os: fp.os,
    arch: fp.arch,
  };
}

async function main() {
  if (!LOBIUM) {
    console.error('DEEP PROBE: BLOCKED - no Lobium binary (set LOBSTER_LOBIUM_BIN)');
    process.exitCode = 2;
    return;
  }
  let personas = buildPersonas();
  // Optional: run a small representative subset (one per geo) for a fast confirmation.
  if (process.env.LIMIT === 'geo') {
    const byGeo = new Map();
    for (const p of personas) if (!byGeo.has(p.geo)) byGeo.set(p.geo, p);
    personas = [...byGeo.values()];
  } else if (process.env.LIMIT !== undefined) {
    const limit = Number(process.env.LIMIT);
    if (!Number.isSafeInteger(limit) || limit < 1) {
      console.error('DEEP PROBE: BLOCKED - LIMIT must be "geo" or a positive integer');
      process.exitCode = 2;
      return;
    }
    personas = personas.slice(0, limit);
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
      results.push({ os: p.os, seed: p.seed, geo: p.geo, error: String((e && e.message) || e) });
      process.stderr.write('ERR ' + (e && e.message) + '\n');
    }
  }
  srv.close();
  const summary = summarizeDeepProbeResults(results);
  const outPath = join(REPORTS_DIR, 'deep-probe-50.json');
  await mkdir(REPORTS_DIR, { recursive: true });
  await writeFile(
    outPath,
    `${JSON.stringify(
      {
        kind: 'deep-probe-50',
        capturedAt: new Date().toISOString(),
        gpuMode: GPU_MODE,
        binary: LOBIUM,
        count: results.length,
        ...summary,
        results,
      },
      null,
      2,
    )}\n`,
  );
  console.log('SAVED ' + outPath);
  console.log(
    `DEEP PROBE: ${summary.verdict.toUpperCase()} - ${summary.passed}/${results.length} personas produced a complete readout`,
  );
  if (summary.verdict === 'fail') process.exitCode = 1;
  if (summary.verdict === 'blocked') process.exitCode = 2;
}

export function summarizeDeepProbeResults(results) {
  if (results.length === 0) {
    return { passed: 0, failed: 0, verdict: 'blocked' };
  }
  const failed = results.filter(
    (result) => result.error || !isCompleteDeepProbeReadout(result.observed),
  ).length;
  return { passed: results.length - failed, failed, verdict: failed === 0 ? 'pass' : 'fail' };
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isCompleteDeepProbeReadout(observed) {
  return (
    isRecord(observed) &&
    !Object.hasOwn(observed, 'error') &&
    isRecord(observed.navigator) &&
    Object.hasOwn(observed.navigator, 'userAgent') &&
    Object.hasOwn(observed.navigator, 'platform') &&
    isRecord(observed.screen) &&
    Object.hasOwn(observed.screen, 'width') &&
    Object.hasOwn(observed.screen, 'height')
  );
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
  });
}
