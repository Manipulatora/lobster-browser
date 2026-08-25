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

import { mkdtemp, mkdir, readdir, rm, writeFile, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';

import { generateSeed } from '@lobster/fingerprint';
import {
  CompositeRunner,
  availableFontFamilies,
  buildLaunchers,
  buildDevShmArgs,
  exportCookiesJson,
  isLobiumAvailable,
  startProfile,
} from '@lobster/engine-runner';
import {
  resolveProductE2eHeadful,
  validateWindowsFontIsolationConfig,
} from './product-e2e-platform.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const REPORTS_DIR = join(here, 'reports');
const HEADFUL = resolveProductE2eHeadful();

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
function buildStartParams(profile, userDataDir, siteHost, includeCookieImport = true) {
  return {
    profileId: profile.id,
    profileName: profile.name,
    engine: profile.engine,
    os: profile.os,
    osVersion: profile.osVersion,
    fingerprintSeed: profile.fingerprintSeed,
    fingerprintOverrides: profile.fingerprintOverrides,
    proxy: profile.proxy,
    // Import a session cookie for the local site so we can prove cookie injection loads it into the jar.
    cookiesImport: includeCookieImport
      ? {
          mode: 'merge',
          source: 'plain_text',
          rawText: JSON.stringify([
            {
              name: 'lobster_session',
              value: 'e2e-proof-123',
              domain: siteHost,
              path: '/',
              expires: Math.floor(Date.now() / 1000) + 86_400,
              httpOnly: false,
              secure: false,
              sameSite: 'Lax',
            },
          ]),
        }
      : undefined,
    extensions: profile.extensions,
    userDataDir,
    headless: !HEADFUL,
  };
}

async function main() {
  const nativeLobium = isLobiumAvailable();
  const displayLabel = process.env.DISPLAY ? ` on ${process.env.DISPLAY}` : '';
  process.stderr.write(
    `engine: ${nativeLobium ? 'native Lobium' : 'interim Chromium (patchright)'} | mode: ${HEADFUL ? `HEADFUL${displayLabel}` : 'headless=new'}\n`,
  );

  // The live launcher registry — the SAME one the sidecar builds at startup.
  const launchers = await buildLaunchers({
    headless: !HEADFUL,
    extraArgs: [
      '--no-sandbox',
      ...buildDevShmArgs(),
      '--password-store=basic',
      '--host-resolver-rules=MAP lobster.test 127.0.0.1',
    ],
  });
  const runner = new CompositeRunner(launchers);

  const site = await startSite();
  const sitePort = site.address().port;
  // A named .test host exercises a real persistent host-only cookie. The deterministic resolver rule
  // above maps it to the local fixture without relying on external DNS.
  const siteHost = 'lobster.test';
  const siteUrl = `http://${siteHost}:${sitePort}/`;

  const root = await mkdtemp(join(tmpdir(), 'lobster-product-e2e-'));
  const userDataDir = join(root, 'profile-user-data');
  await mkdir(userDataDir, { recursive: true });
  const extensionDir = join(root, 'extension-fixture');
  await mkdir(extensionDir, { recursive: true });
  await writeFile(
    join(extensionDir, 'manifest.json'),
    JSON.stringify({
      manifest_version: 3,
      name: 'Lobster product E2E fixture',
      version: '1.0.0',
      content_scripts: [
        {
          matches: ['http://lobster.test/*'],
          js: ['fixture.js'],
          run_at: 'document_start',
        },
      ],
    }),
  );
  await writeFile(
    join(extensionDir, 'fixture.js'),
    "document.documentElement.dataset.lobsterExtensionFixture = 'loaded';\n",
  );

  // 1) "Create a profile" — the fields the desktop create-profile flow stores.
  const seed = generateSeed();
  const profileOs = process.env.LOBSTER_PRODUCT_E2E_OS || 'linux';
  const fontPackDir = process.env.LOBSTER_FONTS_DIR;
  if (!fontPackDir) throw new Error('LOBSTER_FONTS_DIR is required for product E2E');
  const fontManifest = JSON.parse(
    await readFile(join(fontPackDir, 'font-pack.manifest.json'), 'utf8'),
  );
  const fontPersona = fontManifest.personas?.[profileOs];
  if (!Array.isArray(fontPersona?.families) || fontPersona.families.length === 0) {
    throw new Error(`open-font pack has no ${profileOs} persona`);
  }
  const profile = {
    id: `e2e-${Date.now()}`,
    name: 'Product E2E Profile',
    engine: nativeLobium ? 'lobium' : 'chromium',
    os: profileOs,
    osVersion:
      profileOs === 'windows'
        ? 'Windows 11 23H2'
        : profileOs === 'macos'
          ? 'macOS 15 Sequoia'
          : 'Ubuntu 24.04',
    fingerprintSeed: seed,
    fingerprintOverrides: {
      fontsMode: 'manual',
      fonts: fontPersona.families,
    },
    proxy: undefined,
    extensions: [
      {
        source: 'unpacked',
        enabled: true,
        name: 'Lobster product E2E fixture',
        path: extensionDir,
      },
    ],
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
    if (launched.cookieImportApplied !== true) {
      throw new Error('first launch did not report the pending cookie import as applied');
    }
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
        fontsChannel: cfg.fonts,
        fontPackDir: cfg.fontPackDir,
      };
      if (cfg.version !== 1) throw new Error('native lobium-fp.json missing/!=1');
      if (process.platform === 'win32') {
        // Derive the expectation from the SAME normalized manifest the launcher stages from.
        // loadFontPackManifest() sorts every family array (asStringArray), so the runtime allowlist is
        // alphabetical, while the pack file on disk records the provisioner order (preferred, then
        // coverage). Recomputing from the raw JSON compared two different orderings of the same set and
        // failed an order-sensitive check on a product that was behaving correctly.
        const expectedFallbackFamilies = await availableFontFamilies(fontPackDir, profileOs);
        report.steps.fontIsolation = validateWindowsFontIsolationConfig(
          cfg,
          fontPackDir,
          userDataDir,
          fontPersona.families,
          expectedFallbackFamilies,
          fontManifest.packId,
        );
      } else if (process.platform === 'linux') {
        const fontConfig = await readFile(join(userDataDir, 'lobium-fonts.conf'), 'utf8');
        const privateFontFiles = await readdir(join(userDataDir, 'font-files'));
        report.steps.fontIsolation = {
          mode: 'fontconfig',
          packId: fontManifest.packId,
          requestedFamilies: fontPersona.families,
          privateFiles: privateFontFiles.length,
          resetsInheritedDirs: fontConfig.includes('<reset-dirs />'),
          referencesHostFonts: /\/etc\/fonts|\/usr\/share\/fonts/.test(fontConfig),
        };
        if (
          privateFontFiles.length === 0 ||
          !report.steps.fontIsolation.resetsInheritedDirs ||
          report.steps.fontIsolation.referencesHostFonts
        ) {
          throw new Error('private open-font isolation contract was not applied');
        }
      } else {
        // Do not demand Linux fontconfig artifacts from a platform whose Chromium font backend does
        // not consume them. The dedicated native font gate is the runtime enforcement proof.
        report.steps.fontIsolation = {
          mode: 'platform-native',
          packId: fontManifest.packId,
          requestedFamilies: fontPersona.families,
          configuredFamilies: cfg.fonts,
        };
      }
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
      await page.waitForTimeout(2_000);
      const ntp = await page.evaluate(() => {
        const images = [];
        const walk = (root) => {
          for (const element of root.querySelectorAll('*')) {
            if (element.tagName === 'IMG') {
              images.push({
                src: element.getAttribute('src') || '',
                alt: element.getAttribute('alt') || '',
                width: element.naturalWidth,
                height: element.naturalHeight,
              });
            }
            if (element.shadowRoot) walk(element.shadowRoot);
          }
        };
        walk(document);
        return { url: location.href, title: document.title, images };
      });
      report.steps.nativeNtp = ntp;
      if (
        ntp.title !== 'New Tab' ||
        !ntp.url.startsWith('chrome://new-tab-page') ||
        !ntp.images.some(
          (image) =>
            image.src.includes('lobium_master.png') &&
            image.alt === 'Lobster Browser' &&
            image.width > 0,
        ) ||
        !ntp.images.some(
          (image) =>
            image.src.includes('lobster_ad.png') &&
            image.alt.includes('Lobster Browser') &&
            image.width > 0,
        )
      ) {
        throw new Error(`canonical native NTP branding was not observed: ${JSON.stringify(ntp)}`);
      }
      const ntpShotPath = join(
        REPORTS_DIR,
        `product-e2e-ntp-${report.capturedAt.replace(/[:.]/g, '-')}.png`,
      );
      await mkdir(REPORTS_DIR, { recursive: true });
      await page.screenshot({ path: ntpShotPath });
      report.steps.nativeNtpScreenshot = ntpShotPath;
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
        webglRuntime: (() => {
          try {
            const canvas = document.createElement('canvas');
            canvas.width = 16;
            canvas.height = 16;
            const gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
            if (!gl) return { available: false };
            const advertisedExtensions = gl.getSupportedExtensions() || [];
            const unavailableAdvertisedExtensions = advertisedExtensions.filter(
              (name) => gl.getExtension(name) === null,
            );
            gl.clearColor(0.125, 0.25, 0.5, 1);
            gl.clear(gl.COLOR_BUFFER_BIT);
            const pixel = new Uint8Array(4);
            gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
            return {
              available: true,
              contextLost: gl.isContextLost(),
              error: gl.getError(),
              pixel: Array.from(pixel),
              maxTextureSize: gl.getParameter(gl.MAX_TEXTURE_SIZE),
              maxRenderbufferSize: gl.getParameter(gl.MAX_RENDERBUFFER_SIZE),
              unavailableAdvertisedExtensions,
            };
          } catch (error) {
            return { available: false, error: String(error) };
          }
        })(),
        bodyText: document.body ? document.body.innerText.trim() : '',
        extensionFixture: document.documentElement.dataset.lobsterExtensionFixture ?? null,
      }));
      report.steps.page = observed;
      process.stderr.write(
        `page title="${observed.title}" cookie="${observed.cookie}" profile-os=${profile.os}\n`,
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
      if (observed.extensionFixture !== 'loaded') {
        throw new Error('local unpacked extension fixture did not execute');
      }
      const expectedUaToken =
        profile.os === 'windows' ? 'Windows' : profile.os === 'macos' ? 'Macintosh' : 'X11; Linux';
      if (!observed.ua.includes(expectedUaToken))
        throw new Error(`persona UA not applied: ${observed.ua}`);
      if (
        !observed.webglRuntime.available ||
        observed.webglRuntime.contextLost ||
        observed.webglRuntime.error !== 0 ||
        observed.webglRuntime.pixel?.[3] === 0 ||
        observed.webglRuntime.unavailableAdvertisedExtensions?.length !== 0
      ) {
        throw new Error(`WebGL runtime contract failed: ${JSON.stringify(observed.webglRuntime)}`);
      }

      // Cookie EXPORT round-trip (warm-up save): read the jar back out as JSON.
      const cdp = await context.newCDPSession(page);
      const exported = await exportCookiesJson(cdp);
      const exportedCookies = JSON.parse(exported);
      report.steps.cookieExport = {
        count: exportedCookies.length,
        importedCookieExpires: exportedCookies.find((cookie) => cookie.name === 'lobster_session')
          ?.expires,
      };
      process.stderr.write(
        `cookie export metadata: ${JSON.stringify(report.steps.cookieExport)}\n`,
      );
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

    // 5) Relaunch the SAME profile without an import payload. The persistent cookie must remain and
    // the launch result must prove the one-shot import was not applied again.
    launched = await startProfile(runner, buildStartParams(profile, userDataDir, siteHost, false));
    if (launched.cookieImportApplied !== false) {
      throw new Error('relaunch unexpectedly reapplied the one-shot cookie import');
    }
    const relaunchedBrowser = await chromium.connectOverCDP(launched.ws);
    try {
      const context = relaunchedBrowser.contexts()[0];
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(siteUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
      const persisted = await page.evaluate(() => ({
        cookie: document.cookie,
        extensionFixture: document.documentElement.dataset.lobsterExtensionFixture ?? null,
      }));
      const cdp = await context.newCDPSession(page);
      const exported = await exportCookiesJson(cdp);
      report.steps.relaunch = {
        cookieImportApplied: launched.cookieImportApplied,
        cookiePersisted: persisted.cookie.includes('lobster_session=e2e-proof-123'),
        extensionLoaded: persisted.extensionFixture === 'loaded',
        exportCount: JSON.parse(exported).length,
      };
      if (
        !report.steps.relaunch.cookiePersisted ||
        !report.steps.relaunch.extensionLoaded ||
        !exported.includes('lobster_session')
      ) {
        throw new Error(
          `same-profile relaunch/cookie export/extension persistence failed: ${JSON.stringify(
            report.steps.relaunch,
          )}`,
        );
      }
    } finally {
      await relaunchedBrowser.close();
    }
    await runner.stop({ profileId: profile.id });

    // 6) A dead configured proxy must fail before browser spawn. This proves the product launcher
    // does not silently retry direct when its required upstream is unavailable.
    const blockedProfile = {
      ...profile,
      id: `${profile.id}-blocked`,
      proxy: { id: 'blocked', type: 'http', host: '127.0.0.1', port: 9 },
    };
    let proxyError = '';
    try {
      await startProfile(
        runner,
        buildStartParams(blockedProfile, join(root, 'blocked'), siteHost, false),
      );
    } catch (error) {
      proxyError = String(error);
    }
    const blockedStatus = await runner.status({ profileId: blockedProfile.id });
    report.steps.proxyFailClosed = {
      rejectedBeforeLaunch: proxyError.length > 0,
      runningAfterRejection: blockedStatus.running.length,
      noDirectFallback: proxyError.length > 0 && blockedStatus.running.length === 0,
    };
    if (!report.steps.proxyFailClosed.noDirectFallback) {
      throw new Error('dead proxy did not fail closed before launch');
    }
    report.verdict = 'pass';
  } finally {
    site.close();
    try {
      await runner.stop({ profileId: profile.id });
    } catch {
      /* already stopped */
    }
    if (process.env.LOBSTER_PRODUCT_E2E_KEEP_DATA === '1') {
      process.stderr.write(`preserved product E2E data: ${root}\n`);
    } else {
      await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
    }
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
  // EXIT, do not merely set a code. A throw on the way in (a missing font pack, an unbuilt engine)
  // happens after buildLaunchers has already registered live launchers, and whatever handle that
  // leaves open keeps the event loop alive forever: the process printed this error and then had to be
  // killed by a timeout, so `node product-e2e.mjs | tee` in scripts/build-linux-product.sh waited
  // indefinitely instead of failing. A gate that hangs is not a gate.
  process.exit(3);
});
