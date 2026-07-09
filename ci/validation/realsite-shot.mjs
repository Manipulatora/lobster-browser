// One-off: launch a profile through the product path and screenshot a REAL public website,
// to visually prove the browser truly runs and renders live web content.
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateSeed } from '@lobster/fingerprint';
import { CompositeRunner, buildLaunchers, startProfile } from '@lobster/engine-runner';

const here = dirname(fileURLToPath(import.meta.url));
const HEADFUL = Boolean(process.env.DISPLAY);
const url = process.argv[2] || 'https://example.com/';

const runner = new CompositeRunner(
  await buildLaunchers({
    headless: !HEADFUL,
    extraArgs: ['--no-sandbox', '--disable-dev-shm-usage'],
  }),
);
const root = await mkdtemp(join(tmpdir(), 'lobster-realsite-'));
const userDataDir = join(root, 'ud');
await mkdir(userDataDir, { recursive: true });
const id = `realsite-${Date.now()}`;
try {
  const launched = await startProfile(runner, {
    profileId: id,
    engine: 'lobium',
    os: 'windows',
    fingerprintSeed: generateSeed(),
    userDataDir,
    headless: !HEADFUL,
  });
  const { chromium } = await import('patchright');
  const browser = await chromium.connectOverCDP(launched.ws);
  try {
    const ctx = browser.contexts()[0];
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url, { waitUntil: 'networkidle', timeout: 45000 });
    const info = await page.evaluate(() => ({ title: document.title, url: location.href }));
    await mkdir(join(here, 'reports'), { recursive: true });
    const shot = join(here, 'reports', `realsite-${Date.now()}.png`);
    await page.screenshot({ path: shot, fullPage: false });
    console.log(JSON.stringify({ url: info.url, title: info.title, screenshot: shot }, null, 2));
  } finally {
    await browser.close();
  }
} finally {
  try {
    await runner.stop({ profileId: id });
  } catch {}
  await rm(root, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
}
