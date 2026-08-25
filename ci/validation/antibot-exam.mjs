#!/usr/bin/env node
/**
 * Anti-bot exam — "book the real exam".
 *
 * CreepJS/Sannysoft are fingerprint AUDITS: they tell you if surfaces are internally consistent. They
 * do NOT tell you whether a commercial anti-bot lets the persona through. This harness drives a native
 * Lobium persona against public diagnostics and optional owned targets, and records what happens —
 * pass, fail, challenged, blocked, measurement, or inconclusive. Only an owned target with a success
 * assertion and server-side telemetry answers the product question: does bot management allow it.
 *
 * Built-in public targets (diagnostics; not all return bot verdicts):
 *   - areyouheadless  (arh.antoinevastel.com)         → headless yes/no
 *   - deviceinfo-bot  (deviceandbrowserinfo.com)       → bot yes/no + reasons
 *   - fingerprintjs   (openfpcdn.io FPJS v5, in-page)  → visitorId + confidence score
 *   - creepjs         (abrahamjuliot.github.io)        → lies / headless / stealth ratings
 *
 * Commercial WAFs (Cloudflare Bot Management / DataDome / PerimeterX / Akamai / Kasada) cannot be
 * tested in the abstract — they only exist in front of a customer site. Point the harness at real
 * protected URLs you are authorized to test and it will classify visible challenged/blocked responses;
 * an apparently clean response remains inconclusive without target-specific success telemetry:
 *   LOBSTER_EXAM_URLS="https://shop.example.com,https://app.example.com" node ci/validation/antibot-exam.mjs
 *
 * Env:
 *   LOBSTER_LOBIUM_BIN   path to the Lobium chrome binary (else resolveLobiumBinary()).
 *   LOBSTER_GPU          gpu | software | auto (default from resolveGpuMode()). Only explicit `gpu`
 *                        plus the separate unspoofed GPU baseline is non-provisional.
 *   LOBSTER_EXAM_GPU_BASELINE_SHA256  SHA-256 of the fresh unspoofed gpu-baseline report.
 *   LOBSTER_EXAM_SEED    persona seed (default 'antibot-exam').
 *   LOBSTER_EXAM_OS      windows | macos | linux (default windows).
 *   LOBSTER_EXAM_HEADLESS=1  opt into headless mode (default is the customer-representative headful path).
 *   LOBSTER_EXAM_GEO_JSON    optional GeoInfo JSON. Only set it when it comes from the actual proxy
 *                            exit; a hard-coded geo without that proxy is an intentional mismatch.
 *   LOBSTER_EXAM_URLS    comma-separated extra (commercial-WAF) URLs to classify.
 *   LOBSTER_EXAM_NO_SANDBOX=0  keep the Chromium sandbox (default: pass --no-sandbox for CI/containers).
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { applyGeoToFingerprint, deriveFingerprint } from '@lobster/fingerprint';
import { isSoftwareRenderer, resolveGpuMode, resolveLobiumBinary } from '@lobster/engine-runner';
import { chromium } from 'patchright';
import { launchNativePersona } from './e2e/native-lobium.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const LOBIUM = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
const GPU_MODE = resolveGpuMode();
const SEED = process.env.LOBSTER_EXAM_SEED || 'antibot-exam';
const OS = process.env.LOBSTER_EXAM_OS || 'windows';
const HEADLESS = process.env.LOBSTER_EXAM_HEADLESS === '1';
const GPU_BASELINE_SHA256 = process.env.LOBSTER_EXAM_GPU_BASELINE_SHA256 || null;
const EXTRA_URLS = (process.env.LOBSTER_EXAM_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Generic commercial-WAF challenge classifier ────────────────────────────────────────────────────
// Marker sets per vendor. Presence in the served HTML/title => a challenge or block, i.e. the persona
// did NOT pass cleanly. Absence with a 200 remains inconclusive without a target-specific assertion.
const WAF_MARKERS = {
  cloudflare: [
    /just a moment/i,
    /cf-browser-verification/i,
    /challenge-platform/i,
    /cf_chl_/i,
    /__cf_chl/i,
  ],
  datadome: [/datadome/i, /dd_cookie/i, /geo\.captcha-delivery\.com/i, /captcha-delivery/i],
  perimeterx: [/px-captcha/i, /_px2?=/i, /perimeterx/i, /human challenge/i],
  akamai: [/ak_bmsc/i, /_abck/i, /bm_sz/i],
  kasada: [/kasada/i, /kpsdk/i, /\/149e9513/i],
};

export function classifyWaf(status, html, title) {
  const hay = `${title}\n${html.slice(0, 20000)}`;
  const hits = [];
  for (const [vendor, markers] of Object.entries(WAF_MARKERS)) {
    if (markers.some((re) => re.test(hay))) hits.push(vendor);
  }
  if (status === 403 || status === 429 || status === 503) {
    return { verdict: 'blocked', status, vendors: hits, detail: `HTTP ${status}` };
  }
  if (hits.length > 0) {
    return { verdict: 'challenged', status, vendors: hits, detail: `markers: ${hits.join(',')}` };
  }
  // A generic HTTP 200 with no visible marker does not prove that a commercial WAF classified the
  // profile as human. Only an owned target with an expected-content assertion plus server-side vendor
  // telemetry can make that claim. Keep this observation useful without manufacturing a pass.
  return {
    verdict: 'inconclusive',
    status,
    vendors: [],
    detail: `HTTP ${status}, no visible challenge marker; owned-target success assertion/telemetry required`,
  };
}

export function isExamProvisional({
  gpuMode,
  softwareRenderer,
  headless,
  rendererAvailable,
  gpuBaselineRecorded,
}) {
  return (
    gpuMode !== 'gpu' ||
    softwareRenderer ||
    headless ||
    rendererAvailable !== true ||
    gpuBaselineRecorded !== true
  );
}

// ── Built-in probes ─────────────────────────────────────────────────────────────────────────────────
const PROBES = [
  {
    id: 'areyouheadless',
    url: 'https://arh.antoinevastel.com/bots/areyouheadless',
    waitMs: 4000,
    // The page writes a human-readable verdict into the DOM.
    evaluate: () => {
      const text = document.body ? document.body.innerText : '';
      return {
        text: text.slice(0, 400),
        headlessDetected: /headless/i.test(text) && !/not.*headless/i.test(text),
      };
    },
    // A down/error page (non-200, gateway error) is NOT a pass — only a real verdict counts.
    interpret: (r, status) => {
      if (status !== 200 || /bad gateway|not found|error/i.test(r?.text || ''))
        return 'inconclusive';
      return r?.headlessDetected ? 'fail' : r?.text ? 'pass' : 'inconclusive';
    },
    note: 'The site itself describes this as a simple Chromium/headless check and warns that false positives/negatives can occur; diagnostic only.',
  },
  {
    id: 'deviceinfo-bot',
    url: 'https://deviceandbrowserinfo.com/are_you_a_bot',
    waitMs: 6000,
    // This page renders a raw JSON detection object ({ isBot, details: {...} }). Capture it in full so
    // a failure is triageable — which specific signal fired (webdriver, GPU mismatch, automation, …).
    evaluate: () => {
      const text = document.body ? document.body.innerText : '';
      let detection = null;
      const m = text.match(/\{[\s\S]*"isBot"[\s\S]*\}/);
      if (m) {
        try {
          detection = JSON.parse(m[0]);
        } catch {
          /* keep raw */
        }
      }
      return { detection, raw: detection ? undefined : text.slice(0, 1200) };
    },
    interpret: (r, status) => {
      if (status !== 200) return 'inconclusive';
      if (r?.detection && typeof r.detection.isBot === 'boolean')
        return r.detection.isBot ? 'fail' : 'pass';
      return 'inconclusive';
    },
  },
  {
    id: 'fingerprintjs',
    url: 'about:blank',
    waitMs: 0,
    // Load the open-source FingerprintJS (the engine behind the FPJS demo) and compute a visitorId.
    // High confidence + a stable id is what an operator cares about; we record both.
    evaluateAsync: async () => {
      try {
        const fp = await import('https://openfpcdn.io/fingerprintjs/v5');
        const agent = await fp.load();
        const r = await agent.get();
        return { visitorId: r.visitorId, confidence: r.confidence };
      } catch (e) {
        return { error: String(e) };
      }
    },
    interpret: (r) => (r?.visitorId ? 'measurement' : 'inconclusive'),
    note: 'FingerprintJS OSS gives an identifier, not a bot verdict. A computed visitorId is recorded as measurement, never pass; stability/distinctness require relaunch and second-profile scenarios.',
  },
  {
    id: 'creepjs',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    waitMs: 16000,
    // Patchright page.evaluate runs in its isolated utility world. Read the detector's main-world object
    // through CDP without applying any fingerprint emulation.
    evaluateCdp: `(() => {
      const fp = window.Fingerprint || {};
      const lies = fp.lies && typeof fp.lies.totalLies === 'number' ? fp.lies.totalLies : null;
      return { lies, hasFingerprint: !!window.Fingerprint };
    })()`,
    interpret: (r) =>
      r?.lies === 0 ? 'pass' : typeof r?.lies === 'number' ? 'fail' : 'inconclusive',
  },
];

async function runProbe(context, probe) {
  const page = await context.newPage();
  const started = Date.now();
  try {
    const resp = await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (probe.waitMs) await page.waitForTimeout(probe.waitMs);
    let observed;
    if (probe.evaluateAsync) observed = await page.evaluate(probe.evaluateAsync);
    else if (probe.evaluateCdp) {
      const cdp = await context.newCDPSession(page);
      try {
        const { result } = await cdp.send('Runtime.evaluate', {
          expression: probe.evaluateCdp,
          returnByValue: true,
        });
        observed = result?.value;
      } finally {
        await cdp.detach().catch(() => {});
      }
    } else if (probe.evaluate) observed = await page.evaluate(probe.evaluate);
    const verdict = probe.interpret(observed, resp?.status() ?? null);
    return {
      id: probe.id,
      url: probe.url,
      status: resp?.status() ?? null,
      verdict,
      observed,
      note: probe.note,
      ms: Date.now() - started,
    };
  } catch (e) {
    return {
      id: probe.id,
      url: probe.url,
      verdict: 'error',
      error: String(e),
      ms: Date.now() - started,
    };
  } finally {
    await page.close().catch(() => {});
  }
}

async function runWafUrl(context, url) {
  const page = await context.newPage();
  const started = Date.now();
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForTimeout(3000);
    const html = await page.content();
    const title = await page.title();
    const c = classifyWaf(resp?.status() ?? 0, html, title);
    return { id: `waf:${url}`, url, ...c, verdict: c.verdict, ms: Date.now() - started };
  } catch (e) {
    return { id: `waf:${url}`, url, verdict: 'error', error: String(e), ms: Date.now() - started };
  } finally {
    await page.close().catch(() => {});
  }
}

async function main() {
  if (!LOBIUM || !existsSync(LOBIUM)) {
    console.error(`ANTIBOT EXAM: Lobium binary not found (LOBSTER_LOBIUM_BIN=${LOBIUM}).`);
    process.exitCode = 2;
    return;
  }

  let fp = deriveFingerprint(SEED, { os: OS, engine: 'lobium' });
  let suppliedGeo = null;
  if (process.env.LOBSTER_EXAM_GEO_JSON) {
    suppliedGeo = JSON.parse(process.env.LOBSTER_EXAM_GEO_JSON);
    fp = applyGeoToFingerprint(fp, suppliedGeo);
  }

  // Use the shipping launcher, not merely its static flag builder. On Windows this also verifies and
  // stages the persona-specific DirectWrite pack before the native config is written.
  const engine = await launchNativePersona({
    bin: LOBIUM,
    profileId: 'antibot-exam',
    fingerprint: fp,
    fingerprintSeed: SEED,
    headless: HEADLESS,
    noSandbox: process.env.LOBSTER_EXAM_NO_SANDBOX !== '0',
  });

  console.error(`Anti-bot exam: binary=${LOBIUM} gpuMode=${GPU_MODE} os=${OS} seed=${SEED}`);
  const results = [];
  let observedRenderer = null;
  try {
    const browser = await chromium.connectOverCDP(engine.ws);
    try {
      const context = browser.contexts()[0] || (await browser.newContext());
      // Do not overlay the native config with CDP emulation. Doing so can hide a broken native hook and
      // turns a native-product exam into a control-layer test. CDP is used only to drive/read the page.
      // Capture the page-observable renderer. Lobium may intentionally spoof this string, so it is a
      // consistency observation, not proof of the physical driver (the provisional rule below reflects that).
      observedRenderer = await context
        .newPage()
        .then(async (p) => {
          const r = await p.evaluate(() => {
            const gl = document.createElement('canvas').getContext('webgl');
            if (!gl) return null;
            const ext = gl.getExtension('WEBGL_debug_renderer_info');
            return ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.VERSION);
          });
          await p.close().catch(() => {});
          return r;
        })
        .catch(() => null);

      for (const probe of PROBES) {
        const r = await runProbe(context, probe);
        results.push(r);
        console.error(`  ${r.verdict.toUpperCase().padEnd(12)} ${r.id}`);
      }
      for (const url of EXTRA_URLS) {
        const r = await runWafUrl(context, url);
        results.push(r);
        console.error(`  ${r.verdict.toUpperCase().padEnd(12)} ${r.id}`);
      }
    } finally {
      await browser.close().catch(() => {});
    }
  } finally {
    await engine.close();
  }

  const softwareRenderer = isSoftwareRenderer(observedRenderer);
  // The observed UNMASKED_RENDERER string is itself a spoofed Lobium surface and therefore cannot prove
  // which physical driver rendered the pixels. Only an explicit gpu-mode run plus the unspoofed GPU
  // baseline is defensible. Auto/software and headless runs remain provisional even if the claimed
  // renderer string looks like Intel/NVIDIA/AMD.
  const provisional = isExamProvisional({
    gpuMode: GPU_MODE,
    softwareRenderer,
    headless: HEADLESS,
    rendererAvailable: typeof observedRenderer === 'string' && observedRenderer.length > 0,
    gpuBaselineRecorded: /^[a-f0-9]{64}$/i.test(GPU_BASELINE_SHA256 || ''),
  });
  const tally = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
  const report = {
    schemaVersion: 1,
    kind: 'antibot-exam',
    capturedAt: new Date().toISOString(),
    binary: LOBIUM,
    gpuMode: GPU_MODE,
    headless: HEADLESS,
    nativeFingerprintOnly: true,
    gpuBaselineReportSha256: GPU_BASELINE_SHA256,
    suppliedGeo,
    observedRenderer,
    softwareRenderer,
    provisional,
    persona: {
      seed: SEED,
      os: OS,
      ua: fp.navigator.userAgent,
      renderer: fp.webgl.unmaskedRenderer,
    },
    tally,
    results,
  };

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = report.capturedAt.replace(/[:.]/g, '-');
  await writeFile(
    join(REPORTS_DIR, `antibot-exam-${stamp}.json`),
    `${JSON.stringify(report, null, 2)}\n`,
  );
  await writeFile(
    join(REPORTS_DIR, 'antibot-exam-latest.json'),
    `${JSON.stringify(report, null, 2)}\n`,
  );

  process.stdout.write(
    `\n${JSON.stringify({ gpuMode: GPU_MODE, headless: HEADLESS, softwareRenderer, provisional, tally }, null, 2)}\n`,
  );
  if (provisional) {
    console.error(
      '\nNOTE: provisional evidence — require headful LOBSTER_GPU=gpu plus an unspoofed real-GPU baseline for a defensible result.',
    );
  }
  // The exam records data; it does not fail CI merely because a detector reports `fail`. It does fail
  // when no probe produced any definitive diagnostic result, preventing an all-inconclusive green run.
  const hasDefinitiveDiagnostic = results.some((r) =>
    ['pass', 'fail', 'challenged', 'blocked'].includes(r.verdict),
  );
  process.exitCode = hasDefinitiveDiagnostic ? 0 : 1;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    console.error(`ANTIBOT EXAM ERROR: ${e?.stack || e}`);
    process.exitCode = 2;
  });
}
