#!/usr/bin/env node
// Lobium native-engine detector run.
//
// Launches the REAL Lobium binary (out/Lobium/chrome) with a full coherent persona — the native
// config channel (--lobium-fp-config: deep surfaces + navigator hardware) PLUS the CDP JS-safe
// surfaces (UA/UA-CH/timezone/locale) — connects over CDP, and:
//   (a) scores it against the live bot.sannysoft.com automation matrix, and
//   (b) directly measures the NATIVE deep surfaces (WebGL unmasked vendor/renderer, canvas hash,
//       audio hash) + navigator hardware, asserting the config actually applied.
// This is the end-to-end integration test the interim-engine harness (run.mjs) cannot be: it drives
// the actual engine we ship, so a config-channel wiring bug (key drift, unapplied surface) fails here.
//
//   LOBSTER_LOBIUM_BIN=/path/to/chrome node ci/validation/lobium-detect.mjs [seed]

import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { deriveFingerprint, generateSeed, applyGeoToFingerprint } from '@lobster/fingerprint';
import {
  buildLobiumConfig,
  writeLobiumConfig,
  lobiumConfigArg,
  applyCdpFingerprint,
  buildLaunchOptions,
} from '@lobster/engine-runner';

const LOBIUM = process.env.LOBSTER_LOBIUM_BIN || '/home/ivyhfx/lobium-build/src/out/Lobium/chrome';
const DETECTOR_URL = 'https://bot.sannysoft.com/';

async function readCdpEndpoint(userDataDir, retries = 150) {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let i = 0; i < retries; i += 1) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine)
        return `ws://127.0.0.1:${port}${pathLine.trim()}`;
    } catch {
      /* not written yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the Lobium CDP endpoint (DevToolsActivePort)');
}

// The in-page probe: everything a fingerprinter reads, so we can assert our config applied.
async function probePage(page, claimedRenderer, claimedVendor) {
  return page.evaluate(
    async ({ claimR, claimV }) => {
      const fnv = (s) => {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < s.length; i += 1) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16);
      };
      let webgl = { vendor: null, renderer: null };
      try {
        const gl =
          document.createElement('canvas').getContext('webgl') ||
          document.createElement('canvas').getContext('experimental-webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          webgl = {
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : null,
            renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : null,
          };
        }
      } catch {
        /* no webgl */
      }
      let canvasHash = null;
      try {
        const c = document.createElement('canvas');
        c.width = 220;
        c.height = 40;
        const x = c.getContext('2d');
        x.textBaseline = 'top';
        x.font = "14px 'Arial'";
        x.fillStyle = '#f60';
        x.fillRect(0, 0, 110, 20);
        x.fillStyle = '#069';
        x.fillText('Lobster \u{1F99E} 12345', 2, 15);
        canvasHash = fnv(c.toDataURL());
      } catch {
        /* no 2d */
      }
      let audioHash = null;
      try {
        const octx = new OfflineAudioContext(1, 5000, 44100);
        const o = octx.createOscillator();
        o.type = 'triangle';
        o.frequency.value = 10000;
        const cm = octx.createDynamicsCompressor();
        o.connect(cm);
        cm.connect(octx.destination);
        o.start(0);
        const buf = await octx.startRendering();
        const ch = buf.getChannelData(0);
        let s = 0;
        for (let i = 4500; i < 5000; i += 1) s += Math.abs(ch[i]);
        audioHash = s.toFixed(8);
      } catch {
        /* no audio */
      }
      // navigator.userAgentData (secure-context only) — a modern Chrome ALWAYS has it; a Chrome UA
      // with undefined userAgentData is a hard tell. Capture brands + high-entropy version list.
      let uaData = { present: false };
      try {
        if (navigator.userAgentData) {
          const high = await navigator.userAgentData.getHighEntropyValues([
            'fullVersionList',
            'uaFullVersion',
            'platformVersion',
          ]);
          uaData = {
            present: true,
            brands: navigator.userAgentData.brands,
            platform: navigator.userAgentData.platform,
            fullVersionList: high.fullVersionList,
            uaFullVersion: high.uaFullVersion,
            platformVersion: high.platformVersion,
          };
        }
      } catch (e) {
        uaData = { present: false, error: String(e).slice(0, 80) };
      }
      const uaMajor = (/Chrome\/(\d+)/.exec(navigator.userAgent) || [])[1] || null;
      return {
        userAgent: navigator.userAgent,
        uaMajor,
        webdriver: navigator.webdriver === true,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        maxTouchPoints: navigator.maxTouchPoints,
        platform: navigator.platform,
        languages: Array.from(navigator.languages),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        uaData,
        webgl,
        webglMatchesClaim: webgl.renderer === claimR && webgl.vendor === claimV,
        canvasHash,
        audioHash,
      };
    },
    { claimR: claimedRenderer, claimV: claimedVendor },
  );
}

// CreepJS is the high-signal detector: it computes a trust score and flags "lies" (surfaces whose
// self-report is internally inconsistent — exactly what a spoofing engine risks). Scrape the score,
// the lies count, and the specific lied-about surfaces so a coherence tell points at its cause.
async function measureCreepjs(page) {
  await page.goto('https://abrahamjuliot.github.io/creepjs/', {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  // CreepJS computes asynchronously and renders the trust score late — poll (up to ~40s) until the
  // "trust score" text appears rather than guessing a fixed wait.
  const extract = () =>
    page.evaluate(() => {
      const text = (document.documentElement.textContent || '').replace(/\s+/g, ' ');
      // CreepJS renders e.g. "trust score 72% ..." and "1 lie"/"lies (1)". Try several shapes.
      const trust =
        /trust score[:\s]*([\d.]+)\s*%/i.exec(text) || /([\d.]+)\s*%\s*trust/i.exec(text);
      const liesN = /lies?\s*\((\d+)\)/i.exec(text) || /(\d+)\s*lies\b/i.exec(text);
      const bot = /bot[:\s]*([\d.]+)/i.exec(text);
      return {
        trustScore: trust ? Number(trust[1]) : null,
        lies: liesN ? Number(liesN[1]) : null,
        bot: bot ? bot[1] : null,
      };
    });
  let r = { trustScore: null, lies: null, bot: null, lieItems: [] };
  for (let i = 0; i < 20; i += 1) {
    await new Promise((res) => setTimeout(res, 2000));
    r = await extract();
    if (r.trustScore !== null || r.lies !== null) break;
  }
  return r;
}

async function main() {
  if (!existsSync(LOBIUM)) {
    process.stderr.write(`Lobium binary not found at ${LOBIUM} (set LOBSTER_LOBIUM_BIN)\n`);
    process.exitCode = 2;
    return;
  }
  const seed = process.argv[2] || generateSeed();
  const fp = applyGeoToFingerprint(deriveFingerprint(seed, { os: 'windows', engine: 'lobium' }), {
    ip: '0.0.0.0',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.405,
  });
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobium-detect-'));
  const cfg = buildLobiumConfig(fp, { seed });
  const cfgPath = await writeLobiumConfig(userDataDir, cfg);

  // Use the PRODUCT's own launch options so this is a faithful integration test — same WebRTC
  // IP-handling policy, --lang, --window-size, and automation-control flag the real launcher applies —
  // then add the bits specific to launching the native binary directly + a CDP port for connectOverCDP.
  const launch = buildLaunchOptions({
    profileId: 'lobium-detect',
    engine: 'lobium',
    userDataDir,
    fingerprint: fp,
    headless: true,
  });
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    '--enable-unsafe-swiftshader',
    `--user-data-dir=${userDataDir}`,
    lobiumConfigArg(cfgPath),
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...launch.args,
  ];
  const proc = spawn(LOBIUM, args, { stdio: 'ignore' });

  let report;
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      const cdp = await context.newCDPSession(page);
      await applyCdpFingerprint(cdp, fp);
      await page.goto(DETECTOR_URL, { waitUntil: 'networkidle', timeout: 60_000 });

      const rows = await page.$$eval('table tr', (trs) =>
        trs
          .map((tr) => {
            const c = Array.from(tr.querySelectorAll('td'));
            if (c.length < 2) return null;
            const cls = c[1].className || '';
            return {
              name: (c[0].textContent || '').trim().slice(0, 60),
              value: (c[1].textContent || '').trim().slice(0, 80),
              status: cls.includes('failed')
                ? 'failed'
                : cls.includes('passed')
                  ? 'passed'
                  : 'info',
            };
          })
          .filter(Boolean),
      );
      const failed = rows.filter((r) => r.status === 'failed');
      const nat = await probePage(page, fp.webgl.unmaskedRenderer, fp.webgl.unmaskedVendor);

      // WebRTC IP-leak check: gather ICE candidates against a STUN server and flag any that expose a
      // routable address (public IPv4 or global IPv6) — the deanonymising leak the policy must stop.
      // No proxy is configured here, so the applied policy is default_public_interface_only; this
      // reports whether that alone still leaks (CreepJS showed a global IPv6), separately from the
      // proxied disable_non_proxied_udp path that run.mjs gates.
      const webrtc = await page.evaluate(
        () =>
          new Promise((resolve) => {
            const cands = [];
            const pc = new RTCPeerConnection({
              iceServers: [{ urls: 'stun:stun.l.google.com:19302' }],
            });
            pc.createDataChannel('p');
            pc.onicecandidate = (e) => (e.candidate ? cands.push(e.candidate.candidate) : null);
            pc.createOffer().then((o) => pc.setLocalDescription(o));
            setTimeout(() => {
              const addr = (c) => (c.split(' ')[4] || '').toLowerCase();
              const isGlobalV6 = (a) => a.includes(':') && /^[23]/.test(a);
              const isPublicV4 = (a) =>
                /^\d+\.\d+\.\d+\.\d+$/.test(a) &&
                !/^(10|127|0|169\.254|192\.168|172\.(1[6-9]|2\d|3[01])|100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7]))\./.test(
                  a,
                );
              const leaks = cands.map(addr).filter((a) => a && (isGlobalV6(a) || isPublicV4(a)));
              // NOTE: with NO proxy, seeing the real public IP here is EXPECTED and coherent (it is the
              // host's actual IP, consistent with the TCP connection). The deanonymising case is a
              // public IP leaking THROUGH a proxy — suppressed by disable_non_proxied_udp and gated by
              // run.mjs. So publicLeaks is reported, not verdict-failing, in this no-proxy harness.
              resolve({
                note: 'no-proxy run: public IP is the real host IP (coherent), not a proxy bypass',
                total: cands.length,
                publicIps: [...new Set(leaks)].slice(0, 4),
              });
            }, 4000);
          }),
      );

      const creepjs = process.env.LOBSTER_CREEPJS
        ? await measureCreepjs(page).catch((e) => ({ error: String(e).slice(0, 120) }))
        : 'skipped (set LOBSTER_CREEPJS=1)';

      const checks = {
        webdriverAbsent: nat.webdriver === false,
        userAgentApplied: nat.userAgent === fp.navigator.userAgent,
        hardwareConcurrencyApplied: nat.hardwareConcurrency === fp.navigator.hardwareConcurrency,
        deviceMemoryApplied: nat.deviceMemory === fp.navigator.deviceMemory,
        maxTouchPointsApplied: nat.maxTouchPoints === fp.navigator.maxTouchPoints,
        languagesApplied: nat.languages.join(',') === fp.navigator.languages.join(','),
        timezoneApplied: nat.timezone === fp.locale.timezone,
        webglMatchesClaim: nat.webglMatchesClaim,
      };
      const surfacesApplied = Object.values(checks).filter((v) => v === true).length;

      report = {
        engine: 'lobium',
        binary: LOBIUM,
        seed,
        detector: DETECTOR_URL,
        claimed: {
          userAgent: fp.navigator.userAgent,
          hardwareConcurrency: fp.navigator.hardwareConcurrency,
          deviceMemory: fp.navigator.deviceMemory,
          maxTouchPoints: fp.navigator.maxTouchPoints,
          languages: fp.navigator.languages,
          timezone: fp.locale.timezone,
          webglVendor: fp.webgl.unmaskedVendor,
          webglRenderer: fp.webgl.unmaskedRenderer,
        },
        observed: nat,
        checks,
        surfacesApplied: `${surfacesApplied}/${Object.keys(checks).length}`,
        sannysoft: {
          total: rows.length,
          passed: rows.filter((r) => r.status === 'passed').length,
          info: rows.filter((r) => r.status === 'info').length,
          failed: failed.length,
          failedTests: failed.map((r) => r.name),
        },
        webrtc,
        creepjs,
        verdict:
          Object.values(checks).every((v) => v === true) && failed.length === 0 ? 'pass' : 'review',
      };
    } finally {
      await browser.close();
    }
  } finally {
    proc.kill('SIGKILL');
    // Give the killed browser a moment to release its user-data files, then best-effort remove (a
    // late Chrome write otherwise races the rmdir into ENOTEMPTY — a cleanup nuisance, not a failure).
    await new Promise((r) => setTimeout(r, 500));
    await rm(userDataDir, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exitCode = 3;
});
