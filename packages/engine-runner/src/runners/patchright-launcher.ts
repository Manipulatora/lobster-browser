import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { applyCdpFingerprint, type CdpSession } from '../cdp-fingerprint.js';
import type { Launcher, LaunchContext, LaunchHandle } from './types.js';

/**
 * Real engine launcher backed by **patchright** (a stealth-hardened Playwright fork) driving a
 * patched Chromium. Used for the `chromium` and `lobium` engines.
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
  /** Override the browser binary (the native Lobium launcher points this at the from-source build). */
  executablePath?: string;
  /** Browser process environment (REPLACES the default env). Used to set FONTCONFIG_FILE (ENG-6). */
  env?: Record<string, string>;
}
type PwPage = object;
interface PwContext {
  newCDPSession(page: PwPage): Promise<CdpSession>;
  pages(): PwPage[];
  newPage(): Promise<PwPage>;
  on(event: 'page', handler: (page: PwPage) => void): void;
  on(event: 'close', handler: () => void): void;
  grantPermissions(permissions: string[], options?: { origin?: string }): Promise<void>;
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
  /** Override the browser binary — the native Lobium launcher points this at the from-source build. */
  executablePath?: string;
  /**
   * Per-launch async args provider, run just before spawn. The native Lobium launcher uses it to write
   * the per-profile `lobium-fp.json` and return its `--lobium-fp-config=<path>` flag, so the native
   * config channel is wired up on every real launch (not just the detector harness).
   */
  extraArgsFor?: (ctx: LaunchContext) => Promise<string[]> | string[];
  /**
   * Per-launch env-var provider (merged over `process.env`), run just before spawn. The native Lobium
   * launcher uses it to write the per-profile private fontconfig and set `FONTCONFIG_FILE` (ENG-6), so
   * the font fingerprint is OS-plausible + stable per profile.
   */
  envFor?: (ctx: LaunchContext) => Promise<Record<string, string> | undefined>;
}

/**
 * Run the post-launch configuration on an already-spawned persistent context (grant geolocation, apply
 * the per-page CDP fingerprint, read the CDP endpoint) and return the {@link LaunchHandle}.
 *
 * If ANY step throws, the Chromium we just spawned would be orphaned — never closed, its user-data
 * `SingletonLock` left behind so the next launch of this profile fails. We close it (best-effort) on
 * any failure before rethrowing. Exported so the orphan-cleanup path is unit-testable with a fake
 * context (a live browser is otherwise required).
 */
export async function configureLaunchedContext(
  context: PwContext,
  ctx: LaunchContext,
): Promise<LaunchHandle> {
  try {
    // Grant geolocation so a page that asks actually reads the proxy-derived coordinates. Without this
    // the override is set but `getCurrentPosition` is denied — geo would silently not apply in production.
    if (ctx.emulation.geolocation) {
      await context.grantPermissions(['geolocation']);
    }

    // Apply the JS-safe fingerprint to every page via CDP (main world) — reliable under patchright,
    // whose addInitScript runs in an isolated world the page's navigator can't see.
    const applyToPage = async (page: PwPage): Promise<void> => {
      const cdp = await context.newCDPSession(page);
      await applyCdpFingerprint(cdp, ctx.fingerprint);
    };
    for (const page of context.pages()) {
      await applyToPage(page);
    }
    context.on('page', (page) => {
      void applyToPage(page);
    });

    const { port, ws } = await readCdpEndpoint(ctx.options.userDataDir);
    return {
      // The OS pid isn't exposed by the persistent-context API; lifecycle is managed via close().
      pid: 0,
      ws,
      debuggerAddress: `127.0.0.1:${port}`,
      close: () => context.close(),
      // Fires on crash / external window close too, so the runner can evict a dead profile.
      onClose: (listener) => context.on('close', listener),
    };
  } catch (err) {
    await context.close().catch(() => {});
    throw err;
  }
}

export function createPatchrightLauncher(opts: PatchrightLauncherOptions = {}): Launcher {
  return async (ctx: LaunchContext): Promise<LaunchHandle> => {
    const chromium = await loadChromium();
    const dynamicArgs = opts.extraArgsFor ? await opts.extraArgsFor(ctx) : [];
    const args = [
      ...ctx.options.args,
      ...(opts.extraArgs ?? []),
      ...dynamicArgs,
      '--remote-debugging-port=0',
    ];

    const options: PersistentContextOptions = {
      headless: opts.headless ?? ctx.options.headless,
      args,
      // JS-safe value substitution (deep surfaces stay native — see MASTER_PLAN §5).
      userAgent: ctx.emulation.userAgent,
      locale: ctx.emulation.locale,
      timezoneId: ctx.emulation.timezoneId,
    };
    if (opts.executablePath) options.executablePath = opts.executablePath;
    const extraEnv = opts.envFor ? await opts.envFor(ctx) : undefined;
    if (extraEnv) {
      // Merge OVER the inherited env (Playwright's `env` replaces it), so the browser keeps its normal
      // environment plus our per-profile overrides (FONTCONFIG_FILE).
      options.env = { ...(process.env as Record<string, string>), ...extraEnv };
    }
    if (ctx.options.proxy) options.proxy = ctx.options.proxy;
    if (ctx.emulation.geolocation) options.geolocation = ctx.emulation.geolocation;

    const context = await chromium.launchPersistentContext(ctx.options.userDataDir, options);
    return configureLaunchedContext(context, ctx);
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
