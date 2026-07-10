#!/usr/bin/env node
/**
 * Anti-bot exam — "book the real exam".
 *
 * CreepJS/Sannysoft are fingerprint AUDITS: they tell you if surfaces are internally consistent. They
 * do NOT tell you whether a commercial anti-bot lets the persona through. This harness drives a native
 * Lobium persona against real detectors that return an actual verdict, and records what happens —
 * pass, fail, challenged, or inconclusive. A recorded failure here is worth more than another green
 * CreepJS run, because it is the actual product question: does this browser survive bot management.
 *
 * Built-in public targets (machine-readable verdicts, no account needed):
 *   - areyouheadless  (arh.antoinevastel.com)         → headless yes/no
 *   - deviceinfo-bot  (deviceandbrowserinfo.com)       → bot yes/no + reasons
 *   - fingerprintjs   (openfpcdn.io FPJS v4, in-page)  → visitorId + confidence score
 *   - creepjs         (abrahamjuliot.github.io)        → lies / headless / stealth ratings
 *
 * Commercial WAFs (Cloudflare Bot Management / DataDome / PerimeterX / Akamai / Kasada) cannot be
 * tested in the abstract — they only exist in front of a customer site. Point the harness at real
 * protected URLs you are authorized to test and it will classify the response as passed / challenged
 * / blocked using generic vendor challenge markers:
 *   LOBSTER_EXAM_URLS="https://shop.example.com,https://app.example.com" node ci/validation/antibot-exam.mjs
 *
 * Env:
 *   LOBSTER_LOBIUM_BIN   path to the Lobium chrome binary (else resolveLobiumBinary()).
 *   LOBSTER_GPU          gpu | software | auto (default from resolveGpuMode()). SOFTWARE RUNS ARE
 *                        PROVISIONAL — WebGL-based detectors will see SwiftShader; the report says so.
 *   LOBSTER_EXAM_SEED    persona seed (default 'antibot-exam').
 *   LOBSTER_EXAM_OS      windows | macos | linux (default windows).
 *   LOBSTER_EXAM_URLS    comma-separated extra (commercial-WAF) URLs to classify.
 *   LOBSTER_EXAM_NO_SANDBOX=0  keep the Chromium sandbox (default: pass --no-sandbox for CI/containers).
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { applyGeoToFingerprint, deriveFingerprint } from '@lobster/fingerprint';
import {
  applyCdpFingerprint,
  buildGpuArgs,
  buildLaunchOptions,
  buildLobiumConfig,
  isSoftwareRenderer,
  lobiumConfigArg,
  resolveGpuMode,
  resolveLobiumBinary,
} from '@lobster/engine-runner';
import { chromium } from 'patchright';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const LOBIUM = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
const GPU_MODE = resolveGpuMode();
const SEED = process.env.LOBSTER_EXAM_SEED || 'antibot-exam';
const OS = process.env.LOBSTER_EXAM_OS || 'windows';
const EXTRA_URLS = (process.env.LOBSTER_EXAM_URLS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// ── Generic commercial-WAF challenge classifier ────────────────────────────────────────────────────
// Marker sets per vendor. Presence in the served HTML/title => a challenge or block, i.e. the persona
// did NOT pass cleanly. Absence with a 200 => passed (as far as this coarse signal can tell).
const WAF_MARKERS = {
  cloudflare: [/just a moment/i, /cf-browser-verification/i, /challenge-platform/i, /cf_chl_/i, /__cf_chl/i],
  datadome: [/datadome/i, /dd_cookie/i, /geo\.captcha-delivery\.com/i, /captcha-delivery/i],
  perimeterx: [/px-captcha/i, /_px2?=/i, /perimeterx/i, /human challenge/i],
  akamai: [/ak_bmsc/i, /_abck/i, /bm_sz/i],
  kasada: [/kasada/i, /kpsdk/i, /\/149e9513/i],
};

function classifyWaf(status, html, title) {
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
  return { verdict: 'passed', status, vendors: [], detail: `HTTP ${status}, no challenge markers` };
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
      return { text: text.slice(0, 400), headlessDetected: /headless/i.test(text) && !/not.*headless/i.test(text) };
    },
    // A down/error page (non-200, gateway error) is NOT a pass — only a real verdict counts.
    interpret: (r, status) => {
      if (status !== 200 || /bad gateway|not found|error/i.test(r?.text || '')) return 'inconclusive';
      return r?.headlessDetected ? 'fail' : r?.text ? 'pass' : 'inconclusive';
    },
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
      if (r?.detection && typeof r.detection.isBot === 'boolean') return r.detection.isBot ? 'fail' : 'pass';
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
        const fp = await import('https://openfpcdn.io/fingerprintjs/v4');
        const agent = await fp.load();
        const r = await agent.get();
        return { visitorId: r.visitorId, confidence: r.confidence };
      } catch (e) {
        return { error: String(e) };
      }
    },
    interpret: (r) =>
      r?.error ? 'inconclusive' : r?.visitorId ? 'pass' : 'inconclusive',
    note: 'FPJS gives an identifier, not a bot verdict; "pass" only means it computed cleanly. Cross-profile UNLINKABILITY is checked separately (distinct visitorIds across seeds).',
  },
  {
    id: 'creepjs',
    url: 'https://abrahamjuliot.github.io/creepjs/',
    waitMs: 16000,
    evaluate: () => {
      const fp = window.Fingerprint || {};
      const lies = fp.lies && typeof fp.lies.totalLies === 'number' ? fp.lies.totalLies : null;
      return { lies, hasFingerprint: !!window.Fingerprint };
    },
    interpret: (r) => (r?.lies === 0 ? 'pass' : typeof r?.lies === 'number' ? 'fail' : 'inconclusive'),
  },
];

async function readCdpEndpoint(userDataDir, retries = 200) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < retries; i++) {
    if (existsSync(file)) {
      const [port, path] = (await readFile(file, 'utf8')).trim().split('\n');
      if (port && path) return `ws://127.0.0.1:${port}${path}`;
    }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for DevToolsActivePort');
}

async function runProbe(context, probe) {
  const page = await context.newPage();
  const started = Date.now();
  try {
    const resp = await page.goto(probe.url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    if (probe.waitMs) await page.waitForTimeout(probe.waitMs);
    let observed;
    if (probe.evaluateAsync) observed = await page.evaluate(probe.evaluateAsync);
    else if (probe.evaluate) observed = await page.evaluate(probe.evaluate);
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
    return { id: probe.id, url: probe.url, verdict: 'error', error: String(e), ms: Date.now() - started };
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
    process.exit(1);
  }

  let fp = deriveFingerprint(SEED, { os: OS, engine: 'lobium' });
  // A US exit persona keeps locale/timezone coherent for US-hosted detectors.
  fp = applyGeoToFingerprint(fp, {
    ip: '0.0.0.0',
    countryCode: 'US',
    timezone: 'America/New_York',
    latitude: 40.7128,
    longitude: -74.006,
  });

  const userDataDir = await mkdtemp(join(tmpdir(), 'antibot-exam-'));
  const cfg = buildLobiumConfig(fp, {});
  const cfgPath = join(userDataDir, 'lobium-fp.json');
  await writeFile(cfgPath, `${JSON.stringify(cfg)}\n`);

  // Use the PRODUCT's launch options so the exam is a faithful integration test — same
  // --disable-blink-features=AutomationControlled (no navigator.webdriver tell), --lang, --window-size,
  // and WebRTC IP-handling policy the real launcher applies. Then add the direct-native binary bits.
  const launch = buildLaunchOptions({
    profileId: 'antibot-exam',
    engine: 'lobium',
    userDataDir,
    fingerprint: fp,
    headless: true,
  });
  const args = [
    '--headless=new',
    '--disable-dev-shm-usage',
    ...(process.env.LOBSTER_EXAM_NO_SANDBOX === '0' ? [] : ['--no-sandbox']),
    ...(GPU_MODE === 'gpu' ? [] : ['--enable-unsafe-swiftshader']),
    `--user-data-dir=${userDataDir}`,
    lobiumConfigArg(cfgPath),
    '--remote-debugging-port=0',
    ...launch.args,
  ];
  if (GPU_MODE === 'gpu' && !args.some((a) => a.startsWith('--use-angle='))) {
    args.push(...buildGpuArgs({ mode: 'gpu' }));
  }

  console.error(`Anti-bot exam: binary=${LOBIUM} gpuMode=${GPU_MODE} os=${OS} seed=${SEED}`);
  const proc = spawn(LOBIUM, args, { stdio: 'ignore' });
  const results = [];
  let observedRenderer = null;
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0] || (await browser.newContext());
      // Apply the CDP fingerprint layer for parity with the product launch path.
      const cdp = await context.newCDPSession(await context.newPage());
      await applyCdpFingerprint(cdp, fp).catch(() => {});
      // Capture the actual renderer so a software run is flagged honestly.
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
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  const softwareRenderer = isSoftwareRenderer(observedRenderer);
  const tally = results.reduce((m, r) => ((m[r.verdict] = (m[r.verdict] || 0) + 1), m), {});
  const report = {
    kind: 'antibot-exam',
    capturedAt: new Date().toISOString(),
    binary: LOBIUM,
    gpuMode: GPU_MODE,
    observedRenderer,
    softwareRenderer,
    provisional: softwareRenderer,
    persona: { seed: SEED, os: OS, ua: fp.navigator.userAgent, renderer: fp.webgl.unmaskedRenderer },
    tally,
    results,
  };

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = report.capturedAt.replace(/[:.]/g, '-');
  await writeFile(join(REPORTS_DIR, `antibot-exam-${stamp}.json`), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(join(REPORTS_DIR, 'antibot-exam-latest.json'), `${JSON.stringify(report, null, 2)}\n`);

  process.stdout.write(`\n${JSON.stringify({ gpuMode: GPU_MODE, softwareRenderer, tally }, null, 2)}\n`);
  if (softwareRenderer) {
    console.error(
      '\nNOTE: software renderer (SwiftShader) — these verdicts are PROVISIONAL. Re-run on the real-GPU runner for a defensible result.',
    );
  }
  // The exam records data; it does not fail CI on a detector "fail" (that is a product signal to triage,
  // not a red build). It exits non-zero only on harness errors so a broken run is visible.
  const allErrored = results.length > 0 && results.every((r) => r.verdict === 'error');
  process.exitCode = allErrored ? 1 : 0;
}

main().catch((e) => {
  console.error(`ANTIBOT EXAM ERROR: ${e?.stack || e}`);
  process.exit(2);
});
