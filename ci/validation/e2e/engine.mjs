/**
 * Engine provisioning for the real-browser agent fixtures.
 *
 * Resolution order, most-authoritative first:
 *
 *  1. `LOBSTER_LOBIUM_BIN` — the shipping engine. A pass here is Gate-B evidence.
 *  2. `LOBSTER_E2E_CHROMIUM` / a discovered Chromium (patchright/Playwright cache, system Chrome).
 *     This is the **interim** engine: it exercises the sidecar↔CDP↔driver↔agent stack against a real
 *     browser, but it is NOT the fingerprint engine, so a pass here is browser-integration evidence
 *     only and the report says so.
 *
 * Refusing to run at all when Lobium is absent would mean the agent's entire browser path stays
 * untested on every developer machine and in PR CI — which is exactly the state this harness exists
 * to end. Silently calling an interim-engine pass a Gate-B pass would be the opposite error. So the
 * engine kind is carried through to the report and the exit code.
 */

import { spawn } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  clearDevToolsActivePort,
  readDevToolsEndpoint,
} from '../../../packages/engine-runner/dist/devtools-endpoint.js';

function isExecutableFile(path) {
  try {
    const st = statSync(path);
    return st.isFile() && (process.platform === 'win32' || (st.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

/** Newest chromium-N build under a Playwright/patchright browser cache. */
function fromBrowserCache(base) {
  if (!existsSync(base)) return undefined;
  const dirs = readdirSync(base)
    .filter((name) => /^chromium-\d+$/.test(name))
    .sort((a, b) => Number(b.slice(9)) - Number(a.slice(9)));
  for (const dir of dirs) {
    for (const layout of ['chrome-linux64', 'chrome-linux', 'chrome-win', 'chrome-mac']) {
      for (const name of ['chrome', 'chrome.exe', 'Chromium.app/Contents/MacOS/Chromium']) {
        const candidate = join(base, dir, layout, name);
        if (isExecutableFile(candidate)) return candidate;
      }
    }
  }
  return undefined;
}

/** @returns {{ bin: string, kind: 'lobium' | 'interim' } | undefined} */
export function resolveEngine() {
  const lobium = process.env.LOBSTER_LOBIUM_BIN;
  if (lobium && isExecutableFile(lobium)) return { bin: lobium, kind: 'lobium' };

  const explicit = process.env.LOBSTER_E2E_CHROMIUM;
  if (explicit && isExecutableFile(explicit)) return { bin: explicit, kind: 'interim' };

  const candidates = [
    fromBrowserCache(join(homedir(), '.cache', 'ms-playwright')),
    fromBrowserCache(join(homedir(), '.cache', 'patchright')),
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (isExecutableFile(candidate)) return { bin: candidate, kind: 'interim' };
  }
  return undefined;
}

/**
 * Launch the engine with a throwaway profile and a first-party CDP endpoint.
 *
 * The switch list is deliberately minimal and mirrors what the product launcher passes for a
 * headless CI profile. It does NOT enable any CDP domain — the endpoint is opened, and the driver
 * under test is the only thing that talks to it.
 */
export async function launchEngine({ bin, headless = true, extraArgs = [] }) {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobee-e2e-profile-'));
  await clearDevToolsActivePort(userDataDir);
  const args = [
    `--user-data-dir=${userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-background-networking',
    '--disable-component-update',
    '--disable-sync',
    '--no-sandbox',
    '--disable-dev-shm-usage',
    ...(headless ? ['--headless=new'] : []),
    ...extraArgs,
    'about:blank',
  ];
  const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: false });
  // Drain the pipes: a filled stdio buffer deadlocks the renderer on a chatty build.
  child.stdout.resume();
  child.stderr.resume();

  let exited;
  const exitPromise = new Promise((resolve) => {
    child.once('exit', (code, signal) => {
      exited = { code, signal };
      resolve(exited);
    });
  });

  let endpoint;
  try {
    endpoint = await Promise.race([
      readDevToolsEndpoint(userDataDir, 150),
      exitPromise.then(() => {
        throw new Error(
          `engine exited before publishing a CDP endpoint (code=${exited?.code} signal=${exited?.signal})`,
        );
      }),
    ]);
  } catch (error) {
    child.kill('SIGKILL');
    await rm(userDataDir, { recursive: true, force: true });
    throw error;
  }

  return {
    ws: endpoint.ws,
    port: endpoint.port,
    pid: child.pid,
    userDataDir,
    async close() {
      if (!exited) {
        child.kill('SIGTERM');
        const timer = setTimeout(() => child.kill('SIGKILL'), 4_000);
        timer.unref?.();
        await exitPromise;
        clearTimeout(timer);
      }
      await rm(userDataDir, { recursive: true, force: true }).catch(() => {});
    },
  };
}
