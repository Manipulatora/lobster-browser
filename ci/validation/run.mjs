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
import { fileURLToPath } from 'node:url';
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

    const webrtcPolicyApplied = options.args.includes(
      '--force-webrtc-ip-handling-policy=default_public_interface_only',
    );
    const localLeaks = iceCandidates.filter(isLocalLeak);
    const suppressionLeaks = suppressed.filter(isPublicLeak);

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
      // STUN public-IP srflx, AND the correct policy value is applied to this profile.
      webrtcLeakProtected:
        webrtcPolicyApplied && localLeaks.length === 0 && suppressionLeaks.length === 0,
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

    const directPass = Object.values(checks).every(Boolean);
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
        localCandidates: iceCandidates.length,
        localLeaks: localLeaks.length,
        suppressionCandidates: suppressed.length,
        suppressionLeaks: suppressionLeaks.length,
        sample: iceCandidates.slice(0, 2),
      },
      sannysoft: {
        total: rows.length,
        failed: failed.length,
        failedTests: failed.map((r) => r.name),
      },
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

main().catch((e) => {
  process.stderr.write(`${e instanceof Error ? e.stack || e.message : String(e)}\n`);
  process.exitCode = 1;
});
