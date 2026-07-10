#!/usr/bin/env node
// PRODUCT E2E — "create a profile, it opens, the browser really runs" (real battle).
//
// This drives the SAME sidecar path the desktop Launch button uses: it builds the exact
// `StartProfileParams` the Rust core sends, runs them through the engine-runner `startProfile` on a real
// `CompositeRunner` with the live launchers, and asserts a REAL browser launched, applied the persona,
// loaded imported cookies, navigated a real website, and can be stopped. It runs HEADFUL on the GPU
// display when one is available (DISPLAY set), else headless=new — either way a real Chrome/Lobium
// process renders on the physical GPU.
//
//   LOBSTER_LOBIUM_BIN=/path/to/chrome LOBSTER_GPU=gpu LOBSTER_ANGLE_BACKEND=vulkan \
//   VK_ICD_FILENAMES=/path/nvidia_icd.json node ci/validation/product-e2e.mjs
//
// Exit 0 = a profile was created, launched, proven running, and stopped. Non-zero = a failure with the
// specific assertion that broke.

import { mkdtemp, mkdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { generateSeed } from '@lobster/fingerprint';
import {
  CompositeRunner,
  buildLaunchers,
  exportCookiesJson,
  isLobiumAvailable,
  startProfile,
} from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const HEADFUL = Boolean(process.env.DISPLAY) && process.env.LOBSTER_HEADFUL !== '0';

// A local site the profile "logs into" via an injected cookie, so we can prove cookie injection worked
// end-to-end: the page echoes document.cookie, and we assert our injected session cookie is present.
function startSite() {
  return new Promise((resolve) => {
    const server = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/html' });
      res.end(
        '<!doctype html><html><head><title>Lobster E2E</title></head><body><h1>ok</h1></body></html>',
      );
    });
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

/** Build the StartProfileParams exactly as the Rust core's `start_profile_via_sidecar` does. */
function buildStartParams(profile, userDataDir, siteHost) {
  return {
    profileId: profile.id,
    engine: profile.engine,
    os: profile.os,
    osVersion: profile.osVersion,
    fingerprintSeed: profile.fingerprintSeed,
    fingerprintOverrides: profile.fingerprintOverrides,
    proxy: profile.proxy,
    // Import a session cookie for the local site so we can prove cookie injection loads it into the jar.
    cookiesImport: {
      mode: 'merge',
      source: 'plain_text',
      rawText: JSON.stringify([
        {
          name: 'lobster_session',
          value: 'e2e-proof-123',
          domain: siteHost,
          path: '/',
          expires: 4102444800,
          httpOnly: false,
          secure: false,
          sameSite: 'Lax',
        },
      ]),
    },
    extensions: profile.extensions,
    userDataDir,
    headless: !HEADFUL,
  };
}

async function main() {
  const nativeLobium = isLobiumAvailable();
  process.stderr.write(
    `engine: ${nativeLobium ? 'native Lobium' : 'interim Chromium (patchright)'} | mode: ${HEADFUL ? 'HEADFUL on ' + process.env.DISPLAY : 'headless=new'}\n`,
  );

  // The live launcher registry — the SAME one the sidecar builds at startup.
  const launchers = await buildLaunchers({
    headless: !HEADFUL,
    extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const runner = new CompositeRunner(launchers);

  const site = await startSite();
  const sitePort = site.address().port;
  // Use localhost (not 127.0.0.1): Chromium often refuses to persist cookies for raw IP hosts,
  // which falsely fails the cookie-injection proof even when Network.setCookie succeeded.
  const siteHost = 'localhost';
  const siteUrl = `http://${siteHost}:${sitePort}/`;

  const root = await mkdtemp(join(tmpdir(), 'lobster-product-e2e-'));
  const userDataDir = join(root, 'profile-user-data');
  await mkdir(userDataDir, { recursive: true });

  // 1) "Create a profile" — the fields the desktop create-profile flow stores.
  const seed = generateSeed();
  const profile = {
    id: `e2e-${Date.now()}`,
    name: 'Product E2E Profile',
    engine: nativeLobium ? 'lobium' : 'chromium',
    os: 'windows',
    osVersion: 'Windows 11 23H2',
    fingerprintSeed: seed,
    fingerprintOverrides: undefined,
    proxy: undefined,
    extensions: undefined,
  };
  process.stderr.write(`created profile ${profile.id} (engine=${profile.engine}, seed=${seed})\n`);

  const report = {
    kind: 'product-e2e',
    capturedAt: new Date().toISOString(),
    engine: profile.engine,
    headful: HEADFUL,
    profileId: profile.id,
    steps: {},
  };
  let launched;
  try {
    // 2) "Launch it" — through the real product path.
    launched = await startProfile(runner, buildStartParams(profile, userDataDir, siteHost));
    report.steps.launched = { ws: launched.ws, debuggerAddress: launched.debuggerAddress };
    process.stderr.write(`launched: ${launched.debuggerAddress}\n`);

    // 3) Prove the browser REALLY runs: the native config file exists (native engine), CDP answers,
    //    the persona applied, the imported cookie is in the jar, and a real page navigates + paints.
    if (nativeLobium) {
      const cfgPath = join(userDataDir, 'lobium-fp.json');
      const cfg = JSON.parse(await readFile(cfgPath, 'utf8'));
      report.steps.nativeConfig = {
        version: cfg.version,
        ua: cfg.navigator?.userAgent,
        renderer: cfg.webgl?.renderer,
      };
      if (cfg.version !== 1) throw new Error('native lobium-fp.json missing/!=1');
    }

    const versionRes = await fetch(`http://${launched.debuggerAddress}/json/version`);
    const version = await versionRes.json();
    report.steps.cdpVersion = { browser: version.Browser };
    if (!version.Browser && !version.webSocketDebuggerUrl)
      throw new Error('CDP /json/version had no browser identity');
    process.stderr.write(`CDP browser: ${version.Browser}\n`);

    // Connect and drive the live browser.
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(launched.ws);
    try {
      const context = browser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      // Lobium branding may still be navigating the initial tab to about:blank + setDocumentContent.
      // Wait briefly, then retry goto if that race interrupts the first navigation.
      await page.waitForLoadState('domcontentloaded', { timeout: 5_000 }).catch(() => {});
      let navigated = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
          navigated = true;
          break;
        } catch (err) {
          const msg = String(err?.message || err);
          const interrupted =
            msg.includes('interrupted by another navigation') || msg.includes('net::ERR_ABORTED');
          if (!interrupted || attempt === 3) throw err;
          process.stderr.write(`goto interrupted (attempt ${attempt}), retrying…\n`);
          await new Promise((r) => setTimeout(r, 400 * attempt));
        }
      }
      if (!navigated) throw new Error('navigation to e2e site failed after retries');

      const observed = await page.evaluate(() => ({
        title: document.title,
        cookie: document.cookie,
        ua: navigator.userAgent,
        platform: navigator.platform,
        hardwareConcurrency: navigator.hardwareConcurrency,
        webglRenderer: (() => {
          try {
            const gl = document.createElement('canvas').getContext('webgl');
            const dbg = gl.getExtension('WEBGL_debug_renderer_info');
            return dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null;
          } catch {
            return null;
          }
        })(),
        bodyText: document.body ? document.body.innerText.trim() : '',
      }));
      report.steps.page = observed;
      process.stderr.write(
        `page title="${observed.title}" cookie="${observed.cookie}" ua-has-windows=${observed.ua.includes('Windows')}\n`,
      );
      process.stderr.write(`webgl renderer: ${observed.webglRenderer}\n`);

      // ---- Assertions: the browser really ran and behaved as the product intends ----
      if (observed.title !== 'Lobster E2E')
        throw new Error(`navigation failed: title="${observed.title}"`);
      if (observed.bodyText !== 'ok')
        throw new Error(`page did not render body (got "${observed.bodyText}")`);
      if (!observed.cookie.includes('lobster_session=e2e-proof-123')) {
        throw new Error(`imported cookie not present in the jar: "${observed.cookie}"`);
      }
      if (!observed.ua.includes('Windows'))
        throw new Error(`persona UA not applied: ${observed.ua}`);

      // Cookie EXPORT round-trip (warm-up save): read the jar back out as JSON.
      const cdp = await context.newCDPSession(page);
      const exported = await exportCookiesJson(cdp);
      report.steps.cookieExport = { count: JSON.parse(exported).length };
      if (!exported.includes('lobster_session'))
        throw new Error('cookie export did not round-trip the session cookie');

      // Screenshot proof the window really rendered.
      await mkdir(REPORTS_DIR, { recursive: true });
      const shotPath = join(
        REPORTS_DIR,
        `product-e2e-${report.capturedAt.replace(/[:.]/g, '-')}.png`,
      );
      await page.screenshot({ path: shotPath });
      const shotStat = await stat(shotPath);
      report.steps.screenshot = { path: shotPath, bytes: shotStat.size };
      if (shotStat.size < 1000)
        throw new Error('screenshot suspiciously small — did the window paint?');
      process.stderr.write(`screenshot: ${shotPath} (${shotStat.size} bytes)\n`);
    } finally {
      await browser.close();
    }

    // 4) "Stop it" cleanly.
    await runner.stop({ profileId: profile.id });
    report.steps.stopped = true;
    report.verdict = 'pass';
  } finally {
    site.close();
    try {
      await runner.stop({ profileId: profile.id });
    } catch {
      /* already stopped */
    }
    await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }

  await mkdir(REPORTS_DIR, { recursive: true });
  const outPath = join(REPORTS_DIR, `product-e2e-${report.capturedAt.replace(/[:.]/g, '-')}.json`);
  await writeFile(outPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`\nsaved: ${outPath}\n`);
  process.stdout.write(
    report.verdict === 'pass'
      ? '\nPRODUCT E2E: PASS — profile created, browser launched & ran, cookies injected, navigated, stopped.\n'
      : '\nPRODUCT E2E: FAIL\n',
  );
  if (report.verdict !== 'pass') process.exitCode = 1;
}

main().catch((e) => {
  process.stderr.write(`${e?.stack || e}\n`);
  process.exitCode = 3;
});
