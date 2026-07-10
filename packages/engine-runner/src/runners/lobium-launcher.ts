import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProxyConfig } from '@lobster/shared-types';
import { readDevToolsEndpoint, clearDevToolsActivePort } from '../devtools-endpoint.js';
import { writeFontConfig } from '../fonts.js';
import { buildLobiumConfig, lobiumConfigArg, writeLobiumConfig } from '../lobium-config.js';
import {
  assertUpstreamReachable,
  needsLocalProxyAdapter,
  startLocalProxyAdapter,
  type LocalProxyAdapter,
} from '../proxy-auth-adapter.js';
// NTP branding is native (patched engine resources); no CDP start-page injection.
import type { Launcher, LaunchContext, LaunchHandle } from './types.js';

/**
 * The **native Lobium launcher** (T-011 / RUN-1) — the piece that makes the from-source Lobium engine
 * reachable by the product instead of only by the detector harness.
 *
 * It spawns the native Lobium binary directly (explicit env, dev layout, or packaged resource) with the
 * **native config channel** wired up: for each launch it writes the profile's resolved fingerprint to
 * `<userDataDir>/lobium-fp.json` (owner-only) and passes `--lobium-fp-config=<path>`, so fingerprint
 * surfaces are owned by C++ instead of JS/CDP/Patchright. CDP is exposed only as an automation/control
 * endpoint (`connectOverCDP`, Selenium `debuggerAddress`), not as the production spoofing layer.
 */

export interface NativeLobiumLauncherOptions {
  headless?: boolean;
  /** Extra Chromium flags (e.g. `--no-sandbox` in containers/CI). */
  extraArgs?: string[];
  /** Override the resolved binary, primarily for unit tests. */
  executablePath?: string;
  /** Per-launch native args provider. Defaults to writing `lobium-fp.json`. */
  extraArgsFor?: (ctx: LaunchContext) => Promise<string[]> | string[];
  /** Per-launch env provider. Defaults to per-profile fontconfig when a font pack is provisioned. */
  envFor?: (ctx: LaunchContext) => Promise<Record<string, string> | undefined>;
}

function isExecutableFile(path: string): boolean {
  try {
    const st = statSync(path);
    if (!st.isFile()) return false;
    return process.platform === 'win32' || (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function platformBinaryNames(): string[] {
  if (process.platform === 'win32') return ['chrome.exe'];
  if (process.platform === 'darwin') {
    return [
      'Chromium.app/Contents/MacOS/Chromium',
      'Google Chrome.app/Contents/MacOS/Google Chrome',
      'chrome',
    ];
  }
  return ['chrome'];
}

function binaryCandidatesFromDir(dir: string): string[] {
  const root = resolve(dir);
  const names = platformBinaryNames();
  return [
    root,
    ...names.map((name) => join(root, name)),
    ...names.map((name) => join(root, 'out', 'Lobium', name)),
    ...names.map((name) => join(root, 'src', 'out', 'Lobium', name)),
    ...names.map((name) => join(root, 'engines', 'lobium', name)),
    ...names.map((name) => join(root, 'engines', 'bin', 'lobium', name)),
    ...names.map((name) => join(root, 'resources', 'lobium', name)),
  ];
}

export function lobiumBinaryCandidates(): string[] {
  const explicitDir = process.env.LOBSTER_LOBIUM_DIR
    ? binaryCandidatesFromDir(process.env.LOBSTER_LOBIUM_DIR)
    : [];
  const autoDiscover =
    process.env.LOBSTER_LOBIUM_AUTO_DISCOVER !== '0' &&
    process.env.LOBSTER_LOBIUM_AUTO_DISCOVER !== 'false';
  const autoDirs = autoDiscover
    ? [
        process.cwd(),
        join(process.cwd(), '..'),
        homedir(),
        join(homedir(), 'lobium-build'),
        join(homedir(), 'browser'),
      ]
    : [];
  return [...explicitDir, ...autoDirs.flatMap(binaryCandidatesFromDir)];
}

/** Resolve the native Lobium binary from explicit env or known dev/package locations. */
export function resolveLobiumBinary(): string | undefined {
  const p = process.env.LOBSTER_LOBIUM_BIN;
  if (p && isExecutableFile(p)) return p;
  for (const candidate of lobiumBinaryCandidates()) {
    if (isExecutableFile(candidate)) return candidate;
  }
  return undefined;
}

/** Resolve the bundled font-pack base dir (`LOBSTER_FONTS_DIR`, e.g. repo `lobium/fonts`), else undefined. */
export function resolveFontsBaseDir(): string | undefined {
  const p = process.env.LOBSTER_FONTS_DIR;
  return p && existsSync(p) ? p : undefined;
}

/**
 * Per-launch env: write the profile's private fontconfig and point FONTCONFIG_FILE at it (ENG-6), so the
 * font fingerprint is OS-plausible + stable per profile. No-op (host fonts) when no font pack is
 * provisioned or the OS has no bundle.
 */
export async function buildLobiumLaunchEnv(
  ctx: LaunchContext,
): Promise<Record<string, string> | undefined> {
  // Dummy Google API keys so Chromium does not show the "Google API keys are missing"
  // infobar. Values are intentionally inert (we do not want profiles calling Google
  // services); their mere presence suppresses the warning. Applied on every launch.
  const env: Record<string, string> = {
    GOOGLE_API_KEY: 'no',
    GOOGLE_DEFAULT_CLIENT_ID: 'no',
    GOOGLE_DEFAULT_CLIENT_SECRET: 'no',
  };
  const base = resolveFontsBaseDir();
  if (base) {
    const conf = await writeFontConfig(ctx.options.userDataDir, ctx.fingerprint.os, base);
    if (conf) {
      env.FONTCONFIG_FILE = conf;
    }
  }
  return env;
}

/** True when the native Lobium binary is provisioned in this environment. */
export function isLobiumAvailable(): boolean {
  return resolveLobiumBinary() !== undefined;
}

function nativeProxyArgs(proxyServer: string | undefined): string[] {
  if (!proxyServer) return [];
  return [`--proxy-server=${proxyServer}`];
}

/**
 * Parse an engine proxy `server` URL (e.g. `http://h:p`, `socks5://h:p`) into the non-secret
 * type/host/port summary the native config records for its WebRTC policy. Credentials are never
 * included — they are passed to the engine out-of-band and never written to the config file.
 */
export function proxySummaryFromServer(
  server: string,
): Pick<ProxyConfig, 'type' | 'host' | 'port'> | undefined {
  try {
    const u = new URL(server);
    const type = u.protocol.replace(/:$/, '') as ProxyConfig['type'];
    const port = Number(u.port);
    if (!u.hostname || !Number.isInteger(port) || port <= 0) return undefined;
    return { type, host: u.hostname, port };
  } catch {
    return undefined;
  }
}

/**
 * Write the per-profile native config for a launch and return the `--lobium-fp-config` flag(s). Pure
 * except for the file write (into the profile's own user-data-dir), so it is unit-testable without a
 * live browser. Used by the direct native launcher and injectable in tests.
 */
export async function buildLobiumLaunchArgs(ctx: LaunchContext): Promise<string[]> {
  const proxy = ctx.options.proxy ? proxySummaryFromServer(ctx.options.proxy.server) : undefined;
  // Pass the profile seed so farbling seeds are unique per profile. Without it, buildLobiumConfig falls
  // back to a device signature, and two profiles that derive the same device class would share
  // canvas/WebGL/audio seeds → identical, linkable hashes (a distinct-per-profile violation, §5).
  const config = buildLobiumConfig(ctx.fingerprint, {
    ...(proxy ? { proxy } : {}),
    ...(ctx.fingerprintSeed !== undefined ? { seed: ctx.fingerprintSeed } : {}),
    ...(ctx.osVersion !== undefined ? { osVersion: ctx.osVersion } : {}),
    ...(ctx.webrtcPolicy !== undefined ? { webrtcPolicy: ctx.webrtcPolicy } : {}),
    ...(ctx.fingerprintPolicy?.renderer !== undefined
      ? { rendererPolicy: ctx.fingerprintPolicy.renderer }
      : {}),
    ...(ctx.fingerprintPolicy?.hardwareNoise !== undefined
      ? { hardwareNoise: ctx.fingerprintPolicy.hardwareNoise }
      : {}),
    ...(ctx.fingerprintPolicy?.mediaDevices !== undefined
      ? { mediaDevices: ctx.fingerprintPolicy.mediaDevices }
      : {}),
  });
  const path = await writeLobiumConfig(ctx.options.userDataDir, config);
  return [lobiumConfigArg(path)];
}

export async function buildNativeLobiumProcessArgs(
  ctx: LaunchContext,
  opts: NativeLobiumLauncherOptions = {},
  /** Already-resolved `--proxy-server` value (local shim or upstream). */
  proxyServer?: string,
): Promise<string[]> {
  const dynamicArgs = opts.extraArgsFor
    ? await opts.extraArgsFor(ctx)
    : await buildLobiumLaunchArgs(ctx);
  const resolvedProxy =
    proxyServer ??
    // Unauthenticated upstream can be passed straight through; authenticated must go via the shim
    // started in createLobiumLauncher (caller supplies proxyServer in that case).
    (ctx.options.proxy && !needsLocalProxyAdapter(ctx.options.proxy)
      ? ctx.options.proxy.server
      : undefined);
  if (ctx.options.proxy && needsLocalProxyAdapter(ctx.options.proxy) && !proxyServer) {
    throw new Error(
      'authenticated proxy requires the local proxy auth adapter — call createLobiumLauncher (not buildNativeLobiumProcessArgs alone)',
    );
  }
  return [
    `--user-data-dir=${ctx.options.userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // Profile name for the NATIVE toolbar chip (rendered left of the omnibox by the Lobium engine
    // patch). Replaces the old in-page profile chip drawn by the injected NTP.
    ...(ctx.profileName ? [`--lobium-profile-name=${ctx.profileName}`] : []),
    ...ctx.options.args,
    ...(opts.extraArgs ?? []),
    ...nativeProxyArgs(resolvedProxy),
    ...((opts.headless ?? ctx.options.headless) ? ['--headless=new'] : []),
    ...dynamicArgs,
    // Open Chromium's REAL New Tab Page (not an injected data:/about:blank mock). The NTP is branded
    // natively: master brand image on the search box + profile_branding.png below it, real shortcuts,
    // "New Tab" title — see lobium/patches/branding/*.
    'chrome://newtab/',
  ];
}

async function buildNativeLobiumEnv(
  ctx: LaunchContext,
  opts: NativeLobiumLauncherOptions,
): Promise<NodeJS.ProcessEnv> {
  const extraEnv = opts.envFor ? await opts.envFor(ctx) : await buildLobiumLaunchEnv(ctx);
  return extraEnv ? { ...process.env, ...extraEnv } : process.env;
}

function signalProcessTree(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    if (process.platform === 'win32') child.kill(signal);
    else process.kill(-child.pid, signal);
  } catch {
    child.kill(signal);
  }
}

/**
 * Best-effort: set Chromium's profile display name so the avatar / profile UI can show the Lobster
 * profile name. True omnibox-left profile chips still need engine chrome patches — this is the
 * Preferences-level approach available without rebuilding Lobium.
 */
export function ensureChromiumProfileName(userDataDir: string, profileName: string): void {
  const name = profileName.trim();
  if (!name) return;
  const defaultDir = join(userDataDir, 'Default');
  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const prefsPath = join(defaultDir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    }
  } catch {
    prefs = {};
  }
  const profile =
    prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile)
      ? ({ ...(prefs.profile as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  profile.name = name;
  // Keep the name from being overwritten by Gaia / sync defaults on first run.
  profile.name_truncated = true;
  // Surface the Lobster profile name in Chromium's profile UI (avatar menu / local profile).
  // A true omnibox-left chip still needs Lobium chrome patches; NTP chip covers the start page.
  prefs.profile = profile;
  // Prefer New Tab on startup so restored legacy data:text/html branding tabs do not win the omnibox.
  const session =
    prefs.session && typeof prefs.session === 'object' && !Array.isArray(prefs.session)
      ? ({ ...(prefs.session as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  // 5 = Open New Tab Page (Chromium SessionStartupPref::Type::LAST is 1).
  session.restore_on_startup = 5;
  prefs.session = session;
  try {
    writeFileSync(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
  } catch {
    /* ignore — branding still works via NTP chip */
  }
}

/**
 * Remove Chromium session files that still point at the old `data:text/html;charset=utf-8,...`
 * branding navigation. Those tabs were restored on every launch and kept the omnibox polluted even
 * after the launcher switched to about:blank + setDocumentContent.
 */
export function scrubLegacyBrandingSessions(userDataDir: string): void {
  const sessionsDir = join(userDataDir, 'Default', 'Sessions');
  if (existsSync(sessionsDir)) {
    let entries: string[] = [];
    try {
      entries = readdirSync(sessionsDir);
    } catch {
      entries = [];
    }
    const needle = Buffer.from('data:text/html');
    for (const name of entries) {
      const path = join(sessionsDir, name);
      try {
        const st = statSync(path);
        if (!st.isFile() || st.size > 64 * 1024 * 1024) continue;
        const buf = readFileSync(path);
        if (buf.includes(needle)) rmSync(path, { force: true });
      } catch {
        /* ignore */
      }
    }
  }

  // Also force New Tab startup so Chromium does not "continue where you left off" into a data: tab.
  const prefsPath = join(userDataDir, 'Default', 'Preferences');
  try {
    mkdirSync(join(userDataDir, 'Default'), { recursive: true });
    let prefs: Record<string, unknown> = {};
    if (existsSync(prefsPath)) {
      prefs = JSON.parse(readFileSync(prefsPath, 'utf8')) as Record<string, unknown>;
    }
    const session =
      prefs.session && typeof prefs.session === 'object' && !Array.isArray(prefs.session)
        ? ({ ...(prefs.session as Record<string, unknown>) } as Record<string, unknown>)
        : {};
    session.restore_on_startup = 5;
    prefs.session = session;
    writeFileSync(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
  } catch {
    /* ignore */
  }
}

function closeProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) signalProcessTree(child, 'SIGKILL');
    }, 5000);
    timer.unref();
    child.once('exit', () => {
      clearTimeout(timer);
      setTimeout(resolve, 250);
    });
    signalProcessTree(child, 'SIGTERM');
  });
}

async function waitForEndpointOrExit(
  child: ChildProcess,
  userDataDir: string,
): Promise<{ port: number; ws: string }> {
  const exit = once(child, 'exit').then(([code, signal]) => {
    throw new Error(
      `Lobium exited before writing DevToolsActivePort (code=${String(code)}, signal=${String(
        signal,
      )})`,
    );
  });
  return Promise.race([readDevToolsEndpoint(userDataDir), exit]);
}

/**
 * Inject imported cookies into a live native Lobium process over raw CDP (PROX-1).
 * Uses the browser WebSocket endpoint directly — Patchright's connectOverCDP + browser.close()
 * can tear down the detached chrome process, so we avoid that path here.
 */
async function applyCookiesToNativeLobium(
  wsUrl: string,
  draft: LaunchContext['cookiesImport'],
): Promise<void> {
  if (!draft) return;
  const cookies = (await import('../cookie-inject.js')).cdpCookiesFromDraft(draft);
  if (cookies.length === 0 && draft.mode !== 'replace') return;

  // Prefer a page/target websocket when available; fall back to the browser endpoint.
  let targetWs = wsUrl;
  try {
    const u = new URL(wsUrl);
    const listUrl = `http://${u.hostname}:${u.port}/json/list`;
    const targets = (await fetch(listUrl).then((r) => r.json())) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) targetWs = page.webSocketDebuggerUrl;
  } catch {
    /* browser endpoint is fine for Network.setCookies */
  }

  await new Promise<void>((resolve, reject) => {
    const ws = new WebSocket(targetWs);
    let nextId = 1;
    const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<unknown>((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      });

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('cookie inject CDP timed out'));
    }, 15_000);

    ws.addEventListener('open', () => {
      void (async () => {
        try {
          if (draft.mode === 'replace') {
            await send('Network.clearBrowserCookies');
          }
          if (cookies.length > 0) {
            await send('Network.setCookies', { cookies });
          }
          clearTimeout(timer);
          ws.close();
          resolve();
        } catch (err) {
          clearTimeout(timer);
          ws.close();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      })();
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id === undefined) return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      } catch {
        /* ignore non-JSON */
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      reject(new Error('cookie inject CDP websocket error'));
    });
  });
}

/**
 * Build the native Lobium launcher. Throws if the binary is not provisioned — callers gate on
 * {@link isLobiumAvailable} first.
 */
export function createLobiumLauncher(opts: NativeLobiumLauncherOptions = {}): Launcher {
  const bin = opts.executablePath ?? resolveLobiumBinary();
  if (!bin) {
    throw new Error(
      'LOBSTER_LOBIUM_BIN is not set or does not point to an existing file — cannot launch native Lobium',
    );
  }
  return async (ctx: LaunchContext): Promise<LaunchHandle> => {
    let adapter: LocalProxyAdapter | undefined;
    try {
      if (ctx.options.proxy) {
        // Fail closed before spawn when the upstream is dead — clearer than a blank Lobium window.
        await assertUpstreamReachable(ctx.options.proxy);
        if (needsLocalProxyAdapter(ctx.options.proxy)) {
          adapter = await startLocalProxyAdapter(ctx.options.proxy);
        }
      }
      if (ctx.profileName) {
        ensureChromiumProfileName(ctx.options.userDataDir, ctx.profileName);
      }
      // Always scrub — even when profileName is missing — so restored data: tabs cannot win.
      scrubLegacyBrandingSessions(ctx.options.userDataDir);
      // Drop a stale DevToolsActivePort so we never brand/automate against a dead previous port.
      await clearDevToolsActivePort(ctx.options.userDataDir);
      const args = await buildNativeLobiumProcessArgs(
        ctx,
        opts,
        adapter?.proxyServer ??
          (ctx.options.proxy && !needsLocalProxyAdapter(ctx.options.proxy)
            ? ctx.options.proxy.server
            : undefined),
      );
      const env = await buildNativeLobiumEnv(ctx, opts);
      const child = spawn(bin, args, {
        env,
        detached: process.platform !== 'win32',
        stdio: 'ignore',
        windowsHide: true,
      });
      try {
        const { port, ws } = await waitForEndpointOrExit(child, ctx.options.userDataDir);
        // Cookie import must run after CDP is up; Patchright's connectOverCDP closes its own
        // connection on browser.close() without SIGTERM'ing our detached chrome (verified by E2E).
        await applyCookiesToNativeLobium(ws, ctx.cookiesImport);
        // NTP branding is now NATIVE (chrome://newtab, patched engine resources) — no CDP injection.
        const closeListeners = new Set<() => void>();
        const shutdownAdapter = async () => {
          if (adapter) {
            await adapter.close().catch(() => {});
            adapter = undefined;
          }
        };
        child.once('exit', () => {
          void shutdownAdapter();
          for (const listener of closeListeners) listener();
        });
        return {
          pid: child.pid ?? 0,
          ws,
          debuggerAddress: `127.0.0.1:${port}`,
          close: async () => {
            await closeProcess(child);
            await shutdownAdapter();
          },
          onClose: (listener) => {
            closeListeners.add(listener);
          },
        };
      } catch (err) {
        await closeProcess(child).catch(() => {});
        throw err;
      }
    } catch (err) {
      if (adapter) await adapter.close().catch(() => {});
      throw err;
    }
  };
}
