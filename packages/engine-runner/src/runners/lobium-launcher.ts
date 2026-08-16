import { spawn, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { once } from 'node:events';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import type { ProxyConfig } from '@lobster/shared-types';
import { readDevToolsEndpoint, clearDevToolsActivePort } from '../devtools-endpoint.js';
import {
  extensionLaunchArgs,
  LOBEE_EXTENSION_ID,
  prepareDefaultLobeeExtension,
  prepareProfileExtensions,
  type PrepareExtensionsOptions,
} from '../extensions.js';
import { writeFontConfig } from '../fonts.js';
import { withCdpSession } from '../cdp-client.js';
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
  upstreamProxyUrl,
  type LocalProxyAdapter,
} from '../proxy-auth-adapter.js';
import { resolveGpuMode } from '../gpu.js';
import { deviceFrameGeometry, resolveDesktopWorkArea } from '../device-frame.js';
import {
  installMobileEmulationForAllTargets,
  type MobileEmulationController,
} from '../mobile-emulation.js';
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
  const entryDir = process.argv[1] ? dirname(resolve(process.argv[1])) : undefined;
  const nodeDir = dirname(process.execPath);
  const candidates = [
    ...(bin ? [join(dirname(bin), 'fonts')] : []),
    // Tauri Linux bundles place the sidecar at <resources>/sidecar/index.js and the pack at
    // <resources>/fonts. This path must work even when the desktop entry was launched directly and
    // therefore did not source the optional user-local wrapper environment.
    ...(entryDir ? [join(entryDir, '..', 'fonts')] : []),
    // Bundled Node is <resources>/node/bin/node. Keep this second resource-relative route so a
    // custom sidecar entry point cannot disconnect an otherwise valid packaged font pack.
    join(nodeDir, '..', '..', 'fonts'),
    join(homedir(), '.local', 'share', 'lobster', 'lobium', 'fonts'),
    // Windows has no XDG data dir. The Tauri MSI/NSIS bundle installs resources next to the
    // executable, and a per-user install lands under %LOCALAPPDATA%; both are checked so a packaged
    // Windows build finds its pack without the user setting LOBSTER_FONTS_DIR by hand.
    ...(process.platform === 'win32'
      ? [
          join(process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local'), 'Lobster', 'lobium', 'fonts'),
          join(process.env.PROGRAMDATA ?? 'C:\\ProgramData', 'Lobster', 'lobium', 'fonts'),
        ]
      : []),
    join(process.cwd(), 'lobium', 'fonts'),
    join(process.cwd(), 'resources', 'fonts'),
  ];
  return candidates.find((candidate) => existsSync(join(candidate, 'font-pack.manifest.json')));
}

/**
 * Per-launch env: write the profile's private fontconfig and point FONTCONFIG_FILE at it (ENG-6), so the
 * font fingerprint is OS-plausible + stable per profile. This is fail-closed: a profile always carries
 * a resolved font list, so an absent pack must never degrade to host `/etc/fonts`.
 *
 * Windows reaches the same isolation through a different mechanism, because none of these variables
 * exist there: fontconfig is not used at all (DirectWrite is), and ICU reads the timezone from the
 * registry rather than from `TZ`. Both are handled natively instead — the engine filters DirectWrite
 * family lookups against `cfg.fonts` and sideloads `cfg.fontPackDir`, and applies the persona
 * timezone inside TimeZoneController. So on Windows this function contributes only the inert Google
 * API keys, and the pack is passed through the config file by {@link windowsFontPackDir}.
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

  if (process.platform === 'win32') {
    // No POSIX locale/fontconfig variables: setting TZ here would look like the timezone was
    // handled when ICU ignores it, which is exactly the silent half-application the native
    // timezone hook exists to prevent.
    return env;
  }

  // Chromium's native locale/timezone defaults come from the child process environment on desktop
  // Linux. Keep those process-wide (including workers and Intl/Date) aligned with the resolved
  // profile instead of relying on the test-only CDP overrides.
  env.TZ = ctx.fingerprint.locale.timezone;
  env.LANG = `${ctx.fingerprint.locale.locale.replaceAll('-', '_')}.UTF-8`;
  env.LC_ALL = `${ctx.fingerprint.locale.locale.replaceAll('-', '_')}.UTF-8`;
  // Fontconfig accepts BCP-47 directly even when the matching libc locale is not installed on the
  // host. This selects the correct localized face from bundled CJK collections without weakening
  // the private font-directory isolation.
  env.FC_LANG = ctx.fingerprint.locale.locale;

  const base = resolveFontsBaseDir();
  if (!base) {
    throw new Error(
      'required Lobium open-font pack is not provisioned; set LOBSTER_FONTS_DIR to a directory containing font-pack.manifest.json',
    );
  }
  env.FONTCONFIG_FILE = await writeFontConfig(
    ctx.options.userDataDir,
    ctx.isMobileProfile ? 'android' : ctx.fingerprint.os,
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

/**
 * The font-pack directory to hand the engine on Windows, or undefined everywhere else.
 *
 * Fail-OPEN, unlike the Linux path above, and the asymmetry is deliberate. On Linux an absent pack
 * would leave FONTCONFIG_FILE unset and the profile would fall back to the host's `/etc/fonts` —
 * host fonts leaking wholesale, so the launch must abort. On Windows the native filter still applies
 * with no pack at all: the persona's measurable set becomes host ∩ persona, which is narrower than
 * the persona claims but never wider than the host. Degraded, not leaking. Aborting the launch would
 * trade a partial fingerprint for no browser.
 */
export function windowsFontPackDir(): string | undefined {
  if (process.platform !== 'win32') return undefined;
  const base = resolveFontsBaseDir();
  return base ? resolve(base) : undefined;
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
    // Windows only; elsewhere the same pack is reached through FONTCONFIG_FILE instead.
    ...(windowsFontPackDir() ? { fontPackDir: windowsFontPackDir()! } : {}),
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
  const extensionPaths = await prepareProfileExtensions(ctx.extensions, ctx.options.userDataDir, {
    ...opts.extensions,
    // A web-store install is a network request made on this profile's behalf, so it belongs on this
    // profile's route. Passing the proxy is what makes the download refuse rather than fall back to
    // the host's own address.
    ...(ctx.options.proxy ? { proxyUrl: upstreamProxyUrl(ctx.options.proxy) } : {}),
  });
  // Lobee (the first-party in-browser agent side panel) is auto-loaded into every profile, ahead of
  // any user extensions. It injects no content scripts, so a page can't see it; its actions run in
  // this sidecar over leak-free CDP. Absent (dev/CI without the bundle) → simply not added.
  const lobeePath = await prepareDefaultLobeeExtension(ctx.options.userDataDir, ctx.profileId);
  const allExtensionPaths = lobeePath ? [lobeePath, ...extensionPaths] : extensionPaths;
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
  const deviceFrame =
    ctx.isMobileProfile && ctx.mobileFormFactor
      ? deviceFrameGeometry(
          ctx.fingerprint.screen,
          ctx.mobileFormFactor,
          await resolveDesktopWorkArea(),
        )
      : undefined;
  return [
    `--user-data-dir=${ctx.options.userDataDir}`,
    '--remote-debugging-port=0',
    '--no-first-run',
    '--no-default-browser-check',
    // Pin the cookie/password encryption to the stable "basic" OSCrypt key. Without this, headless/Xvfb
    // Linux resolves the key from a desktop keyring that may be absent or differ between launches, so a
    // later launch cannot decrypt Default/Cookies and the user is silently logged out (e.g. a Google
    // account needing re-login). The basic store uses a fixed key, so the cookie jar always decrypts.
    '--password-store=basic',
    // Restore the previous session (open tabs) on relaunch. The launcher also seeds
    // session.restore_on_startup=1; this flag forces it regardless of any startup URL.
    '--restore-last-session',
    // Profile name for the NATIVE toolbar chip (rendered left of the omnibox by the Lobium engine
    // patch). Replaces the old in-page profile chip drawn by the injected NTP.
    ...(ctx.profileName ? [`--lobium-profile-name=${ctx.profileName}`] : []),
    // Android keeps a normal full-size Lobium window. Native BrowserView lays the real WebContents
    // inside the sourced centered device stage below the desktop tab strip/omnibox.
    ...(deviceFrame
      ? [
          '--start-maximized',
          `--lobium-device-frame=${ctx.mobileFormFactor}`,
          `--lobium-device-screen=${ctx.fingerprint.screen.width}x${ctx.fingerprint.screen.height}`,
          // Native BrowserView computes the exact content-area fit scale from its real layout and, via
          // the retry-until-applied sync in LobiumDeviceFrameView, keeps the renderer's device-emulation
          // image scale locked to the aperture through startup, resize, and whole-device zoom. There is no
          // command-line scale bootstrap: a static estimate could never match the live fit and had no
          // native consumer.
        ]
      : []),
    ...ctx.options.args.filter(
      (arg) =>
        !deviceFrame ||
        (!arg.startsWith('--window-size=') && !arg.startsWith('--window-position=')),
    ),
    ...(opts.extraArgs ?? []),
    ...extensionLaunchArgs(allExtensionPaths),
    // Ask the Lobium engine to auto-open Lobee's side panel at startup (a browser-side Show with no
    // user-gesture requirement; consumed by the LobiumSidePanelAutoOpener fork hook). Harmlessly
    // ignored by an engine build that predates the hook. Only when Lobee is actually loaded.
    ...(lobeePath ? [`--lobium-open-side-panel=${LOBEE_EXTENSION_ID}`] : []),
    ...nativeProxyArgs(resolvedProxy),
    ...((opts.headless ?? ctx.options.headless) ? ['--headless=new'] : []),
    ...dynamicArgs,
    // No forced startup URL: with --restore-last-session the previous tabs are reopened. On the very
    // first run (no saved session) Chromium opens its default New Tab Page — Lobium's native branded NTP
    // (browser-logo.png above search, ad.png below) — so branding still shows without suppressing restore.
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
/**
 * Read a JSON preferences file for read-modify-write. Returns `{}` when the file is ABSENT (a fresh
 * profile) but `null` when it EXISTS yet is unparseable — so callers skip writing rather than clobber
 * the user's real preferences with a fresh object (LOBIUM data-safety: a corrupt/half-written file must
 * never be silently replaced).
 */
function readPrefsForUpdate(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return {};
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

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
  const prefs = readPrefsForUpdate(prefsPath);
  if (prefs === null) {
    // Preferences exists but is unparseable (corrupt or a partial write). Never overwrite it with a
    // fresh object — that would discard all of the user's real Chromium preferences. Skip this
    // cosmetic, best-effort name injection for this launch and preserve the file intact.
    return;
  }
  const profile =
    prefs.profile && typeof prefs.profile === 'object' && !Array.isArray(prefs.profile)
      ? ({ ...(prefs.profile as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  // Every profile presents its LOCAL browser identity as the fixed brand name "Your Lobium"
  // (matches the native profile-menu title). The real per-profile name is NOT written here — it
  // is carried only on the --lobium-profile-name switch, which the engine shows as the leading
  // omnibox chip on chrome:// pages. This keeps the top-right account menu from leaking the
  // per-profile label.
  profile.name = 'Your Lobium';
  // Keep the name from being overwritten by Gaia / sync defaults on first run.
  profile.name_truncated = true;
  prefs.profile = profile;
  // Prefer New Tab on startup so restored legacy data:text/html branding tabs do not win the omnibox.
  const session =
    prefs.session && typeof prefs.session === 'object' && !Array.isArray(prefs.session)
      ? ({ ...(prefs.session as Record<string, unknown>) } as Record<string, unknown>)
      : {};
  // 1 = "Continue where you left off" (Chromium SessionStartupPref::Type::LAST). Restores the previous
  // tabs on relaunch instead of forcing a fresh New Tab Page (which discarded unpinned tabs).
  session.restore_on_startup = 1;
  prefs.session = session;
  try {
    writeFileSync(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
  } catch {
    /* ignore — branding still works via NTP chip */
  }
}

/**
 * Pin the first-party Lobee extension to the toolbar so its icon is always visible (not buried in the
 * puzzle menu). This is the plain, unprotected profile pref `extensions.pinned_extensions` (a list of
 * extension IDs); it needs no MAC/super_mac. No-op when Lobee isn't bundled (`LOBSTER_LOBEE_DIR` unset)
 * or when it is already pinned. Merges into the existing `extensions` object so sibling keys survive.
 */
export function ensureLobeePreferences(userDataDir: string): void {
  if (!process.env.LOBSTER_LOBEE_DIR) return;
  const defaultDir = join(userDataDir, 'Default');
  try {
    mkdirSync(defaultDir, { recursive: true });
  } catch {
    return;
  }
  const prefsPath = join(defaultDir, 'Preferences');
  const prefs = readPrefsForUpdate(prefsPath);
  if (prefs === null) return; // never clobber a corrupt/half-written Preferences file
  const extensions =
    prefs.extensions && typeof prefs.extensions === 'object' && !Array.isArray(prefs.extensions)
      ? { ...(prefs.extensions as Record<string, unknown>) }
      : {};
  const existing = Array.isArray(extensions.pinned_extensions)
    ? (extensions.pinned_extensions as unknown[]).filter((x): x is string => typeof x === 'string')
    : [];
  if (existing.includes(LOBEE_EXTENSION_ID)) return;
  // Pin Lobee leftmost (nearest the omnibox), keeping any user-pinned extensions after it.
  extensions.pinned_extensions = [LOBEE_EXTENSION_ID, ...existing];
  prefs.extensions = extensions;
  try {
    writeFileSync(prefsPath, JSON.stringify(prefs), { mode: 0o600 });
  } catch {
    /* best-effort: the extension still loads, just unpinned */
  }
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
  // Skip (never clobber) an existing-but-unparseable Preferences file; --lang + env carry the locale.
  const prefs = readPrefsForUpdate(prefsPath);
  if (prefs !== null) {
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
  }

  // Application locale is a Local State pref (not a profile pref). `--lang` remains authoritative,
  // while this keeps restart/profile UI state from resetting it to the host locale.
  const localStatePath = join(ctx.options.userDataDir, 'Local State');
  const localState = readPrefsForUpdate(localStatePath);
  if (localState !== null) {
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
        if (buf.includes(needle)) {
          // Do NOT irreversibly delete the session file — an SNSS session encodes many tabs/windows, so
          // deleting the whole file to drop one legacy branding tab can destroy unrelated user tabs.
          // Move it aside instead: Chromium starts without the legacy tab, and the session data is
          // preserved (recoverable) rather than lost.
          try {
            renameSync(path, `${path}.lobium-legacy-bak`);
          } catch {
            /* if the backup rename fails, leave the file untouched rather than destroy it */
          }
        }
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
    // 1 = restore the previous session (see the note in ensureChromiumPersonaPreferences). This legacy
    // branding-session scrub must not force a fresh NTP and discard the user's open tabs.
    session.restore_on_startup = 1;
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
 * Inject imported cookies into a live native Lobium process over raw CDP (PROX-1), using the
 * first-party {@link withCdpSession} client (no automation fork). It talks to the DevTools endpoint
 * directly — patchright's `connectOverCDP` + `browser.close()` can tear down the detached chrome
 * process, so that path is avoided here.
 */
async function applyCookiesToNativeLobium(
  wsUrl: string,
  draft: LaunchContext['cookiesImport'],
): Promise<boolean> {
  if (!draft) return false;
  const { applyCookieImport } = await import('../cookie-inject.js');
  await withCdpSession(wsUrl, (session) => applyCookieImport(session, draft));
  return true;
}

/** Explicit local export of the current cookie jar from a running browser. */
export async function exportCookiesFromNativeLobium(wsUrl: string): Promise<string> {
  const { exportCookiesJson } = await import('../cookie-inject.js');
  return withCdpSession(wsUrl, (session) => exportCookiesJson(session));
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
    let mobileEmulation: MobileEmulationController | undefined;
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
      ensureLobeePreferences(ctx.options.userDataDir);
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
          mobileEmulation = await installMobileEmulationForAllTargets(ws, ctx.fingerprint, {
            formFactor: ctx.mobileFormFactor ?? 'phone',
            initialScale: deviceFrameGeometry(
              ctx.fingerprint.screen,
              ctx.mobileFormFactor ?? 'phone',
              await resolveDesktopWorkArea(),
            ).visualScale,
          });
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
          mobileEmulation?.close();
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
            mobileEmulation?.close();
            await closeProcess(child, ws);
            await shutdownAdapter();
          },
          onClose: (listener) => {
            closeListeners.add(listener);
          },
        };
      } catch (err) {
        mobileEmulation?.close();
        await closeProcess(child).catch(() => {});
        throw err;
      }
    } catch (err) {
      mobileEmulation?.close();
      if (adapter) await adapter.close().catch(() => {});
      throw err;
    }
  };
  launch.getBuildCapabilities = () => probeLobiumBuildCapabilities(bin);
  return launch;
}
