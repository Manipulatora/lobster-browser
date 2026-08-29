#!/usr/bin/env node
// Does the local proxy shim change the TLS handshake? Measure, do not assume.
//
//   node ci/validation/tls-through-proxy.mjs <chrome.exe|chrome> [--config <lobium-fp.json>]
//
// WHY THIS MATTERS MORE THAN THE DIRECT MEASUREMENT
//
// The direct ClientHello has been measured and matches stock Chrome exactly (JA3n/JA4/Akamai all
// equal; raw JA3 varies run to run on BOTH binaries because of GREASE, RFC 8701). But essentially
// NO real profile connects directly. Every profile with credentials on its proxy goes through
// `startLocalProxyAdapter` — a loopback HTTP proxy (proxy-chain) that Chromium is pointed at with
// `--proxy-server`, because Chromium cannot carry proxy credentials itself.
//
// So the fingerprint that reaches a detector is the one produced through that shim, and it had never
// been measured. The architectural expectation is that it is IDENTICAL: for an https:// origin
// Chromium sends `CONNECT host:443`, the shim opens a TCP tunnel, and Chromium's own TLS record
// layer flows through it untouched — the shim never sees plaintext and never terminates TLS.
//
// That expectation is exactly the kind of thing that is true right up until some library decides to
// be helpful. This measures it: the SAME probe, the SAME binary, the SAME endpoint, once direct and
// once through the real shim the product actually uses, with only the proxy differing.
//
// A DIFFERENCE HERE WOULD BE A CRITICAL FINDING: it would mean every paying customer's profile is
// classifiable at the handshake, before a byte of JavaScript runs, and no amount of navigator.*
// spoofing could hide it.
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Server } from 'proxy-chain';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ENDPOINT = 'https://tls.browserleaks.com/json';

const ENGINE = process.argv[2];
const CONFIG = process.argv.includes('--config')
  ? process.argv[process.argv.indexOf('--config') + 1]
  : null;

if (!ENGINE || !existsSync(ENGINE)) {
  console.error('usage: tls-through-proxy.mjs <path to chrome.exe|chrome> [--config <fp.json>]');
  process.exit(2);
}

/**
 * A loopback CONNECT proxy with NO upstream — the shim's own code path, forwarding directly.
 *
 * Deliberately upstream-less. Adding a real upstream would change the exit IP and therefore the
 * server's view of the client, confounding the one variable under test. What is being measured is
 * whether passing through the shim's CONNECT tunnel alters the handshake, and that path is the same
 * whether or not it then chains onward.
 */
async function startShim() {
  const server = new Server({
    port: 0,
    verbose: false,
    prepareRequestFunction: () => ({ upstreamProxyUrl: null }),
  });
  await server.listen();
  return { port: server.port, close: () => server.close(true) };
}

async function fingerprint(label, { proxyPort } = {}) {
  const udd = mkdtempSync(join(tmpdir(), 'tlsproxy-'));
  const args = [
    `--user-data-dir=${udd}`,
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--enable-unsafe-swiftshader',
    ...(proxyPort ? [`--proxy-server=http://127.0.0.1:${proxyPort}`] : []),
    ...(CONFIG ? [`--lobium-fp-config=${CONFIG}`] : []),
    'about:blank',
  ];
  const child = spawn(ENGINE, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stderr.resume();
  child.stdout.resume();
  try {
    const portFile = join(udd, 'DevToolsActivePort');
    let port = null;
    for (let i = 0; i < 240 && !port; i += 1) {
      if (existsSync(portFile)) {
        const [p] = readFileSync(portFile, 'utf8').split('\n');
        if (p) port = Number(p);
      }
      if (!port) await sleep(250);
    }
    if (!port) return { label, error: 'engine never wrote DevToolsActivePort' };

    let target = null;
    for (let i = 0; i < 240 && !target; i += 1) {
      try {
        const list = await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json());
        target = Array.isArray(list) ? list.find((t) => t.type === 'page') : null;
      } catch {
        /* not up yet */
      }
      if (!target) await sleep(250);
    }
    if (!target) return { label, error: 'no page target' };

    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      ws.addEventListener('open', () => res(), { once: true });
      ws.addEventListener('error', () => rej(new Error('ws')), { once: true });
    });
    let id = 0;
    const pending = new Map();
    ws.addEventListener('message', (ev) => {
      const m = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      if (m.id && pending.has(m.id)) {
        pending.get(m.id)(m);
        pending.delete(m.id);
      }
    });
    const send = (method, params = {}) =>
      new Promise((res) => {
        const q = ++id;
        pending.set(q, res);
        ws.send(JSON.stringify({ id: q, method, params }));
      });

    await send('Runtime.enable');
    // Navigate, so the handshake is the BROWSER's own rather than a fetch from another origin that
    // might reuse a pooled connection.
    await send('Page.navigate', { url: ENDPOINT });
    await sleep(8000);
    const r = await send('Runtime.evaluate', {
      expression: 'document.body ? document.body.innerText.slice(0, 4000) : ""',
      returnByValue: true,
    });
    ws.close();
    const text = r.result?.result?.value ?? '';
    try {
      return { label, ...JSON.parse(text) };
    } catch {
      return { label, raw: text.slice(0, 300) };
    }
  } finally {
    // Kill by PID only. Never by image name: this host is reached over Chrome Remote Desktop and an
    // image-name kill would disconnect the operator.
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    await sleep(1200);
    try {
      rmSync(udd, { recursive: true, force: true });
    } catch {
      /* the engine may still hold a handle; the temp dir is disposable */
    }
  }
}

const shim = await startShim();
console.log(`local proxy shim listening on 127.0.0.1:${shim.port} (no upstream)\n`);

let results;
try {
  // One at a time, never concurrently: two engines racing for the GPU/PID space on this host has
  // produced flaky launches before.
  const direct = await fingerprint('direct');
  const viaProxy = await fingerprint('via-shim', { proxyPort: shim.port });
  results = [direct, viaProxy];
} finally {
  await shim.close();
}

const FIELDS = ['ja3_hash', 'ja3n_hash', 'ja4', 'ja4_r', 'akamai_hash', 'tls_version', 'user_agent'];
for (const r of results) {
  console.log(`### ${r.label}`);
  if (r.error || r.raw) {
    console.log(`  ${r.error ?? `unparsed: ${r.raw}`}`);
    continue;
  }
  for (const f of FIELDS) if (r[f] !== undefined) console.log(`  ${f.padEnd(12)} ${String(r[f]).slice(0, 110)}`);
  console.log('');
}

const [direct, viaProxy] = results;
if (direct?.error || viaProxy?.error || direct?.raw || viaProxy?.raw) {
  console.log('MEASUREMENT INCOMPLETE — cannot compare.');
  process.exit(2);
}

// ja3_hash is deliberately EXCLUDED from the verdict. GREASE (RFC 8701) randomises a cipher, an
// extension and a supported-group on every connection, so raw JA3 differs between two runs of the
// SAME binary — it was measured differing between two stock Chrome runs on this host. The
// normalised forms (ja3n, ja4, akamai) are the stable ones, and are what a real detector uses.
const STABLE = ['ja3n_hash', 'ja4', 'akamai_hash'];
let differing = 0;
console.log('--- through the shim vs direct, same binary, same endpoint ---');
for (const f of STABLE) {
  if (direct[f] === undefined && viaProxy[f] === undefined) continue;
  const same = direct[f] === viaProxy[f];
  if (!same) differing += 1;
  console.log(`  ${f.padEnd(11)} ${same ? 'IDENTICAL' : `DIFFERS  direct=${direct[f]}  shim=${viaProxy[f]}`}`);
}
const greaseNote = direct.ja3_hash === viaProxy.ja3_hash ? 'coincidentally equal' : 'differs (expected: GREASE)';
console.log(`  ${'ja3_hash'.padEnd(11)} ${greaseNote} — not part of the verdict`);
console.log('');

if (differing > 0) {
  console.log(`TLS-THROUGH-PROXY: FAILED — the shim changes ${differing} stable fingerprint field(s).`);
  console.log('Every profile with proxy credentials is classifiable at the handshake.');
  process.exit(1);
}
console.log('TLS-THROUGH-PROXY: PASSED — the shim does not alter the handshake.');
