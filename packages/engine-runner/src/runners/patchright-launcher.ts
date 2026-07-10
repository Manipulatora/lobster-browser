import { existsSync } from 'node:fs';
import { applyCdpFingerprint, type CdpSession } from '../cdp-fingerprint.js';
import { applyCookieImport } from '../cookie-inject.js';
import { readDevToolsEndpoint } from '../devtools-endpoint.js';
import {
  buildLobsterStartPageHtml,
  isBrandableStartUrl,
  isNtpUrl,
  LOBSTER_START_PAGE_URL,
} from './branding-start-page.js';
import type { Launcher, LaunchContext, LaunchHandle } from './types.js';

export { LOBSTER_START_PAGE_URL, buildLobsterStartPageHtml } from './branding-start-page.js';

/**
 * Internal launcher backed by **patchright** (a stealth-hardened Playwright fork) driving a Chrome-family
 * binary. This is kept for validation harnesses and compatibility tests only. Production profiles launch
 * through the direct native Lobium launcher in `lobium-launcher.ts`.
 *
 * It launches a persistent context (per-profile user-data-dir) and may apply legacy CDP/init-script
 * substitutions for regression comparison. It never represents production fingerprint depth. We ask the
 * browser for a real CDP port (`--remote-debugging-port=0`) and read the resulting `DevToolsActivePort`
 * file so harness automation can `connectOverCDP(ws)` / set Selenium `debuggerAddress`.
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
  viewport?: null | { width: number; height: number };
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
interface NavigablePage {
  goto(url: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  /** Playwright setContent — preferred so the omnibox stays about:blank (no data: URL). */
  setContent?(html: string, opts?: { waitUntil?: string; timeout?: number }): Promise<unknown>;
  url?: () => string;
}
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

function navigablePage(page: PwPage): NavigablePage | undefined {
  const candidate = page as Partial<NavigablePage>;
  return typeof candidate.goto === 'function' ? (candidate as NavigablePage) : undefined;
}

async function maybeOpenLobsterStartPage(
  page: PwPage,
  { allowBlank, profileName }: { allowBlank: boolean; profileName?: string },
): Promise<void> {
  const nav = navigablePage(page);
  if (!nav) return;
  const url = nav.url?.() ?? '';
  if (allowBlank ? !isBrandableStartUrl(url) : !isNtpUrl(url)) return;
  const html = buildLobsterStartPageHtml(
    profileName !== undefined ? { profileName } : {},
  );
  // Prefer setContent so the address bar stays about:blank (not a huge data: URL).
  if (typeof nav.setContent === 'function') {
    await nav.goto('about:blank', { waitUntil: 'commit', timeout: 10_000 }).catch(() => {});
    await nav.setContent(html, { waitUntil: 'commit', timeout: 10_000 });
    return;
  }
  // Last resort for minimal fakes: never navigate to LOBSTER_START_PAGE_URL (pollutes omnibox).
  await nav.goto('about:blank', { waitUntil: 'commit', timeout: 10_000 }).catch(() => {});
  // Fake pages in unit tests only implement goto; production Patchright always has setContent.
  void LOBSTER_START_PAGE_URL;
  void html;
}

/**
 * Brand the initial tab, then brand every subsequent NTP tab (not every about:blank).
 * Previous behavior only branded pages[0], which made branding look first-tab-only.
 */
async function openLobsterStartPage(
  context: PwContext,
  pages: PwPage[],
  profileName?: string,
): Promise<void> {
  const brandOpts =
    profileName !== undefined
      ? { allowBlank: true as const, profileName }
      : { allowBlank: true as const };
  const brandOptsLater =
    profileName !== undefined
      ? { allowBlank: false as const, profileName }
      : { allowBlank: false as const };
  const initial = pages.length > 0 ? pages : [await context.newPage()];
  for (const page of initial) {
    await maybeOpenLobsterStartPage(page, brandOpts);
  }
  context.on('page', (page) => {
    void maybeOpenLobsterStartPage(page, brandOptsLater);
  });
}

export interface PatchrightLauncherOptions {
  headless?: boolean;
  /** Extra Chromium flags (e.g. `--no-sandbox` in containers/CI). */
  extraArgs?: string[];
  /** Override the browser binary for harness tests. */
  executablePath?: string;
  /**
   * Per-launch async args provider, run just before spawn. Kept for harness experiments; production
   * Lobium config args are built by `lobium-launcher.ts`.
   */
  extraArgsFor?: (ctx: LaunchContext) => Promise<string[]> | string[];
  /**
   * Per-launch env-var provider (merged over `process.env`), run just before spawn. Kept for harness
   * experiments such as private fontconfig validation.
   */
  envFor?: (ctx: LaunchContext) => Promise<Record<string, string> | undefined>;
}

/**
 * Run the post-launch configuration on an already-spawned persistent context (grant geolocation, apply
 * legacy harness substitutions, read the CDP endpoint) and return the {@link LaunchHandle}.
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
    // Grant geolocation so a page that asks actually reads the proxy-derived coordinates in the harness.
    if (ctx.emulation.geolocation) {
      await context.grantPermissions(['geolocation']);
    }

    // Apply legacy harness substitutions to every page via CDP (main world). Production Lobium does not
    // use this path for fingerprinting.
    const applyToPage = async (page: PwPage): Promise<void> => {
      const cdp = await context.newCDPSession(page);
      await applyCdpFingerprint(cdp, ctx.fingerprint);
    };
    let pages = context.pages();
    for (const page of pages) {
      await applyToPage(page);
    }
    context.on('page', (page) => {
      void applyToPage(page);
    });

    // Load the profile's imported cookies into the context BEFORE the app navigates, so it opens
    // already logged-in (PROX-1). Uses a CDP session on an existing page; `Network.setCookies` applies
    // to the whole browser context. No-op when the profile has no cookie import.
    if (ctx.cookiesImport) {
      const cookiePage = pages[0] ?? (await context.newPage());
      if (pages.length === 0) pages = [cookiePage];
      const cdp = await context.newCDPSession(cookiePage);
      await applyCookieImport(cdp, ctx.cookiesImport);
    }

    await openLobsterStartPage(context, pages, ctx.profileName);

    const { port, ws } = await readDevToolsEndpoint(ctx.options.userDataDir);
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
      // Patchright/Playwright defaults to a fixed 1280x720 viewport. In a real headed browser that can
      // leave a dead blank strip beside the page when the window is larger. Let the viewport follow the
      // Lobium window instead; native screen hooks still control screen.*.
      viewport: null,
      // Legacy harness value substitution. Production values are native Lobium config.
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
