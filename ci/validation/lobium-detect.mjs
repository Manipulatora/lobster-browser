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
      return {
        userAgent: navigator.userAgent,
        webdriver: navigator.webdriver === true,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        maxTouchPoints: navigator.maxTouchPoints,
        platform: navigator.platform,
        languages: Array.from(navigator.languages),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        webgl,
        webglMatchesClaim: webgl.renderer === claimR && webgl.vendor === claimV,
        canvasHash,
        audioHash,
      };
    },
    { claimR: claimedRenderer, claimV: claimedVendor },
  );
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
    '--disable-blink-features=AutomationControlled',
    `--lang=${fp.locale.locale}`,
    `--window-size=${fp.screen.width},${fp.screen.height}`,
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
        verdict:
          Object.values(checks).every((v) => v === true) && failed.length === 0 ? 'pass' : 'review',
      };
    } finally {
      await browser.close();
    }
  } finally {
    proc.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
  }

  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exitCode = 3;
});
