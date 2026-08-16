#!/usr/bin/env node
/**
 * Self-test for the TLS gate's block-vs-fail contract.
 *
 * The gate was changed so an unreachable echo BLOCKS (exit 2, gate stays green) instead of failing.
 * That is the right call, but it is also the change most able to hide a real regression, so the
 * contract needs testing in both directions rather than asserting.
 *
 * Runs the real ci/validation/tls-fingerprint.mjs against a local echo we control:
 *
 *   A unreachable        nothing listening              -> expect 2 (blocked)
 *   B bad JA4            echo serves a non-Chrome ja4   -> expect 1 (FAIL: a regression is caught)
 *   C browser-only fail  echo answers Node, not Chrome  -> ???  this is the interesting one
 *
 * C exists because the preflight uses NODE's fetch while the measurement uses the BROWSER's. If those
 * two can disagree, an engine-side networking defect looks like a third-party outage.
 */
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const GATE = join(here, 'tls-fingerprint.mjs');

const CHROME_JA4 = 't13d1516h2_8daaf6152771_02713d6af862';
const BAD_JA4 = 'q13d0000_notchrome_atall';

function body(ja4) {
  return JSON.stringify({
    tls: { ja3: '771,4865-4866', ja3_hash: 'deadbeef', ja4, peetprint_hash: 'x' },
    http2: { akamai_fingerprint_hash: 'y' },
  });
}

/**
 * @param mode 'bad-ja4'   every client gets a non-Chrome ja4
 *             'split'     Node gets valid JSON, a Chrome UA gets an HTML error page
 */
async function startEcho(mode) {
  const seen = [];
  const server = createServer((req, res) => {
    const ua = req.headers['user-agent'] ?? '';
    const isBrowser = /Chrome\//.test(ua);
    seen.push({ isBrowser, ua: ua.slice(0, 40) });
    if (mode === 'split' && isBrowser) {
      // What a captive portal / origin error actually looks like — and equally, what our own engine
      // would see if a networking hook broke its outbound fetch.
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end('<html><body>upstream error</body></html>');
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(body(mode === 'bad-ja4' ? BAD_JA4 : CHROME_JA4));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/api/all`, server, seen };
}

async function runGate(echoUrl) {
  const child = spawn(process.execPath, [GATE], {
    env: {
      ...process.env,
      TLS_ECHO_URL: echoUrl,
      OSES: 'windows',
      LOBSTER_GPU: 'software',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const [code] = await once(child, 'exit');
  return { code, out };
}

const label = { 0: 'PASS', 1: 'FAIL (regression caught)', 2: 'BLOCKED (gate stays green)' };
const results = [];

// A — nothing listening on that port.
{
  const { url, server } = await startEcho('bad-ja4');
  await new Promise((r) => server.close(r));
  const { code, out } = await runGate(url);
  results.push({ scenario: 'A unreachable echo', expected: 2, code, note: out.match(/TLS GATE: [^\n]*/)?.[0] ?? '' });
}

// B — reachable, but the JA4 is not Chrome-shaped. This is a real regression and MUST fail.
{
  const { url, server } = await startEcho('bad-ja4');
  const { code, out } = await runGate(url);
  await new Promise((r) => server.close(r));
  results.push({ scenario: 'B non-Chrome JA4', expected: 1, code, note: out.match(/TLS GATE: [^\n]*/)?.[0] ?? '' });
}

// C — Node's preflight succeeds, the browser's fetch does not.
{
  const { url, server, seen } = await startEcho('split');
  const { code, out } = await runGate(url);
  await new Promise((r) => server.close(r));
  results.push({
    scenario: 'C browser cannot read echo',
    expected: null,
    code,
    note: `${out.match(/TLS GATE: [^\n]*/)?.[0] ?? ''} | requests: node=${seen.filter((s) => !s.isBrowser).length} browser=${seen.filter((s) => s.isBrowser).length}`,
  });
}

console.log('');
for (const r of results) {
  const verdict = r.expected === null ? '(observe)' : r.code === r.expected ? 'OK' : `MISMATCH (wanted ${r.expected})`;
  console.log(`${r.scenario.padEnd(30)} exit=${r.code} ${(label[r.code] ?? '?').padEnd(28)} ${verdict}`);
  if (r.note) console.log(`  ${r.note}`);
}
