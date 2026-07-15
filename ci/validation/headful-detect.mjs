#!/usr/bin/env node
// HEADFUL real-detector spot check (faithful to real profiles): launches a persona headful on the
// current DISPLAY with the full sidecar child-env, visits bot.sannysoft.com + CreepJS, and extracts
// the automation/headless verdicts (the signals that DON'T need a real GPU). Software GPU is fine here.
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { applyGeoToFingerprint, deriveFingerprint } from '@lobster/fingerprint';
import { buildDevShmArgs, buildLaunchOptions, buildLobiumConfig, lobiumConfigArg, resolveLobiumBinary, writeLobiumConfig } from '@lobster/engine-runner';

const LOBIUM = resolveLobiumBinary();
const GEO = { ip: '0.0.0.0', countryCode: 'US', timezone: 'America/New_York', latitude: 40.71, longitude: -74 };

async function readCdp(dir, n = 200) {
  for (let i = 0; i < n; i++) {
    try { const [p, path] = (await readFile(join(dir, 'DevToolsActivePort'), 'utf8')).split('\n');
      if (Number(p) > 0 && path) return `ws://127.0.0.1:${Number(p)}${path.trim()}`; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('no cdp');
}

async function run(os) {
  const seed = `headful-${os}`;
  const fp = applyGeoToFingerprint(deriveFingerprint(seed, { os, engine: 'lobium' }), GEO);
  const dir = await mkdtemp(join(tmpdir(), `hf-${os}-`));
  const cfgPath = await writeLobiumConfig(dir, buildLobiumConfig(fp, { seed }));
  const launch = buildLaunchOptions({ profileId: seed, engine: 'lobium', userDataDir: dir, fingerprint: fp, headless: false });
  const localeUnix = `${fp.locale.locale.replaceAll('-', '_')}.UTF-8`;
  const args = ['--no-sandbox', ...buildDevShmArgs(), '--enable-unsafe-swiftshader',
    `--user-data-dir=${dir}`, lobiumConfigArg(cfgPath), '--remote-debugging-port=0',
    '--no-first-run', '--no-default-browser-check', '--window-size=1280,900', ...launch.args];
  const proc = spawn(LOBIUM, args, { stdio: 'ignore', env: { ...process.env, TZ: fp.locale.timezone, LANG: localeUnix, LC_ALL: localeUnix, FC_LANG: fp.locale.locale } });
  try {
    const ws = await readCdp(dir);
    const { chromium } = await import('patchright');
    const browser = await chromium.connectOverCDP(ws);
    try {
      const ctx = browser.contexts()[0];
      const page = ctx.pages()[0] ?? (await ctx.newPage());
      // Sannysoft: table of green(passed)/red(failed) automation checks.
      await page.goto('https://bot.sannysoft.com/', { waitUntil: 'networkidle', timeout: 45000 }).catch(() => {});
      await page.waitForTimeout(3500);
      const sanny = await page.evaluate(() => {
        const rows = [...document.querySelectorAll('table tr')];
        const fails = [];
        for (const tr of rows) {
          const tds = [...tr.querySelectorAll('td')];
          if (tds.length < 2) continue;
          const name = tds[0].innerText.trim();
          const cell = tds[1];
          const cls = cell.className || '';
          const txt = cell.innerText.trim();
          // sannysoft marks failures with class 'failed' / red background
          if (/failed/i.test(cls) || /present \(failed\)|failed/i.test(txt)) fails.push(`${name} = ${txt}`);
        }
        // key single signals
        const g = (id) => { const e = document.getElementById(id); return e ? e.innerText.trim() : null; };
        return { webdriver: g('webdriver-result'), chrome: g('chrome-result'), permissions: g('permissions-result'),
          plugins: g('plugins-length-result'), languages: g('languages-result'), fails: fails.slice(0, 25) };
      }).catch((e) => ({ error: String(e) }));
      // CreepJS: headless + stealth rating + total lies
      await page.goto('https://abrahamjuliot.github.io/creepjs/', { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {});
      await page.waitForTimeout(9000);
      const creep = await page.evaluate(() => {
        const txt = document.body.innerText;
        const grab = (re) => { const m = re.exec(txt); return m ? m[1].trim() : null; };
        return {
          trust: grab(/(\d+(?:\.\d+)?)\s*%/),
          lies: grab(/(\d+)\s*lies?/i),
          headless: grab(/headless[^\n]*?(\d+%|behavior|chrome|likely|excellent|none)/i),
          bot: /bot/i.test(txt) ? (grab(/bot[^\n]*/i) || 'mention') : 'no-bot-word',
        };
      }).catch((e) => ({ error: String(e) }));
      return { os, renderer: fp.webgl.unmaskedRenderer, sanny, creep };
    } finally { await browser.close(); }
  } finally { proc.kill('SIGKILL'); await new Promise((r) => setTimeout(r, 300)); await rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

const results = [];
for (const os of (process.env.OSES || 'windows,macos').split(',')) {
  process.stderr.write(`\n=== ${os} ===\n`);
  try { const r = await run(os); results.push(r); console.log(JSON.stringify(r, null, 1)); }
  catch (e) { console.log(JSON.stringify({ os, error: String(e) })); }
}
