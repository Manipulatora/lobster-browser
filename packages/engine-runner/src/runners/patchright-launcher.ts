import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Launcher, LaunchContext, LaunchHandle } from './types.js';

/**
 * Real engine launcher backed by **patchright** (a stealth-hardened Playwright fork) driving a
 * patched Chromium. Used for the `chromium` and `kernel` (interim) engines.
 *
 * We launch a persistent context (per-profile user-data-dir) with the JS-safe fingerprint surfaces
 * applied via context options (UA/locale/timezone/geo) + an init script for the remaining navigator
 * fields — never touching canvas/WebGL/audio/TLS, which are native. We ask Chromium for a real CDP
 * port (`--remote-debugging-port=0`) and read the resulting `DevToolsActivePort` file so external
 * automation can `connectOverCDP(ws)` / set Selenium `debuggerAddress`.
 */

interface PwProxy {
  server: string;
  username?: string;
  password?: string;
}
interface PwGeolocation {
  latitude: number;
  longitude: number;
  accuracy?: number;
}
interface PersistentContextOptions {
  headless?: boolean;
  args?: string[];
  proxy?: PwProxy;
  userAgent?: string;
  locale?: string;
  timezoneId?: string;
  geolocation?: PwGeolocation;
}
interface PwContext {
  addInitScript(script: string): Promise<void>;
  close(): Promise<void>;
}
interface PwChromium {
  launchPersistentContext(
    userDataDir: string,
    options?: PersistentContextOptions,
  ): Promise<PwContext>;
  executablePath(): string;
}
interface PatchrightModule {
  chromium: PwChromium;
}

async function loadChromium(): Promise<PwChromium> {
  const mod = (await import('patchright')) as unknown as PatchrightModule;
  return mod.chromium;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Read Chromium's `DevToolsActivePort` (written when launched with `--remote-debugging-port`). */
async function readCdpEndpoint(
  userDataDir: string,
  retries = 100,
): Promise<{ port: number; ws: string }> {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine) {
        return { port, ws: `ws://127.0.0.1:${port}${pathLine.trim()}` };
      }
    } catch {
      // File not written yet — the browser is still starting.
    }
    await delay(100);
  }
  throw new Error('timed out waiting for the Chromium CDP endpoint (DevToolsActivePort)');
}

export interface PatchrightLauncherOptions {
  headless?: boolean;
  /** Extra Chromium flags (e.g. `--no-sandbox` in containers/CI). */
  extraArgs?: string[];
}

export function createPatchrightLauncher(opts: PatchrightLauncherOptions = {}): Launcher {
  return async (ctx: LaunchContext): Promise<LaunchHandle> => {
    const chromium = await loadChromium();
    const args = [...ctx.options.args, ...(opts.extraArgs ?? []), '--remote-debugging-port=0'];

    const options: PersistentContextOptions = {
      headless: opts.headless ?? ctx.options.headless,
      args,
      // JS-safe value substitution (deep surfaces stay native — see MASTER_PLAN §5).
      userAgent: ctx.emulation.userAgent,
      locale: ctx.emulation.locale,
      timezoneId: ctx.emulation.timezoneId,
    };
    if (ctx.options.proxy) options.proxy = ctx.options.proxy;
    if (ctx.emulation.geolocation) options.geolocation = ctx.emulation.geolocation;

    const context = await chromium.launchPersistentContext(ctx.options.userDataDir, options);
    // Apply the remaining JS-safe navigator surfaces to every page in this context.
    await context.addInitScript(ctx.initScript);

    const { port, ws } = await readCdpEndpoint(ctx.options.userDataDir);
    return {
      // The OS pid isn't exposed by the persistent-context API; lifecycle is managed via close().
      pid: 0,
      ws,
      debuggerAddress: `127.0.0.1:${port}`,
      close: () => context.close(),
    };
  };
}

/** True when a patched Chromium executable is present (downloaded via `patchright install chromium`). */
export async function isChromiumAvailable(): Promise<boolean> {
  try {
    const chromium = await loadChromium();
    return existsSync(chromium.executablePath());
  } catch {
    return false;
  }
}
