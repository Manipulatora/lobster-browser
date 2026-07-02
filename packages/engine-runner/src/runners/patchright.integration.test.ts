import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { Fingerprint, LaunchParams } from '@lobster/shared-types';
import { CompositeRunner } from './composite.js';
import { createPatchrightLauncher, isChromiumAvailable } from './patchright-launcher.js';

// Minimal structural view of the patchright CDP client we use (keeps this strict without a hard
// dependency on patchright's shipped types).
interface CdpPage {
  goto(url: string): Promise<unknown>;
  evaluate<T>(fn: () => T): Promise<T>;
}
interface CdpContext {
  newPage(): Promise<CdpPage>;
}
interface CdpBrowser {
  contexts(): CdpContext[];
  close(): Promise<void>;
}
interface CdpChromium {
  connectOverCDP(endpoint: string): Promise<CdpBrowser>;
}

function sampleFingerprint(): Fingerprint {
  return {
    os: 'windows',
    arch: 'x86_64',
    navigator: {
      userAgent:
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      uaBrands: [{ brand: 'Chromium', version: '131' }],
      uaPlatform: 'Windows',
      uaPlatformVersion: '15.0.0',
      uaMobile: false,
      uaFullVersion: '131.0.0.0',
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: { vendor: 'v', renderer: 'r', unmaskedVendor: 'v', unmaskedRenderer: 'r' },
    locale: { timezone: 'America/New_York', locale: 'en-US', acceptLanguage: 'en-US,en;q=0.9' },
    fonts: ['Arial'],
  };
}

// Runs only where a patched Chromium is installed; skipped (green) elsewhere so `npm test` is portable.
const chromiumReady = await isChromiumAvailable();

test(
  'patchright launcher launches real Chromium, exposes a working CDP endpoint, and is stealthy',
  {
    skip: chromiumReady
      ? false
      : 'patched Chromium not installed (npx patchright install chromium)',
  },
  async () => {
    const runner = new CompositeRunner({
      chromium: createPatchrightLauncher({
        headless: true,
        extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
      }),
    });
    const userDataDir = await mkdtemp(join(tmpdir(), 'lobster-itest-'));
    const params: LaunchParams = {
      profileId: 'itest',
      engine: 'chromium',
      userDataDir,
      fingerprint: sampleFingerprint(),
      headless: true,
    };

    const res = await runner.launch(params);
    try {
      assert.match(res.ws, /^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//, 'real CDP ws endpoint');
      assert.match(res.debuggerAddress, /^127\.0\.0\.1:\d+$/);

      const { chromium } = (await import('patchright')) as unknown as { chromium: CdpChromium };
      const browser = await chromium.connectOverCDP(res.ws);
      try {
        const context = browser.contexts()[0];
        assert.ok(context, 'browser exposes a context over CDP');
        const page = await context.newPage();
        await page.goto('data:text/html,<title>lobster</title>');

        const ua = await page.evaluate<string>(() => navigator.userAgent);
        const webdriver = await page.evaluate<boolean | undefined>(
          () => (navigator as { webdriver?: boolean }).webdriver,
        );

        assert.match(ua, /Chrome\//, 'real Chrome user agent from a live browser');
        assert.notEqual(
          webdriver,
          true,
          'patchright stealth: navigator.webdriver must not be true',
        );
      } finally {
        await browser.close();
      }

      const status = await runner.status({});
      assert.equal(status.running.length, 1, 'the launched profile is tracked as running');
    } finally {
      await runner.stop({ profileId: 'itest' });
      await rm(userDataDir, { recursive: true, force: true });
    }
  },
);
