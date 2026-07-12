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
import {
  extensionLaunchArgs,
  prepareProfileExtensions,
  type PrepareExtensionsOptions,
} from '../extensions.js';
import { writeFontConfig } from '../fonts.js';
import { buildLobiumConfig, lobiumConfigArg, writeLobiumConfig } from '../lobium-config.js';
import {
  assertLobiumBuildCapabilities,
  LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
  probeLobiumBuildCapabilities,
  requiredLobiumCapabilities,
} from '../lobium-capabilities.js';
import {
  assertUpstreamReachable,
  needsLocalProxyAdapter,
  startLocalProxyAdapter,
  type LocalProxyAdapter,
} from '../proxy-auth-adapter.js';
import { resolveGpuMode } from '../gpu.js';
import { dirname } from 'node:path';
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
  /** Download/cache controls for extension preparation; injectable for deterministic tests. */
  extensions?: PrepareExtensionsOptions;
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

/** Resolve a provisioned font-pack base dir from explicit or packaged runtime locations. */
export function resolveFontsBaseDir(): string | undefined {
  const p = process.env.LOBSTER_FONTS_DIR;
  if (p && existsSync(join(p, 'font-pack.manifest.json'))) return p;
  const bin = resolveLobiumBinary();
  const candidates = [
    ...(bin ? [join(dirname(bin), 'fonts')] : []),
    join(process.cwd(), 'lobium', 'fonts'),
    join(process.cwd(), 'resources', 'fonts'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'font-pack.manifest.json')));
}

/**
 * Per-launch env: write the profile's private fontconfig and point FONTCONFIG_FILE at it (ENG-6), so the
 * font fingerprint is OS-plausible + stable per profile. This is fail-closed: a profile always carries
 * a resolved font list, so an absent pack must never degrade to host `/etc/fonts`.
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
    // Chromium's native locale/timezone defaults come from the child process environment on desktop
    // Linux. Keep those process-wide (including workers and Intl/Date) aligned with the resolved
    // profile instead of relying on the test-only CDP overrides.
    TZ: ctx.fingerprint.locale.timezone,
    LANG: `${ctx.fingerprint.locale.locale.replaceAll('-', '_')}.UTF-8`,
    LC_ALL: `${ctx.fingerprint.locale.locale.replaceAll('-', '_')}.UTF-8`,
  };
  const base = resolveFontsBaseDir();
  if (!base) {
    throw new Error(
      'required Lobium open-font pack is not provisioned; set LOBSTER_FONTS_DIR to a directory containing font-pack.manifest.json',
    );
  }
  env.FONTCONFIG_FILE = await writeFontConfig(
    ctx.options.userDataDir,
    ctx.fingerprint.os,
    base,
    ctx.fingerprint.fonts,
  );
  // Software (SwiftShader) rendering: pin the bundled SwiftShader Vulkan ICD so ANGLE's
  // SwANGLE backend deterministically uses it, instead of the host Vulkan loader possibly
  // selecting a partial/incompatible ICD (which fails `eglInitialize` with "requested
  // extension not supported" → WebGL becomes unavailable and WebGL-dependent pages render
  // blank). Only in software mode, so a real-GPU host is never forced onto SwiftShader.
  if (resolveGpuMode() === 'software') {
    const bin = resolveLobiumBinary();
    if (bin) {
      const icd = join(dirname(bin), 'vk_swiftshader_icd.json');
      if (existsSync(icd)) {
        env.VK_ICD_FILENAMES = icd;
        env.VK_DRIVER_FILES = icd; // newer Vulkan loaders read this name
      }
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
    const protocol = u.protocol.replace(/:$/, '');
    if (protocol !== 'http' && protocol !== 'https' && protocol !== 'socks5') return undefined;
    const type = protocol as ProxyConfig['type'];
    const port = Number(u.port);
    if (!u.hostname || !Number.isInteger(port) || port <= 0 || port > 65_535) return undefined;
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

/**
 * Best-effort `--window-position` centering the phone-sized window would otherwise land wherever
 * the window manager defaults to (often a top-left cascade). Node has no portable way to query the
 * real monitor resolution without a native dependency, so this centers against a common 1920x1080
 * reference — close enough on the common case, and merely off-center (never broken/clipped) on
 * unusual monitor setups since Chromium clamps an off-screen position back on-screen.
 */
function centeredWindowPositionArg(width: number, height: number): string {
  const REFERENCE_SCREEN = { width: 1920, height: 1080 };
  const x = Math.max(0, Math.round((REFERENCE_SCREEN.width - width) / 2));
  const y = Math.max(0, Math.round((REFERENCE_SCREEN.height - height) / 2));
  return `--window-position=${x},${y}`;
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
  const extensionPaths = await prepareProfileExtensions(
    ctx.extensions,
    ctx.options.userDataDir,
    opts.extensions,
  );
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
    // Mobile persona: center the phone-sized window (--window-size already comes from
    // ctx.options.args, sized to the persona's screen). A phone-sized window in the WM's default
    // top-left placement reads as "a small desktop window", not "a phone" — centering is what makes
    // it visually read as a device sitting in the middle of the screen.
    ...(ctx.isMobileProfile
      ? [centeredWindowPositionArg(ctx.fingerprint.screen.availWidth, ctx.fingerprint.screen.availHeight)]
      : []),
    ...ctx.options.args,
    ...(opts.extraArgs ?? []),
    ...extensionLaunchArgs(extensionPaths),
    ...nativeProxyArgs(resolvedProxy),
    ...((opts.headless ?? ctx.options.headless) ? ['--headless=new'] : []),
    ...dynamicArgs,
    // Open Lobium's native New Tab Page (not an injected data:/about:blank mock). After a native
    // rebuild it uses browser-logo.png above search and ad.png below it; see the branding pipeline.
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

function readJsonObject(path: string): Record<string, unknown> {
  try {
    if (existsSync(path)) {
      const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    }
  } catch {
    /* malformed/missing preference file is rebuilt below */
  }
  return {};
}

/**
 * Persist the resolved language cluster before Chromium starts. Unlike the detector harness's CDP
 * override, profile prefs feed navigator.language(s), workers, and the network Accept-Language source.
 */
export function ensureChromiumPersonaPreferences(ctx: LaunchContext): void {
  const defaultDir = join(ctx.options.userDataDir, 'Default');
  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch {
    return;
  }
  const languages = ctx.fingerprint.navigator.languages.join(',');
  const prefsPath = join(defaultDir, 'Preferences');
  const prefs = readJsonObject(prefsPath);
  const intl =
    prefs.intl && typeof prefs.intl === 'object' && !Array.isArray(prefs.intl)
      ? { ...(prefs.intl as Record<string, unknown>) }
      : {};
  intl.accept_languages = languages;
  intl.selected_languages = languages;
  prefs.intl = intl;
  try {
    writeFileSync(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
  } catch {
    /* launch will still carry --lang + environment fallback */
  }

  // Application locale is a Local State pref (not a profile pref). `--lang` remains authoritative,
  // while this keeps restart/profile UI state from resetting it to the host locale.
  const localStatePath = join(ctx.options.userDataDir, 'Local State');
  const localState = readJsonObject(localStatePath);
  const localIntl =
    localState.intl && typeof localState.intl === 'object' && !Array.isArray(localState.intl)
      ? { ...(localState.intl as Record<string, unknown>) }
      : {};
  localIntl.app_locale = ctx.fingerprint.locale.locale;
  localState.intl = localIntl;
  try {
    writeFileSync(localStatePath, JSON.stringify(localState), { mode: 0o600 });
  } catch {
    /* no-op */
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

async function requestGracefulBrowserClose(browserWs: string): Promise<void> {
  await new Promise<void>((resolveClose) => {
    const socket = new WebSocket(browserWs);
    const timer = setTimeout(resolveClose, 1_500);
    timer.unref();
    const finish = () => {
      clearTimeout(timer);
      try {
        socket.close();
      } catch {
        /* browser may already have closed the transport */
      }
      resolveClose();
    };
    socket.addEventListener(
      'open',
      () => socket.send(JSON.stringify({ id: 1, method: 'Browser.close' })),
      { once: true },
    );
    socket.addEventListener('message', finish, { once: true });
    socket.addEventListener('close', finish, { once: true });
    socket.addEventListener('error', finish, { once: true });
  });
}

async function waitForChildExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return true;
  return Promise.race([
    once(child, 'exit').then(() => true),
    new Promise<boolean>((resolveWait) => {
      const timer = setTimeout(() => resolveWait(false), timeoutMs);
      timer.unref();
    }),
  ]);
}

async function closeProcess(child: ChildProcess, browserWs?: string): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (browserWs) {
    await requestGracefulBrowserClose(browserWs);
    if (await waitForChildExit(child, 5_000)) {
      await new Promise((resolveWait) => setTimeout(resolveWait, 250));
      return;
    }
  }
  signalProcessTree(child, 'SIGTERM');
  if (!(await waitForChildExit(child, 5_000))) signalProcessTree(child, 'SIGKILL');
  await waitForChildExit(child, 2_000);
  await new Promise((resolveWait) => setTimeout(resolveWait, 250));
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
async function resolveCdpTarget(wsUrl: string): Promise<string> {
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
  return targetWs;
}

async function withNativeCdp<T>(
  wsUrl: string,
  operation: (session: {
    send(method: string, params?: Record<string, unknown>): Promise<unknown>;
  }) => Promise<T>,
): Promise<T> {
  const targetWs = await resolveCdpTarget(wsUrl);
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(targetWs);
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const send = (method: string, params?: Record<string, unknown>) =>
      new Promise<unknown>((res, rej) => {
        const id = nextId++;
        pending.set(id, { resolve: res, reject: rej });
        ws.send(JSON.stringify({ id, method, params }));
      });

    const timer = setTimeout(() => {
      ws.close();
      reject(new Error('cookie CDP operation timed out'));
    }, 15_000);

    ws.addEventListener('open', () => {
      void (async () => {
        try {
          const result = await operation({ send });
          clearTimeout(timer);
          ws.close();
          resolve(result);
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
      reject(new Error('cookie CDP websocket error'));
    });
  });
}

async function applyCookiesToNativeLobium(
  wsUrl: string,
  draft: LaunchContext['cookiesImport'],
): Promise<boolean> {
  if (!draft) return false;
  const { applyCookieImport } = await import('../cookie-inject.js');
  await withNativeCdp(wsUrl, (session) => applyCookieImport(session, draft));
  return true;
}

/**
 * Make the real OS window (already sized to the persona's phone screen via `--window-size`) behave
 * like a phone viewport, not just a small desktop window: `mobile: true` device-metrics override so
 * CSS `@media (pointer/hover)` and the mobile viewport meta tag path engage, plus touch emulation so
 * mouse input is delivered as touch events (a desktop mouse otherwise never fires touchstart/
 * touchmove, which many "real Android Chrome" mobile sites branch on). Applied once, to the initial
 * tab CDP resolves to a page target for — a tab opened later from user action gets its own CDP
 * session and does not inherit this override (Target-level, not browser-wide).
 */
async function applyAndroidMobileEmulation(
  wsUrl: string,
  fingerprint: LaunchContext['fingerprint'],
): Promise<void> {
  const { width, height, devicePixelRatio } = fingerprint.screen;
  const maxTouchPoints = fingerprint.navigator.maxTouchPoints || 5;
  await withNativeCdp(wsUrl, async (session) => {
    await session.send('Emulation.setTouchEmulationEnabled', {
      enabled: true,
      maxTouchPoints,
    });
    await session.send('Emulation.setEmitTouchEventsForMouse', {
      enabled: true,
      configuration: 'mobile',
    });
    await session.send('Emulation.setDeviceMetricsOverride', {
      width,
      height,
      deviceScaleFactor: devicePixelRatio || 1,
      mobile: true,
      screenWidth: width,
      screenHeight: height,
    });
  });
}

/** Explicit local export of the current cookie jar from a running browser. */
export async function exportCookiesFromNativeLobium(wsUrl: string): Promise<string> {
  const { exportCookiesJson } = await import('../cookie-inject.js');
  return withNativeCdp(wsUrl, (session) => exportCookiesJson(session));
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
  const launch: Launcher = async (ctx: LaunchContext): Promise<LaunchHandle> => {
    let adapter: LocalProxyAdapter | undefined;
    try {
      const capabilities = await probeLobiumBuildCapabilities(bin);
      assertLobiumBuildCapabilities(
        capabilities,
        ctx.fingerprintPolicy
          ? requiredLobiumCapabilities(
              ctx.fingerprintPolicy,
              ctx.fingerprint.locale.geolocation !== undefined,
            )
          : LOBIUM_NATIVE_FINGERPRINT_CAPABILITIES,
      );
      if (ctx.options.proxy) {
        // Fail closed before spawn when the upstream is dead — clearer than a blank Lobium window.
        await assertUpstreamReachable(ctx.options.proxy);
        // Product launches route every proxy type through the loopback adapter, even without auth.
        // That gives HTTP/HTTPS/SOCKS one monitored, remote-DNS-capable, no-direct-fallback boundary.
        adapter = await startLocalProxyAdapter(ctx.options.proxy);
      }
      if (ctx.profileName) {
        ensureChromiumProfileName(ctx.options.userDataDir, ctx.profileName);
      }
      // Always scrub — even when profileName is missing — so restored data: tabs cannot win.
      scrubLegacyBrandingSessions(ctx.options.userDataDir);
      ensureChromiumPersonaPreferences(ctx);
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
      let networkFailure: string | undefined;
      adapter?.onFailure((message) => {
        if (networkFailure) return;
        networkFailure = `proxy upstream failed: ${message}`;
        console.error(`[lobium] profile ${ctx.profileId} ${networkFailure}`);
        // Product-scope fail closed: stop this browser process so it cannot continue in an
        // ambiguous network state. Chromium remains proxy-configured; no direct route is enabled.
        signalProcessTree(child, 'SIGTERM');
      });
      try {
        const { port, ws } = await waitForEndpointOrExit(child, ctx.options.userDataDir);
        // Cookie import must run after CDP is up; Patchright's connectOverCDP closes its own
        // connection on browser.close() without SIGTERM'ing our detached chrome (verified by E2E).
        const cookieImportApplied = await applyCookiesToNativeLobium(ws, ctx.cookiesImport);
        if (ctx.isMobileProfile) {
          await applyAndroidMobileEmulation(ws, ctx.fingerprint);
        }
        // NTP branding is now NATIVE (chrome://newtab, patched engine resources) — no CDP injection.
        const closeListeners = new Set<(reason?: string) => void>();
        const shutdownAdapter = async () => {
          if (adapter) {
            await adapter.close().catch(() => {});
            adapter = undefined;
          }
        };
        child.once('exit', () => {
          void shutdownAdapter();
          for (const listener of closeListeners) listener(networkFailure);
        });
        return {
          pid: child.pid ?? 0,
          ws,
          debuggerAddress: `127.0.0.1:${port}`,
          cookieImportApplied,
          exportCookies: () => exportCookiesFromNativeLobium(ws),
          close: async () => {
            await closeProcess(child, ws);
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
  launch.getBuildCapabilities = () => probeLobiumBuildCapabilities(bin);
  return launch;
}
