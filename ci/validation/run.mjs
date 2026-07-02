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

import { deriveFingerprint, generateSeed } from '@lobster/fingerprint';
import {
  applyCdpFingerprint,
  buildCdpEmulation,
  buildLaunchOptions,
  isChromiumAvailable,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const DETECTOR_URL = 'https://bot.sannysoft.com/';

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

  // 1. Derive a coherent real-device fingerprint (the same path the sidecar uses).
  const fingerprint = deriveFingerprint(generateSeed(), { os: 'windows', engine: 'chromium' });

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

  try {
    const page = context.pages()[0] ?? (await context.newPage());
    // Apply the JS-safe fingerprint via CDP (the same code path the launcher uses).
    const cdp = await context.newCDPSession(page);
    await applyCdpFingerprint(cdp, fingerprint);
    await page.goto(DETECTOR_URL, { waitUntil: 'networkidle', timeout: 60_000 });

    // 3a. Did our fingerprint actually apply, with no automation tell? (robust, engine-agnostic)
    const applied = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      hardwareConcurrency: navigator.hardwareConcurrency,
      languages: Array.from(navigator.languages),
      webdriver: navigator.webdriver === true,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    }));

    const checks = {
      webdriverAbsent: applied.webdriver === false,
      userAgentApplied: applied.userAgent === fingerprint.navigator.userAgent,
      hardwareConcurrencyApplied:
        applied.hardwareConcurrency === fingerprint.navigator.hardwareConcurrency,
      languagesApplied: applied.languages.join(',') === fingerprint.navigator.languages.join(','),
      timezoneApplied: applied.timezone === fingerprint.locale.timezone,
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
        timezone: fingerprint.locale.timezone,
        webgl: fingerprint.webgl.renderer,
      },
      applied,
      checks,
      sannysoft: { total: rows.length, failed: failed.length, failedTests: failed.map((r) => r.name) },
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
