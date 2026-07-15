#!/usr/bin/env node
// Lobium native-engine detector run.
//
// Launches the REAL Lobium binary (out/Lobium/chrome) with a full coherent persona — the native
// config channel + production process/prefs (NO Patchright fingerprint overlay), connects over CDP, and:
//   (a) scores it against the live bot.sannysoft.com automation matrix, and
//   (b) directly measures the NATIVE deep surfaces (WebGL unmasked vendor/renderer, canvas hash,
//       audio hash) + navigator hardware, asserting the config actually applied.
// This is the end-to-end integration test the interim-engine harness (run.mjs) cannot be: it drives
// the actual engine we ship, so a config-channel wiring bug (key drift, unapplied surface) fails here.
//
//   LOBSTER_LOBIUM_BIN=/path/to/chrome node ci/validation/lobium-detect.mjs [seed]

import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { deriveFingerprint, generateSeed, applyGeoToFingerprint } from '@lobster/fingerprint';
import {
  buildLobiumConfig,
  writeLobiumConfig,
  lobiumConfigArg,
  buildLaunchOptions,
  probeLobiumBuildCapabilities,
  resolveLobiumBinary,
  buildGpuArgs,
  isSoftwareRenderer,
  resolveGpuMode,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const LOBIUM = resolveLobiumBinary();
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
      // Worker cross-context coherence: a Worker/SharedWorker that leaks the real host UA/platform while
      // the main frame claims another OS is a glaring lie (CreepJS reads it). Confirm both worker types
      // report the SAME userAgent + platform as the main thread.
      let workers = { ok: null };
      try {
        const code =
          'self.onconnect=e=>e.ports[0].postMessage({ua:navigator.userAgent,plat:navigator.platform});' +
          'self.postMessage&&self.postMessage({ua:navigator.userAgent,plat:navigator.platform});';
        const dw = await new Promise((res) => {
          const w = new Worker(URL.createObjectURL(new Blob([code])));
          w.onmessage = (e) => res(e.data);
          setTimeout(() => res(null), 3000);
        });
        let sw = null;
        try {
          const s = new SharedWorker(URL.createObjectURL(new Blob([code])));
          sw = await new Promise((res) => {
            s.port.onmessage = (e) => res(e.data);
            s.port.start();
            setTimeout(() => res(null), 3000);
          });
        } catch {
          /* shared worker unavailable */
        }
        const sameOS = (w) => w && w.ua === navigator.userAgent && w.plat === navigator.platform;
        workers = {
          dedicated: dw
            ? { uaMatch: dw.ua === navigator.userAgent, platMatch: dw.plat === navigator.platform }
            : null,
          shared: sw
            ? { uaMatch: sw.ua === navigator.userAgent, platMatch: sw.plat === navigator.platform }
            : null,
          ok: sameOS(dw) && (sw === null || sameOS(sw)),
        };
      } catch (e) {
        workers = { ok: null, error: String(e).slice(0, 80) };
      }
      return {
        userAgent: navigator.userAgent,
        uaMajor,
        workers,
        screen: {
          width: screen.width,
          height: screen.height,
          availWidth: screen.availWidth,
          availHeight: screen.availHeight,
          colorDepth: screen.colorDepth,
          devicePixelRatio: window.devicePixelRatio,
        },
        webdriver: navigator.webdriver === true,
        hardwareConcurrency: navigator.hardwareConcurrency,
        deviceMemory: navigator.deviceMemory ?? null,
        maxTouchPoints: navigator.maxTouchPoints,
        platform: navigator.platform,
        languages: Array.from(navigator.languages),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        intlLocale: Intl.DateTimeFormat().resolvedOptions().locale,
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

// CreepJS is the high-signal detector: it flags "lies" (internally inconsistent surfaces) and
// headless/bot ratings. Current CreepJS no longer renders a "trust score" percentage — it exposes
// `window.Fingerprint` in the page main world instead. Patchright's page.evaluate runs in an
// isolated world, so we read Fingerprint via CDP Runtime.evaluate and fall back to DOM text.
async function measureCreepjs(page, cdp) {
  await page.goto('https://abrahamjuliot.github.io/creepjs/', {
    waitUntil: 'networkidle',
    timeout: 60_000,
  });
  const session = cdp ?? (await page.context().newCDPSession(page));

  const extractFromMainWorld = async () => {
    try {
      const { result } = await session.send('Runtime.evaluate', {
        expression: `(() => {
          const fp = window.Fingerprint;
          if (!fp) return null;
          const lieData = (fp.lies && fp.lies.data) || {};
          return {
            lies: fp.lies && typeof fp.lies.totalLies === 'number' ? fp.lies.totalLies : null,
            lieItems: Object.keys(lieData).slice(0, 40),
            bot: fp.headless && fp.headless.headlessRating != null
              ? String(fp.headless.headlessRating)
              : null,
            headless: fp.headless
              ? {
                  chromium: fp.headless.chromium ?? null,
                  headlessRating: fp.headless.headlessRating ?? null,
                  likeHeadlessRating: fp.headless.likeHeadlessRating ?? null,
                  stealthRating: fp.headless.stealthRating ?? null,
                }
              : null,
            trashItems: ((fp.trash && fp.trash.trashBin) || [])
              .map((t) => (t && t.name) || String(t))
              .slice(0, 20),
          };
        })()`,
        returnByValue: true,
      });
      return result?.value ?? null;
    } catch {
      return null;
    }
  };

  const extractFromDom = () =>
    page.evaluate(() => {
      const text = (document.body?.innerText || document.documentElement.textContent || '').replace(
        /\s+/g,
        ' ',
      );
      // Legacy shapes (older CreepJS builds still used these).
      const trust =
        /trust score[:\s]*([\d.]+)\s*%/i.exec(text) || /([\d.]+)\s*%\s*trust/i.exec(text);
      const liesN = /lies?\s*\((\d+)\)/i.exec(text) || /(\d+)\s*lies\b/i.exec(text);
      const headlessRating = /(\d+)\s*%\s*headless:/i.exec(text);
      const likeHeadless = /(\d+)\s*%\s*like headless:/i.exec(text);
      const stealth = /(\d+)\s*%\s*stealth:/i.exec(text);
      const fpHeader = (
        document.getElementById('creep-fingerprint') ||
        document.querySelector('.fingerprint-header')
      )?.innerText
        ?.replace(/\s+/g, ' ')
        ?.trim();
      const fuzzyText = document.getElementById('fuzzy-fingerprint')?.innerText?.replace(/\s+/g, ' ');
      const fingerprintHash = /FP ID:\s*([a-f0-9]{16,})/i.exec(fpHeader || '')?.[1] || null;
      const fuzzyHash = /Fuzzy:\s*([a-f0-9]+)/i.exec(fuzzyText || '')?.[1] || null;
      const rejectedSections = Array.from(
        document.querySelectorAll('.relative.rejected strong, .rejected > strong'),
      )
        .map((s) => (s.textContent || '').trim())
        .filter(Boolean)
        .slice(0, 30);
      return {
        trustScore: trust ? Number(trust[1]) : null,
        lies: liesN ? Number(liesN[1]) : null,
        bot: headlessRating ? headlessRating[1] : null,
        likeHeadlessRating: likeHeadless ? Number(likeHeadless[1]) : null,
        stealthRating: stealth ? Number(stealth[1]) : null,
        fingerprintHash,
        fuzzyHash,
        rejectedSections,
      };
    });

  let r = {
    trustScore: null,
    lies: null,
    bot: null,
    lieItems: [],
    headless: null,
    trashItems: [],
    fingerprintHash: null,
    fuzzyHash: null,
  };
  for (let i = 0; i < 25; i += 1) {
    await new Promise((res) => setTimeout(res, 2000));
    const [main, dom] = await Promise.all([extractFromMainWorld(), extractFromDom()]);
    r = {
      trustScore: dom.trustScore,
      lies: main?.lies ?? dom.lies,
      bot: main?.bot ?? dom.bot,
      lieItems:
        main?.lieItems?.length > 0
          ? main.lieItems
          : dom.rejectedSections?.length
            ? dom.rejectedSections
            : [],
      headless: main?.headless ?? {
        chromium: null,
        headlessRating: dom.bot != null ? Number(dom.bot) : null,
        likeHeadlessRating: dom.likeHeadlessRating,
        stealthRating: dom.stealthRating,
      },
      trashItems: main?.trashItems ?? [],
      fingerprintHash: dom.fingerprintHash,
      fuzzyHash: dom.fuzzyHash,
    };
    // Ready once Fingerprint landed (lies is a number, including 0) or legacy trust text appeared.
    if (r.lies !== null || r.trustScore !== null || (main && r.fingerprintHash)) break;
  }
  if (r.trustScore === null) {
    r.trustScoreNote =
      'CreepJS no longer renders a trust score %; lies/bot come from window.Fingerprint (CDP main world) + headless ratings';
  }
  return r;
}

async function main() {
  if (!LOBIUM || !existsSync(LOBIUM)) {
    process.stderr.write(
      'Lobium binary not found (set LOBSTER_LOBIUM_BIN, LOBSTER_LOBIUM_DIR, or place it in a known engine directory)\n',
    );
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
  await probeLobiumBuildCapabilities(LOBIUM);
  const cfg = buildLobiumConfig(fp, { seed });
  const cfgPath = await writeLobiumConfig(userDataDir, cfg);
  await mkdir(join(userDataDir, 'Default'), { recursive: true });
  await writeFile(
    join(userDataDir, 'Default', 'Preferences'),
    `${JSON.stringify({
      intl: {
        accept_languages: fp.navigator.languages.join(','),
        selected_languages: fp.navigator.languages.join(','),
      },
    })}\n`,
  );
  await writeFile(
    join(userDataDir, 'Local State'),
    `${JSON.stringify({ intl: { app_locale: fp.locale.locale } })}\n`,
  );

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
  // GPU policy: on a real GPU host set LOBSTER_GPU=gpu (optionally LOBSTER_ANGLE_BACKEND=vulkan) to
  // render the deep WebGL surfaces on the physical driver. In that mode we must NOT force SwiftShader —
  // doing so is exactly the software-rendering trap that makes a "real-GPU" baseline meaningless. The
  // product launch path (buildLaunchOptions -> launch.args) already appends the ANGLE flags for `gpu`
  // mode, so we only add the SwiftShader fallback for `auto`/`software` (CI / no-GPU).
  const gpuMode = resolveGpuMode();
  const args = [
    '--headless=new',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(gpuMode === 'gpu' ? [] : ['--enable-unsafe-swiftshader']),
    `--user-data-dir=${userDataDir}`,
    lobiumConfigArg(cfgPath),
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    ...launch.args,
  ];
  // When launch.args did not carry GPU flags (e.g. this harness is run standalone), still honor an
  // explicit gpu request so the detector alone can produce a real-GPU report.
  if (gpuMode === 'gpu' && !args.some((a) => a.startsWith('--use-angle='))) {
    args.push(...buildGpuArgs({ mode: 'gpu' }));
  }
  const processLocale = `${fp.locale.locale.replaceAll('-', '_')}.UTF-8`;
  const proc = spawn(LOBIUM, args, {
    stdio: 'ignore',
    env: { ...process.env, TZ: fp.locale.timezone, LANG: processLocale, LC_ALL: processLocale },
  });

  let report;
  try {
    const ws = await readCdpEndpoint(userDataDir);
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      const cdp = await context.newCDPSession(page);
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
        ? await measureCreepjs(page, cdp).catch((e) => ({ error: String(e).slice(0, 120) }))
        : 'skipped (set LOBSTER_CREEPJS=1)';

      const checks = {
        webdriverAbsent: nat.webdriver === false,
        userAgentApplied: nat.userAgent === fp.navigator.userAgent,
        hardwareConcurrencyApplied: nat.hardwareConcurrency === fp.navigator.hardwareConcurrency,
        deviceMemoryApplied: nat.deviceMemory === fp.navigator.deviceMemory,
        maxTouchPointsApplied: nat.maxTouchPoints === fp.navigator.maxTouchPoints,
        languagesApplied: nat.languages.join(',') === fp.navigator.languages.join(','),
        timezoneApplied: nat.timezone === fp.locale.timezone,
        intlLocaleApplied: nat.intlLocale === fp.locale.locale,
        webglMatchesClaim: nat.webglMatchesClaim,
        // Workers must not leak the real host UA/platform (null = not measured, don't fail the gate).
        workerCoherent: nat.workers?.ok !== false,
        screenApplied:
          nat.screen.width === fp.screen.width &&
          nat.screen.height === fp.screen.height &&
          nat.screen.colorDepth === fp.screen.colorDepth &&
          Math.abs(nat.screen.devicePixelRatio - fp.screen.devicePixelRatio) < 0.001,
      };
      const surfacesApplied = Object.values(checks).filter((v) => v === true).length;

      // Software-rendering guard: a real-GPU run whose renderer is SwiftShader/llvmpipe is a false
      // baseline. Flag it explicitly so it can never masquerade as real-GPU evidence.
      const observedRenderer = nat.webgl?.renderer ?? nat.webgl?.vendor ?? null;
      const softwareRenderer = isSoftwareRenderer(observedRenderer);

      report = {
        schemaVersion: 1,
        kind: 'lobium-detect',
        capturedAt: new Date().toISOString(),
        engine: 'lobium',
        binary: LOBIUM,
        seed,
        gpuMode,
        headless: true,
        softwareRenderer,
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
        // In an explicit real-GPU run, a software renderer invalidates the baseline — never let it pass.
        verdict:
          Object.values(checks).every((v) => v === true) &&
          failed.length === 0 &&
          !(gpuMode === 'gpu' && softwareRenderer)
            ? 'pass'
            : 'review',
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

  await mkdir(REPORTS_DIR, { recursive: true });
  const stamp = (report.capturedAt || new Date().toISOString()).replace(/[:.]/g, '-');
  const outPath = join(REPORTS_DIR, `lobium-detect-${stamp}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nsaved: ${outPath}\n`);
  if (report.verdict !== 'pass') process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exitCode = 3;
});
