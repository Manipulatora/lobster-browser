#!/usr/bin/env node
// TLS/HTTP2 network-fingerprint gate (Item 3 baseline).
//
// Because Lobium IS a real Chromium build, its ClientHello (JA3/JA4) and HTTP/2 SETTINGS (Akamai H2)
// should equal a genuine Chrome's — coherent with the UA by construction. This launches a persona and
// reads its live JA3/JA4/H2 from a TLS-echo service, asserting the JA4 is the Chrome-family shape.
//
// It drives the browser via the project's FIRST-PARTY CDP client (cdp-client.ts) — no patchright.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

const LOBIUM = resolveLobiumBinary();
const ECHO = process.env.TLS_ECHO_URL || 'https://tls.peet.ws/api/all';
const GEO = { ip: '0.0.0.0', countryCode: 'US', timezone: 'America/New_York', latitude: 40.7, longitude: -74 };

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

async function run(os) {
  const seed = `tls-${os}`;
  const fp = applyGeoToFingerprint(deriveFingerprint(seed, { os, engine: 'lobium' }), GEO);
  const dir = await mkdtemp(join(tmpdir(), `tls-${os}-`));
  const cfg = await writeLobiumConfig(dir, buildLobiumConfig(fp, { seed }));
  const launch = buildLaunchOptions({ profileId: seed, engine: 'lobium', userDataDir: dir, fingerprint: fp, headless: true });
  const args = [
    '--headless=new', '--no-sandbox', ...buildDevShmArgs(), '--enable-unsafe-swiftshader',
    `--user-data-dir=${dir}`, lobiumConfigArg(cfg), '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', ...launch.args,
  ];
  const proc = spawn(LOBIUM, args, { stdio: 'ignore', env: { ...process.env, TZ: fp.locale.timezone } });
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
        return text;
      },
      { timeoutMs: 60_000 },
    ).then((text) => {
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
        userAgent: (data.http1?.headers || data.tls?.peetprint ? undefined : undefined) ?? fp.navigator.userAgent,
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

// This gate reads a REAL ClientHello, so it needs the real engine. Say so plainly instead of failing
// deep inside `spawn(undefined, …)` — regression-gate surfaces this line as the check's detail, and a
// cryptic ENOENT there is exactly how a broken harness stays broken.
if (!LOBIUM) {
  console.log('TLS GATE: SKIPPED — no Lobium binary (set LOBSTER_LOBIUM_BIN, or SKIP_TLS=1 to skip).');
  process.exit(2);
}

let ok = true;
for (const os of (process.env.OSES || 'windows').split(',')) {
  const r = await run(os);
  console.log(JSON.stringify(r, null, 1));
  if (!r.chromeShapedJa4) ok = false;
}
console.log(ok ? '\nTLS GATE: PASS — JA4 is Chrome-family (t13d…h2)' : '\nTLS GATE: FAIL — JA4 not Chrome-shaped');
process.exit(ok ? 0 : 1);
