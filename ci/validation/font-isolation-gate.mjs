#!/usr/bin/env node
/**
 * Font-isolation gate — does the engine's font filter actually engage?
 *
 *   LOBSTER_LOBIUM_BIN=<chrome> node ci/validation/font-isolation-gate.mjs
 *
 * WHY THIS IS SEPARATE FROM audit-oracles.mjs. That harness launches once with a realistic persona,
 * and against a realistic persona this measurement is nearly blind: the persona's font list covers
 * most of what a Windows host has installed, so "resolves" and "should resolve" agree whether or not
 * the filter is running. The one probe that discriminated (Sylfaen — installed here, not in the
 * persona list) is a single data point that reads like a small leak.
 *
 * It was not a small leak. The filter was doing NOTHING, and this gate is what proved it: launch
 * with a config listing three families, then measure. Every extra family that still resolves is a
 * leak, and the negative control (a family that exists nowhere) proves the measurement itself works.
 *
 * That distinction mattered. The original hook targeted DWriteFontProxyImpl, which every older
 * Chromium source describes as the Windows font path — but M152 enables
 * `kFontDataServiceAllWebContents` by default, so the renderer uses FontDataService instead and the
 * DWrite proxy is off the CSS matching path entirely. A source-only review would have called the
 * patch correct. Only measurement in the running browser showed otherwise.
 *
 * Needs its own browser launch (its whole point is a non-realistic config), which is why it is a
 * standalone gate rather than another entry in the oracle list.
 */
import { createServer } from 'node:http';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  withCdpSession,
  cdpEvaluate,
  buildGpuArgs,
  resolveLobiumBinary,
  probeLobiumBuildCapabilities,
} from '@lobster/engine-runner';
import { launchEngine } from './e2e/engine.mjs';

const bin = process.env.LOBSTER_LOBIUM_BIN || resolveLobiumBinary();
if (!bin) {
  console.error('No Lobium binary. Set LOBSTER_LOBIUM_BIN.');
  process.exit(2);
}

/** The only families the persona claims. Deliberately tiny so any other resolution is a leak. */
const ALLOWED = ['Arial', 'Courier New', 'Times New Roman'];

/**
 * Families the engine allows regardless of the persona list: Chromium's last-resort chain (whose
 * absence crashes the renderer) plus the families Blink resolves the CSS generics to (whose absence
 * renders monospace in a proportional face). They are not leaks, so they are excluded from the leak
 * count — but only ever the exact set the engine actually hard-allows.
 *
 * READ FROM THE KERNEL rather than copied. A hand-maintained copy here would drift, and the drift is
 * silent in the dangerous direction: a stale list makes the gate excuse a family the engine no longer
 * allows, i.e. report a real leak as expected.
 */
async function alwaysAllowedFromKernel() {
  const src = await readFile(
    new URL('../../lobium/src/lobium_fonts.cc', import.meta.url),
    'utf8',
  );
  const block = /constexpr std::string_view kAlwaysAllowed\[\] = \{([\s\S]*?)\};/.exec(src);
  if (!block) {
    throw new Error(
      'could not read kAlwaysAllowed from lobium/src/lobium_fonts.cc — the gate cannot tell an ' +
        'expected always-allowed family from a real leak without it',
    );
  }
  return [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

/** Stock Windows families that are NOT in ALLOWED. Any that resolves came from the host. */
const SHOULD_BE_BLOCKED = [
  'Verdana', 'Georgia', 'Tahoma', 'Impact', 'Sylfaen', 'Cambria', 'Consolas',
  'Candara', 'Corbel', 'Wingdings', 'Palatino Linotype', 'Trebuchet MS',
  'Lucida Console', 'Franklin Gothic Medium', 'Gabriola', 'MS Gothic',
];

/** Exists on no machine. If this ever reports "resolves", the measurement is broken, not the engine. */
const NEGATIVE_CONTROL = 'ZzzNotARealFontName';

const CONFIG = {
  version: 1,
  arch: 'x86_64',
  navigator: {
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/152.0.0.0 Safari/537.36',
    platform: 'Win32',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 8,
    deviceMemory: 8,
    maxTouchPoints: 0,
    uaPlatform: 'Windows',
    uaPlatformVersion: '15.0.0',
    uaMobile: false,
  },
  screen: { width: 1920, height: 1080, colorDepth: 24, devicePixelRatio: 1 },
  webgl: {
    unmaskedVendor: 'Google Inc. (NVIDIA)',
    unmaskedRenderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503), D3D11)',
  },
  locale: { timezone: 'America/New_York', locale: 'en-US', acceptLanguage: 'en-US,en;q=0.9' },
  fonts: ALLOWED,
  seeds: { canvas: 0, webgl: 0, audio: 0, clientRects: 0, mediaDevices: 1 },
  policy: {},
  net: {},
};

const probeExpression = (names) => `(() => {
  const probes = ${JSON.stringify(names)};
  const c = document.createElement('canvas').getContext('2d');
  // A string mixing wide and narrow glyphs so a substituted face almost certainly measures
  // differently from the fallback.
  const text = 'mmmmmmmmmmlli WWW 0123';
  const base = {};
  for (const g of ['monospace', 'sans-serif', 'serif']) {
    c.font = '72px ' + g;
    base[g] = c.measureText(text).width;
  }
  const out = {};
  for (const f of probes) {
    let present = false;
    // Three generics: a family that happens to measure identically to one fallback is very unlikely
    // to measure identically to all three.
    for (const g of ['monospace', 'sans-serif', 'serif']) {
      c.font = '72px "' + f + '", ' + g;
      if (c.measureText(text).width !== base[g]) { present = true; break; }
    }
    out[f] = present;
  }
  return out;
})()`;

const caps = await probeLobiumBuildCapabilities(bin);
if (!caps.capabilities.includes('font-isolation')) {
  console.log(`engine ${bin}`);
  console.log('font-isolation is not a capability of this build (expected off Windows) — skipping.');
  process.exit(0);
}

const dir = await mkdtemp(join(tmpdir(), 'lobium-fontgate-'));
const cfgPath = join(dir, 'lobium-fp.json');
await writeFile(cfgPath, JSON.stringify(CONFIG), 'utf8');

let uaHeader = null;
const server = createServer((q, res) => {
  // The UA header is produced BROWSER-side from this same config file. If it carries the persona,
  // the browser process is reading the config, so a font leak is a hook problem rather than a
  // config-delivery problem — which is the first fork in diagnosing a failure here.
  uaHeader ??= q.headers['user-agent'];
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>font isolation gate</title><body></body>');
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const names = [...ALLOWED, ...SHOULD_BE_BLOCKED, NEGATIVE_CONTROL];
let result;
const engine = await launchEngine({
  bin,
  headless: true,
  extraArgs: [`--lobium-fp-config=${cfgPath}`, ...buildGpuArgs()],
});
try {
  await withCdpSession(engine.ws, async (s) => {
    await s.send('Page.navigate', { url });
    for (let i = 0; i < 100; i += 1) {
      if ((await cdpEvaluate(s, 'document.readyState', { timeoutMs: 10_000 })) === 'complete') break;
      await new Promise((x) => setTimeout(x, 100));
    }
    result = await cdpEvaluate(s, probeExpression(names), { timeoutMs: 30_000 });
  });
} finally {
  await engine.close().catch(() => {});
  server.close();
  await rm(dir, { recursive: true, force: true });
}

console.log(`engine     ${bin}`);
console.log(`config     fonts: ${ALLOWED.join(', ')}`);
console.log(`browser read the config: ${uaHeader === CONFIG.navigator.userAgent}\n`);

const alwaysLower = new Set((await alwaysAllowedFromKernel()).map((f) => f.toLowerCase()));
const leaked = SHOULD_BE_BLOCKED.filter((f) => result[f] && !alwaysLower.has(f.toLowerCase()));
const missingAllowed = ALLOWED.filter((f) => !result[f]);

for (const f of names) {
  const inList = ALLOWED.includes(f);
  const note = result[f] && !inList && !alwaysLower.has(f.toLowerCase()) ? '   <-- LEAK' : '';
  console.log(`  ${result[f] ? 'resolves' : 'absent  '}  ${f.padEnd(24)}${inList ? '(claimed)' : ''}${note}`);
}

const problems = [];
if (result[NEGATIVE_CONTROL]) {
  problems.push(
    `the negative control "${NEGATIVE_CONTROL}" reports as present, so the width measurement is ` +
      'not discriminating and no other result here can be trusted',
  );
}
if (uaHeader !== CONFIG.navigator.userAgent) {
  problems.push(
    'the browser process did not apply the config (UA header is the host UA), so the font hooks ' +
      'were never reached — fix config delivery before looking at the filter',
  );
}
if (missingAllowed.length) {
  problems.push(
    `claimed families do not resolve: ${missingAllowed.join(', ')} — the filter is over-blocking, ` +
      'which breaks rendering and is its own fingerprint',
  );
}
if (leaked.length) {
  problems.push(
    `${leaked.length} host families resolve that the persona does not claim: ${leaked.join(', ')}`,
  );
}

console.log('');
if (problems.length) {
  console.log('FAIL');
  for (const p of problems) console.log(`  - ${p}`);
  process.exit(1);
}
console.log(
  `OK: ${SHOULD_BE_BLOCKED.length} unclaimed families blocked, ${ALLOWED.length} claimed families ` +
    'resolve, negative control absent.',
);
