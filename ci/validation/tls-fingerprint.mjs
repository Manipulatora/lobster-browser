#!/usr/bin/env node
// TLS/HTTP2 network-fingerprint gate (Item 3 baseline).
//
// Because Lobium IS a real Chromium build, its ClientHello (JA3/JA4) and HTTP/2 SETTINGS (Akamai H2)
// should equal a genuine Chrome's — coherent with the UA by construction. This launches a persona and
// reads its live JA3/JA4/H2 from a TLS-echo service.
//
// WHAT "EQUAL" MEANS HERE, and why the shape check is not enough. `/^t13d\d{4}h2/` is satisfied by
// every TLS1.3 browser on earth, so it caught nothing a fork could plausibly break: a changed cipher
// list, a reordered extension, a dropped ALPS entry or a different HTTP/2 SETTINGS order all keep the
// JA4 shape and change the hash — and the hash is what a WAF actually keys on. So the gate compares
// the full JA3/JA4/PeetPrint/Akamai-H2 set against a REFERENCE stock Chrome:
//
//   • LOBSTER_STOCK_CHROME_BIN set  -> the reference is measured live, in this same run, through the
//     same echo. Strongest form: no pin can go stale, and network conditions are shared.
//   • otherwise                     -> the reference pinned in tls-reference.json for this Chrome
//     major is used.
//   • neither                       -> BLOCKED (exit 2). An unpinned major means we have nothing to
//     compare against, which is not the same as agreeing.
//
// Capture a pin with:  LOBSTER_STOCK_CHROME_BIN=<stock chrome> node ci/validation/tls-fingerprint.mjs --capture-reference
//
// It drives the browser via the project's FIRST-PARTY CDP client (cdp-client.ts) — no patchright.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { applyGeoToFingerprint, deriveFingerprint } from '@lobster/fingerprint';
import {
  buildDevShmArgs,
  buildLaunchOptions,
  buildLobiumConfig,
  cdpEvaluate,
  lobiumConfigArg,
  resolveLobiumBinary,
  withCdpSession,
  writeLobiumConfig,
} from '@lobster/engine-runner';

const HERE = dirname(fileURLToPath(import.meta.url));
const LOBIUM = resolveLobiumBinary();
const STOCK_CHROME = process.env.LOBSTER_STOCK_CHROME_BIN || '';
const CAPTURE = process.argv.includes('--capture-reference');
const ECHO = process.env.TLS_ECHO_URL || 'https://tls.peet.ws/api/all';
const GEO = { ip: '0.0.0.0', countryCode: 'US', timezone: 'America/New_York', latitude: 40.7, longitude: -74 };
const REFERENCE_PATH = join(HERE, 'tls-reference.json');
const REPORT_PATH = join(HERE, 'reports', 'tls-fingerprint.json');

/** The fields a WAF keys on. Every one of them is collected already; every one of them is asserted. */
const COMPARED = ['ja3_hash', 'ja4', 'peetprint_hash', 'akamai_h2'];

async function readCdp(dir, n = 200) {
  for (let i = 0; i < n; i++) {
    try {
      const [p, path] = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n');
      if (Number(p) > 0 && path) return `ws://127.0.0.1:${Number(p)}${path.trim()}`;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no cdp endpoint');
}

/**
 * @param os        persona OS to derive (ignored for the stock reference, which carries no persona)
 * @param options   `{ bin, native }` — `native: false` launches a plain Chromium with no Lobium
 *                  config and none of the launcher's persona flags, which is what makes the stock
 *                  measurement a reference rather than a second copy of the thing being tested.
 */
async function run(os, { bin = LOBIUM, native = true } = {}) {
  const seed = `tls-${os}`;
  const fp = applyGeoToFingerprint(deriveFingerprint(seed, { os, engine: 'lobium' }), GEO);
  const dir = await mkdtemp(join(tmpdir(), `tls-${os}-`));
  const personaArgs = [];
  if (native) {
    const cfg = await writeLobiumConfig(dir, buildLobiumConfig(fp, { seed }));
    const launch = buildLaunchOptions({ profileId: seed, engine: 'lobium', userDataDir: dir, fingerprint: fp, headless: true });
    personaArgs.push(lobiumConfigArg(cfg), ...launch.args);
  }
  const args = [
    '--headless=new', '--no-sandbox', ...buildDevShmArgs(), '--enable-unsafe-swiftshader',
    `--user-data-dir=${dir}`, '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', ...personaArgs,
  ];
  const proc = spawn(bin, args, { stdio: 'ignore', env: { ...process.env, TZ: fp.locale.timezone } });
  try {
    const ws = await readCdp(dir);
    return await withCdpSession(
      ws,
      async (session) => {
        // Navigate to the echo origin, then read the RAW JSON via a same-origin fetch (Chrome's built-in
        // JSON viewer mangles innerText). First-party CDP only: Page.navigate + Runtime.evaluate, no
        // Runtime.enable. The fetch reuses the same real ClientHello, so JA3/JA4 are the browser's.
        await session.send('Page.navigate', { url: ECHO });
        let text = '';
        for (let i = 0; i < 60; i++) {
          await new Promise((r) => setTimeout(r, 500));
          try {
            text = await cdpEvaluate(
              session,
              `fetch(${JSON.stringify(ECHO)}, { cache: 'no-store' }).then((r) => r.text())`,
            );
            if (text && text.includes('ja3')) break;
          } catch {
            /* page not ready / cross-origin during about:blank — retry */
          }
        }
        // The browser's own UA, not the persona's: for the stock reference they are different values,
        // and it is the stock build's Chrome major that decides which pin the comparison belongs to.
        const ua = await cdpEvaluate(session, 'navigator.userAgent').catch(() => '');
        return { text, ua };
      },
      { timeoutMs: 60_000 },
    ).then(({ text, ua }) => {
      let data;
      try {
        data = JSON.parse(text);
      } catch {
        return { os, error: 'could not parse echo response', raw: text.slice(0, 200) };
      }
      const tls = data.tls || {};
      const h2 = data.http2 || {};
      return {
        os,
        native,
        userAgent: ua || fp.navigator.userAgent,
        chromeMajor: /Chrome\/(\d+)/.exec(ua || fp.navigator.userAgent)?.[1] ?? '',
        ja3: tls.ja3,
        ja3_hash: tls.ja3_hash,
        ja4: tls.ja4,
        peetprint_hash: tls.peetprint_hash,
        akamai_h2: h2.akamai_fingerprint_hash || h2.akamai_fingerprint,
        // Chrome family check: JA4 for Chrome-on-TLS1.3 is `t13d15..._...` with h2 ALPN. A non-browser
        // client (curl/python) produces a distinctly different JA4. This is the coherence assertion.
        chromeShapedJa4: typeof tls.ja4 === 'string' && /^t13d\d{4}h2/.test(tls.ja4),
      };
    });
  } finally {
    proc.kill('SIGKILL');
    await new Promise((r) => setTimeout(r, 300));
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Can the third-party echo actually be reached from here?
 *
 * Checked before launching a browser, because the alternative is a 60s CDP timeout thrown from inside
 * `withCdpSession` — which is how an outage used to present itself: an unhandled rejection, exit 1, and
 * `regression-gate.mjs` recording FAIL. Exit 2 (BLOCKED) is the contract for "cannot run here"; only a
 * ClientHello we actually read and judged may fail this gate.
 */
async function echoReachable() {
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 15_000);
  try {
    const res = await fetch(ECHO, { signal: abort.signal, cache: 'no-store' });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

async function readReferences() {
  try {
    return JSON.parse(await readFile(REFERENCE_PATH, 'utf8'));
  } catch {
    return { references: {} };
  }
}

/**
 * The report audit-oracles.mjs folds into the networkTls / networkHttp2 aspects. It carries per-aspect
 * rows rather than raw hashes so the two gates cannot disagree about what a measurement meant.
 */
async function writeReport(rows, extra) {
  await mkdir(dirname(REPORT_PATH), { recursive: true });
  await writeFile(
    REPORT_PATH,
    JSON.stringify({ generatedAt: new Date().toISOString(), echo: ECHO, ...extra, oracleRows: rows }, null, 2),
    'utf8',
  );
}

function aspectRow(id, aspect, personaOs, verdict, detail) {
  return {
    id,
    aspect,
    personaOs,
    status: 'fixed',
    pass: verdict === 'pass',
    inconclusive: verdict === 'inconclusive',
    detail,
  };
}

/** Report an environmental block and leave the gate un-reddened. */
async function blocked(reason, rows = [], extra = {}) {
  console.log(`TLS GATE: SKIPPED — ${reason}`);
  if (rows.length) await writeReport(rows, { verdict: 'blocked', reason, ...extra });
  process.exit(2);
}

// This gate reads a REAL ClientHello, so it needs the real engine. Say so plainly instead of failing
// deep inside `spawn(undefined, …)` — regression-gate surfaces this line as the check's detail, and a
// cryptic ENOENT there is exactly how a broken harness stays broken.
if (!LOBIUM) {
  await blocked('no Lobium binary (set LOBSTER_LOBIUM_BIN, or SKIP_TLS=1 to skip).');
}

// The ClientHello has to be echoed back by someone. That someone is a third party we do not run, so its
// availability is an environment fact, not a property of our TLS stack.
if (!(await echoReachable())) {
  await blocked(`echo endpoint unreachable: ${ECHO} (set TLS_ECHO_URL to a reachable equivalent, or SKIP_TLS=1).`);
}

const oses = (process.env.OSES || 'windows').split(',');
const measurements = [];
for (const os of oses) {
  let r;
  try {
    r = await run(os);
  } catch (err) {
    // Launch/CDP/navigation failure: we never obtained a ClientHello, so there is nothing to judge.
    await blocked(`${os}: ${err?.message ?? err}`);
  }
  console.log(JSON.stringify(r, null, 1));
  // A response we could not parse is the echo misbehaving (an error page, a captive portal), not
  // evidence that our JA4 drifted. Blocking here keeps "we could not measure" distinct from "we
  // measured, and it was wrong" — the distinction the whole gate exists to make.
  if (r.error) await blocked(`${os}: ${r.error}`);
  measurements.push(r);
}
if (!measurements.length) await blocked('no persona produced a readable ClientHello.');

// ── 1. Shape. Cheap, and it is what separates "a browser" from "a scripted HTTP client". ────────────
const misshapen = measurements.filter((r) => !r.chromeShapedJa4);
if (misshapen.length) {
  const detail = misshapen.map((r) => `${r.os}: ja4=${r.ja4}`).join('; ');
  await writeReport(
    measurements.flatMap((r) => [
      aspectRow('tls-clienthello-matches-stock-chrome', 'networkTls', r.os, r.chromeShapedJa4 ? 'inconclusive' : 'fail', `ja4=${r.ja4}`),
      aspectRow('http2-settings-match-stock-chrome', 'networkHttp2', r.os, 'inconclusive', 'not judged: the ClientHello is not Chrome-shaped'),
    ]),
    { verdict: 'fail', measurements },
  );
  console.log(`\nTLS GATE: FAIL — JA4 not Chrome-shaped (${detail})`);
  process.exit(1);
}

// ── 2. The reference. Live stock Chrome if we have one, otherwise the pin for this Chrome major. ────
let reference;
let referenceSource;
if (STOCK_CHROME) {
  let stock;
  try {
    stock = await run(oses[0], { bin: STOCK_CHROME, native: false });
  } catch (err) {
    await blocked(`stock Chrome reference could not be measured: ${err?.message ?? err}`);
  }
  if (stock.error) await blocked(`stock Chrome reference: ${stock.error}`);
  console.log(`\nstock reference (${STOCK_CHROME}):\n${JSON.stringify(stock, null, 1)}`);
  reference = stock;
  referenceSource = `live stock Chrome ${stock.chromeMajor} (${STOCK_CHROME})`;

  if (CAPTURE) {
    const file = await readReferences();
    file.references = file.references ?? {};
    file.references[stock.chromeMajor] = {
      capturedAt: new Date().toISOString(),
      source: STOCK_CHROME,
      echo: ECHO,
      userAgent: stock.userAgent,
      ...Object.fromEntries(COMPARED.map((k) => [k, stock[k]])),
      ja3: stock.ja3,
    };
    await writeFile(REFERENCE_PATH, `${JSON.stringify(file, null, 2)}\n`, 'utf8');
    console.log(`\ncaptured reference for Chrome ${stock.chromeMajor} into ${REFERENCE_PATH}`);
  }
} else {
  const major = measurements[0].chromeMajor;
  const file = await readReferences();
  reference = (file.references ?? {})[major];
  referenceSource = `pinned reference for Chrome ${major}`;
  if (!reference) {
    // Not a pass and not a failure: without a reference the hashes are numbers with nothing to be
    // compared to, and calling that green is precisely the hole the shape regex left open.
    await blocked(
      `no stock Chrome ${major} reference. Set LOBSTER_STOCK_CHROME_BIN to compare live, or pin one:\n` +
        `  LOBSTER_STOCK_CHROME_BIN=<stock chrome ${major}> node ci/validation/tls-fingerprint.mjs --capture-reference`,
      measurements.flatMap((r) => [
        aspectRow('tls-clienthello-matches-stock-chrome', 'networkTls', r.os, 'inconclusive', `no stock Chrome ${major} reference to compare against`),
        aspectRow('http2-settings-match-stock-chrome', 'networkHttp2', r.os, 'inconclusive', `no stock Chrome ${major} reference to compare against`),
      ]),
      { measurements },
    );
  }
}

// ── 3. Equality. A drifted cipher list, extension order or SETTINGS frame changes a hash, not a shape.
const rows = [];
let ok = true;
for (const r of measurements) {
  const tlsDiff = ['ja3_hash', 'ja4', 'peetprint_hash'].filter((k) => r[k] !== reference[k]);
  const h2Diff = r.akamai_h2 !== reference.akamai_h2;
  if (tlsDiff.length || h2Diff) ok = false;
  rows.push(
    aspectRow(
      'tls-clienthello-matches-stock-chrome',
      'networkTls',
      r.os,
      tlsDiff.length ? 'fail' : 'pass',
      tlsDiff.length
        ? tlsDiff.map((k) => `${k}=${r[k]} want ${reference[k]}`).join('; ')
        : `ja4=${r.ja4} identical to ${referenceSource}`,
    ),
    aspectRow(
      'http2-settings-match-stock-chrome',
      'networkHttp2',
      r.os,
      h2Diff ? 'fail' : 'pass',
      h2Diff ? `akamai_h2=${r.akamai_h2} want ${reference.akamai_h2}` : `akamai_h2=${r.akamai_h2} identical to ${referenceSource}`,
    ),
  );
}

await writeReport(rows, { verdict: ok ? 'pass' : 'fail', referenceSource, reference, measurements });
console.log('');
for (const row of rows) console.log(`  [${row.pass ? 'PASS' : 'FAIL'}] ${row.id.padEnd(38)} ${row.personaOs.padEnd(7)} ${row.detail}`);
console.log(
  ok
    ? `\nTLS GATE: PASS — JA3/JA4/PeetPrint/Akamai-H2 identical to ${referenceSource}`
    : `\nTLS GATE: FAIL — network fingerprint differs from ${referenceSource}`,
);
process.exit(ok ? 0 : 1);
