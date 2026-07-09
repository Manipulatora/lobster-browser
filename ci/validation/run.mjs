#!/usr/bin/env node
// Anti-detect validation harness (T-005).
//
// Derives a real-device fingerprint, launches it through the REAL engine-runner launcher (patched
// Chromium via patchright, headful under Xvfb in CI), drives it against a live detector
// (bot.sannysoft.com), and asserts our injected fingerprint actually applied with no automation
// tell. Emits a JSON report and a pass/fail exit code against ci/validation/thresholds.json.
//
//   node ci/validation/run.mjs            # real run (needs a browser; use `xvfb-run -a` for headful)
//   node ci/validation/run.mjs --stub     # wiring-only (green where no browser is installed)

import { readFile } from 'node:fs/promises';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

import { applyGeoToFingerprint, deriveFingerprint, generateSeed } from '@lobster/fingerprint';
import {
  applyCdpFingerprint,
  buildCdpEmulation,
  buildLaunchOptions,
  isChromiumAvailable,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const DETECTOR_URL = 'https://bot.sannysoft.com/';
const STUN_URL = 'stun:stun.l.google.com:19302';

// --- WebRTC ICE candidate classification (leak detection) ----------------------------------------
// An ICE candidate line is `candidate:<foundation> <component> <transport> <priority> <ADDRESS> <port> typ ...`.
// The connection address is token index 4 — parse it directly rather than regex-scanning the whole line.
function candidateAddress(c) {
  return (c.split(' ')[4] || '').toLowerCase();
}
function isPrivateIpv4(ip) {
  const [a, b] = ip.split('.').map(Number);
  return (
    a === 10 ||
    a === 127 ||
    a === 0 ||
    (a === 169 && b === 254) || // link-local
    (a === 192 && b === 168) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 100 && b >= 64 && b <= 127) // CGNAT 100.64/10
  );
}
// 'masked' = mDNS .local (safe) · 'private4'/'local6' = local addr (mDNS should have masked it) ·
// 'public4'/'global6' = a real routable address that deanonymises the host (2000::/3 = global IPv6).
function classifyAddress(addr) {
  if (!addr || addr.endsWith('.local')) return 'masked';
  if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(addr))
    return isPrivateIpv4(addr) ? 'private4' : 'public4';
  if (addr.includes(':')) return /^[23]/.test(addr) ? 'global6' : 'local6';
  return 'other';
}
const isPublicLeak = (c) => ['public4', 'global6'].includes(classifyAddress(candidateAddress(c)));
const isLocalLeak = (c) => classifyAddress(candidateAddress(c)) !== 'masked';

/**
 * Decide WebRTC leak protection WITHOUT a vacuous pass. The suppression assertion — the protected run
 * (`disable_non_proxied_udp` + STUN) emits no public-IP srflx — only has teeth if the probe can
 * actually surface a leak in the first place. So a CONTROL run (`default_public_interface_only` +
 * STUN) MUST leak (`controlLeakCount > 0`). If it does not (no network / STUN unreachable in CI), the
 * "no public leak" observation is meaningless, so we return `null` = not-measured (skip) instead of a
 * bogus pass. Only once the control proves the probe works is a real `true`/`false` verdict returned.
 * @returns {boolean|null} true = protected · false = leaked/misconfigured · null = not measured (skip)
 */
export function evaluateWebrtcLeakProtection({
  policyApplied,
  localLeakCount,
  controlLeakCount,
  suppressionLeakCount,
}) {
  if (!(controlLeakCount > 0)) return null; // control never leaked → probe unproven → not-measured
  return policyApplied && localLeakCount === 0 && suppressionLeakCount === 0;
}

/** Gather ICE candidates from a throwaway headless context with `extraArgs` (optionally via STUN). */
async function probeIceCandidates(chromium, extraArgs, useStun) {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-webrtc-'));
  const ctx = await chromium.launchPersistentContext(dir, {
    headless: true,
    args: ['--no-sandbox', '--disable-dev-shm-usage', ...extraArgs],
  });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto('about:blank');
    return await page.evaluate(
      (stun) =>
        new Promise((resolve) => {
          const out = [];
          const pc = new RTCPeerConnection({ iceServers: stun ? [{ urls: stun }] : [] });
          pc.createDataChannel('probe');
          pc.onicecandidate = (e) => (e.candidate ? out.push(e.candidate.candidate) : resolve(out));
          pc.createOffer().then((o) => pc.setLocalDescription(o));
          setTimeout(() => resolve(out), 8000);
        }),
      useStun ? STUN_URL : null,
    );
  } finally {
    await ctx.close();
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Best-effort CreepJS measurement (env-gated: `LOBSTER_CREEPJS=1`). Launches a throwaway profile with
 * our fingerprint applied, loads CreepJS, and scrapes lies + headless/bot ratings. Deliberately
 * defensive — CreepJS is a research page whose DOM shifts — so it returns `{available:false}` rather
 * than throwing. Current CreepJS no longer renders "trust score %"; it exposes `window.Fingerprint`
 * in the page main world (read via CDP — Patchright page.evaluate is isolated). NOTE: CreepJS
 * specifically detects JS-based deep-surface spoofing, so on the interim engine trust stays low /
 * null until Lobium's native patches land.
 */
async function measureCreepjs(chromium, fingerprint, emulation, options) {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-creepjs-'));
  const context = await chromium.launchPersistentContext(dir, {
    headless: false,
    args: [...options.args, '--no-sandbox', '--disable-dev-shm-usage'],
    userAgent: emulation.userAgent,
    locale: emulation.locale,
    timezoneId: emulation.timezoneId,
  });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    const cdp = await context.newCDPSession(page);
    await applyCdpFingerprint(cdp, fingerprint);
    await page.goto('https://abrahamjuliot.github.io/creepjs/', {
      waitUntil: 'networkidle',
      timeout: 60_000,
    });
    let parsed = {
      trustScore: null,
      lies: null,
      bot: null,
      lieItems: [],
      fingerprintHash: null,
    };
    for (let i = 0; i < 20; i += 1) {
      await new Promise((r) => setTimeout(r, 2000));
      const { result } = await cdp
        .send('Runtime.evaluate', {
          expression: `(() => {
            const fp = window.Fingerprint;
            if (!fp) return null;
            return {
              lies: fp.lies && typeof fp.lies.totalLies === 'number' ? fp.lies.totalLies : null,
              lieItems: Object.keys((fp.lies && fp.lies.data) || {}).slice(0, 40),
              bot: fp.headless && fp.headless.headlessRating != null
                ? String(fp.headless.headlessRating) : null,
              headlessRating: fp.headless?.headlessRating ?? null,
              likeHeadlessRating: fp.headless?.likeHeadlessRating ?? null,
              stealthRating: fp.headless?.stealthRating ?? null,
            };
          })()`,
          returnByValue: true,
        })
        .catch(() => ({ result: { value: null } }));
      const main = result?.value;
      const dom = await page.evaluate(() => {
        const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
        const trust = /trust score[:\s]*([\d.]+)\s*%/i.exec(text);
        const lies = /lies?\s*\((\d+)\)/i.exec(text) || /(\d+)\s*lies\b/i.exec(text);
        const headless = /(\d+)\s*%\s*headless:/i.exec(text);
        const fpId = /FP ID:\s*([a-f0-9]{16,})/i.exec(
          (document.querySelector('.fingerprint-header')?.innerText || '').replace(/\s+/g, ' '),
        );
        return {
          trustScore: trust ? Number(trust[1]) : null,
          lies: lies ? Number(lies[1]) : null,
          bot: headless ? headless[1] : null,
          fingerprintHash: fpId ? fpId[1] : null,
        };
      });
      parsed = {
        trustScore: dom.trustScore,
        lies: main?.lies ?? dom.lies,
        bot: main?.bot ?? dom.bot,
        lieItems: main?.lieItems ?? [],
        fingerprintHash: dom.fingerprintHash,
        headless: main
          ? {
              headlessRating: main.headlessRating,
              likeHeadlessRating: main.likeHeadlessRating,
              stealthRating: main.stealthRating,
            }
          : null,
      };
      if (parsed.lies !== null || parsed.trustScore !== null) break;
    }
    if (parsed.trustScore === null) {
      parsed.trustScoreNote =
        'CreepJS no longer renders a trust score %; lies/bot from window.Fingerprint via CDP';
    }
    return {
      available: parsed.lies !== null || parsed.trustScore !== null || parsed.bot !== null,
      ...parsed,
    };
  } finally {
    await context.close();
    await rm(dir, { recursive: true, force: true });
  }
}

async function loadThresholds() {
  return JSON.parse(await readFile(join(here, 'thresholds.json'), 'utf8'));
}

function print(obj) {
  process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

async function runStub() {
  const thresholds = await loadThresholds();
  print({
    mode: 'stub',
    thresholdsLoaded: true,
    note: 'Real detector scraping runs without --stub (needs a browser). This only verifies wiring.',
    verdict: 'pass',
  });
}

async function runReal() {
  const thresholds = await loadThresholds();

  // 1. Derive a coherent real-device fingerprint, then apply a proxy geo (Berlin) exactly as the
  //    sidecar does at launch. This exercises the full geo-coherence cluster — timezone, locale,
  //    languages AND geolocation — so the gate proves they all actually apply together.
  const GEO = {
    ip: '0.0.0.0',
    countryCode: 'DE',
    timezone: 'Europe/Berlin',
    latitude: 52.52,
    longitude: 13.405,
  };
  const fingerprint = applyGeoToFingerprint(
    deriveFingerprint(generateSeed(), { os: 'windows', engine: 'chromium' }),
    GEO,
  );

  // 2. Build the launch exactly as the launcher does (canonical fingerprint -> browser mapping).
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobster-validation-'));
  const options = buildLaunchOptions({
    profileId: 'validation',
    engine: 'chromium',
    userDataDir,
    fingerprint,
    headless: false,
  });
  const emulation = buildCdpEmulation(fingerprint);

  const { chromium } = await import('patchright');
  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    args: [...options.args, '--no-sandbox', '--disable-dev-shm-usage'],
    userAgent: emulation.userAgent,
    locale: emulation.locale,
    timezoneId: emulation.timezoneId,
  });
  // Grant geolocation so a page that asks actually reads our override (the runtime user consent).
  await context.grantPermissions(['geolocation']);

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // Apply the JS-safe fingerprint via CDP (the same code path the launcher uses).
    const cdp = await context.newCDPSession(page);
    await applyCdpFingerprint(cdp, fingerprint);
    await page.goto(DETECTOR_URL, { waitUntil: 'networkidle', timeout: 60_000 });

    // 3a. Did our fingerprint actually apply, with no automation tell? (robust, engine-agnostic)
    const applied = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const base = {
            userAgent: navigator.userAgent,
            hardwareConcurrency: navigator.hardwareConcurrency,
            deviceMemory: navigator.deviceMemory,
            languages: Array.from(navigator.languages),
            webdriver: navigator.webdriver === true,
            timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
          };
          navigator.geolocation.getCurrentPosition(
            (p) =>
              resolve({
                ...base,
                geo: { latitude: p.coords.latitude, longitude: p.coords.longitude },
              }),
            () => resolve({ ...base, geo: null }),
            { timeout: 5000 },
          );
        }),
    );

    // 3a-bis. WebRTC leak protection — validated two ways, neither vacuous:
    //  (i) Local masking: the profile's own host candidates must all be mDNS `.local` (no raw private
    //      IPv4 or global IPv6 escapes). Gathered from THIS profile (no STUN, so only host candidates).
    //  (ii) Public-IP suppression: with the leak-protection policy (`disable_non_proxied_udp`) engaged
    //      AND a real STUN server, the browser must NOT emit a srflx candidate exposing the real public
    //      IP (v4 or global v6). This proves the policy the ticket adds actually stops the STUN leak —
    //      the control (`default_public_interface_only` + STUN) DOES leak, so the assertion has teeth.
    const iceCandidates = await page.evaluate(
      () =>
        new Promise((resolve) => {
          const out = [];
          const pc = new RTCPeerConnection({ iceServers: [] });
          pc.createDataChannel('probe');
          pc.onicecandidate = (e) => (e.candidate ? out.push(e.candidate.candidate) : resolve(out));
          pc.createOffer().then((o) => pc.setLocalDescription(o));
          setTimeout(() => resolve(out), 4000);
        }),
    );
    const suppressed = await probeIceCandidates(
      chromium,
      ['--force-webrtc-ip-handling-policy=disable_non_proxied_udp'],
      true, // via STUN — without the policy this WOULD surface the real public IP
    );
    // CONTROL: prove the probe can actually surface a leak. With `default_public_interface_only` +
    // STUN the browser SHOULD emit a public-IP srflx; if it does NOT (no network / STUN unreachable),
    // the suppressed run's zero-leak result is vacuous and the gate is skipped as not-measured.
    const control = await probeIceCandidates(
      chromium,
      ['--force-webrtc-ip-handling-policy=default_public_interface_only'],
      true, // via STUN — this run MUST leak for the suppression assertion to have teeth
    );

    const webrtcPolicyApplied = options.args.includes(
      '--force-webrtc-ip-handling-policy=default_public_interface_only',
    );
    const localLeaks = iceCandidates.filter(isLocalLeak);
    const suppressionLeaks = suppressed.filter(isPublicLeak);
    const controlLeaks = control.filter(isPublicLeak);

    const geo = fingerprint.locale.geolocation;
    const checks = {
      webdriverAbsent: applied.webdriver === false,
      userAgentApplied: applied.userAgent === fingerprint.navigator.userAgent,
      hardwareConcurrencyApplied:
        applied.hardwareConcurrency === fingerprint.navigator.hardwareConcurrency,
      // NOTE: deviceMemory/maxTouchPoints are JS-injection surfaces (no CDP global override exists).
      // The interim patchright engine neutralizes main-world injection, so these are native-on-Lobium
      // and reported for visibility but not gated here. `applied.deviceMemory` shows the current value.
      languagesApplied: applied.languages.join(',') === fingerprint.navigator.languages.join(','),
      timezoneApplied: applied.timezone === fingerprint.locale.timezone,
      geolocationApplied:
        !geo ||
        (applied.geo !== null &&
          Math.abs(applied.geo.latitude - geo.latitude) < 0.01 &&
          Math.abs(applied.geo.longitude - geo.longitude) < 0.01),
      // (i) our host candidates are mDNS-masked, AND (ii) the leak-protection policy suppresses the
      // STUN public-IP srflx, AND the correct policy value is applied to this profile. Gated only when
      // the CONTROL run proves the probe can leak; otherwise `null` = not-measured (see helper).
      webrtcLeakProtected: evaluateWebrtcLeakProtection({
        policyApplied: webrtcPolicyApplied,
        localLeakCount: localLeaks.length,
        controlLeakCount: controlLeaks.length,
        suppressionLeakCount: suppressionLeaks.length,
      }),
    };

    // 3a-ter. Deep-surface MEASUREMENT (canvas / WebGL / audio) — measured, NOT gated. These are the
    // surfaces Lobium spoofs natively; the interim engine structurally cannot (JS spoofing is itself a
    // tell, and patchright neutralizes it — see MASTER_PLAN §5). We measure and report the gap so the
    // detector matrix is complete and Lobium's arrival is objectively verifiable, without failing the
    // interim gate for something it cannot fix. On Lobium, `webgl.matchesClaim` becomes true and the
    // canvas/audio hashes become the per-profile farbled values from the config channel.
    const deep = await page.evaluate(async () => {
      const fnv = (s) => {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < s.length; i += 1) {
          h ^= s.charCodeAt(i);
          h = Math.imul(h, 16777619);
        }
        return (h >>> 0).toString(16);
      };
      let canvasHash = null;
      try {
        const c = document.createElement('canvas');
        c.width = 220;
        c.height = 40;
        const ctx = c.getContext('2d');
        ctx.textBaseline = 'top';
        ctx.font = "14px 'Arial'";
        ctx.fillStyle = '#f60';
        ctx.fillRect(0, 0, 110, 20);
        ctx.fillStyle = '#069';
        ctx.fillText('Lobster 🦞 12345', 2, 15);
        canvasHash = fnv(c.toDataURL());
      } catch {
        /* no 2d context */
      }
      let webgl = { vendor: null, renderer: null };
      try {
        const gl =
          document.createElement('canvas').getContext('webgl') ||
          document.createElement('canvas').getContext('experimental-webgl');
        if (gl) {
          const ext = gl.getExtension('WEBGL_debug_renderer_info');
          webgl = {
            vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
            renderer: ext
              ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)
              : gl.getParameter(gl.RENDERER),
          };
        }
      } catch {
        /* no WebGL */
      }
      let audioHash = null;
      try {
        const Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
        const octx = new Ctx(1, 5000, 44100);
        const osc = octx.createOscillator();
        osc.type = 'triangle';
        osc.frequency.value = 1000;
        const comp = octx.createDynamicsCompressor();
        osc.connect(comp);
        comp.connect(octx.destination);
        osc.start(0);
        const buf = await octx.startRendering();
        const ch = buf.getChannelData(0);
        let sum = 0;
        for (let i = 0; i < ch.length; i += 1) sum += Math.abs(ch[i]);
        audioHash = sum.toFixed(6);
      } catch {
        /* no AudioContext */
      }
      return { canvasHash, webgl, audioHash };
    });
    const deepSurfaces = {
      note: 'MEASUREMENT ONLY — native on Lobium; the interim engine leaks the host and is not gated here.',
      webgl: {
        claimed: fingerprint.webgl.unmaskedRenderer,
        actual: deep.webgl.renderer,
        matchesClaim: deep.webgl.renderer === fingerprint.webgl.unmaskedRenderer,
      },
      canvasHash: deep.canvasHash,
      audioHash: deep.audioHash,
    };

    // The full detector matrix: which detectors gate the build vs. which are measurements that only
    // become green once Lobium's native patches land (canvas/WebGL/audio/TLS). Keeps the plan honest.
    const detectorMatrix = {
      sannysoft: 'blocking (JS-safe surfaces + automation tells)',
      webrtc:
        'blocking (leak protection — gated only when the control run proves the probe can leak)',
      coherence:
        'measurement — enforced by @lobster/fingerprint unit tests (50-seed coherence sweep), not this harness',
      deepSurfaces: 'measurement — needs Lobium (canvas/WebGL/audio native farbling)',
      creepjs: process.env.LOBSTER_CREEPJS
        ? await measureCreepjs(chromium, fingerprint, emulation, options).catch((e) => ({
            available: false,
            error: String(e).slice(0, 120),
          }))
        : 'measurement — set LOBSTER_CREEPJS=1 to run (trust is low until Lobium; JS deep-surface spoofing is what CreepJS detects)',
    };

    // 3b. Scrape the Sannysoft detector matrix (each result cell is class passed/failed).
    const rows = await page.$$eval('table tr', (trs) =>
      trs
        .map((tr) => {
          const cells = Array.from(tr.querySelectorAll('td'));
          if (cells.length < 2) return null;
          const cls = cells[1].className || '';
          return {
            name: (cells[0].textContent || '').trim().slice(0, 60),
            value: (cells[1].textContent || '').trim().slice(0, 80),
            status: cls.includes('failed') ? 'failed' : cls.includes('passed') ? 'passed' : 'info',
          };
        })
        .filter(Boolean),
    );
    const failed = rows.filter((r) => r.status === 'failed');

    // A `null` check is "not measured" (skip) — it must not fail the gate, but `false` must.
    const directPass = Object.values(checks).every((v) => v !== false);
    const sannysoftPass = failed.length <= (thresholds.sannysoft?.maxFailed ?? 0);
    const verdict = directPass && sannysoftPass ? 'pass' : 'fail';

    print({
      mode: 'real',
      detector: DETECTOR_URL,
      engine: 'chromium',
      fingerprint: {
        userAgent: fingerprint.navigator.userAgent,
        hardwareConcurrency: fingerprint.navigator.hardwareConcurrency,
        deviceMemory: fingerprint.navigator.deviceMemory,
        timezone: fingerprint.locale.timezone,
        locale: fingerprint.locale.locale,
        geolocation: fingerprint.locale.geolocation,
        webgl: fingerprint.webgl.renderer,
      },
      applied,
      checks,
      webrtc: {
        policyApplied: webrtcPolicyApplied,
        measured: checks.webrtcLeakProtected !== null, // false = control never leaked (not gated)
        localCandidates: iceCandidates.length,
        localLeaks: localLeaks.length,
        controlCandidates: control.length,
        controlLeaks: controlLeaks.length,
        suppressionCandidates: suppressed.length,
        suppressionLeaks: suppressionLeaks.length,
        sample: iceCandidates.slice(0, 2),
      },
      sannysoft: {
        total: rows.length,
        failed: failed.length,
        failedTests: failed.map((r) => r.name),
      },
      deepSurfaces,
      detectorMatrix,
      thresholds,
      verdict,
    });

    if (verdict !== 'pass') process.exitCode = 1;
  } finally {
    await context.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
}

async function main() {
  if (process.argv.includes('--stub')) return runStub();
  if (!(await isChromiumAvailable())) {
    process.stderr.write(
      'patched Chromium not installed — run `npx patchright install chromium` (or pass --stub).\n',
    );
    process.exitCode = 2;
    return;
  }
  await runReal();
}

// Run only when invoked directly (`node …/run.mjs`), so tests can import the pure helpers above.
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  main().catch((e) => {
    process.stderr.write(`${e instanceof Error ? e.stack || e.message : String(e)}\n`);
    process.exitCode = 1;
  });
}
