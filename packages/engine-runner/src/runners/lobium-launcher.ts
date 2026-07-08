import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import type { ProxyConfig } from '@lobster/shared-types';
import { writeFontConfig } from '../fonts.js';
import { buildLobiumConfig, lobiumConfigArg, writeLobiumConfig } from '../lobium-config.js';
import { createPatchrightLauncher, type PatchrightLauncherOptions } from './patchright-launcher.js';
import type { Launcher, LaunchContext } from './types.js';

/**
 * The **native Lobium launcher** (T-011 / RUN-1) — the piece that makes the from-source Lobium engine
 * reachable by the product instead of only by the detector harness.
 *
 * It spawns the native Lobium binary (explicit env, dev layout, or packaged resource) via the same
 * patchright driver as the interim engine, but with the **native config channel** wired up: for each launch it writes the
 * profile's resolved fingerprint to `<userDataDir>/lobium-fp.json` (owner-only) and passes
 * `--lobium-fp-config=<path>`, so canvas/WebGL/audio/screen/navigator are spoofed in C++ (no JS tell).
 * The JS-safe surfaces (timezone/locale/geo) are still applied over CDP on top, exactly as for the
 * interim engine — so `connectOverCDP` / Selenium `debuggerAddress` work identically.
 *
 * When no native binary can be resolved, the caller falls back to the interim patched Chromium for
 * `lobium` launches (see `buildLaunchers`), preserving the current dev/CI behaviour.
 */

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
  const base = resolveFontsBaseDir();
  if (!base) {
    return undefined;
  }
  const conf = await writeFontConfig(ctx.options.userDataDir, ctx.fingerprint.os, base);
  return conf ? { FONTCONFIG_FILE: conf } : undefined;
}

/** True when the native Lobium binary is provisioned in this environment. */
export function isLobiumAvailable(): boolean {
  return resolveLobiumBinary() !== undefined;
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
 * live browser. Used as the `extraArgsFor` hook of the underlying patchright launcher.
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
 * Build the native Lobium launcher. Throws if the binary is not provisioned — callers gate on
 * {@link isLobiumAvailable} first (and fall back to the interim engine).
 */
export function createLobiumLauncher(opts: PatchrightLauncherOptions = {}): Launcher {
  const bin = resolveLobiumBinary();
  if (!bin) {
    throw new Error(
      'LOBSTER_LOBIUM_BIN is not set or does not point to an existing file — cannot launch native Lobium',
    );
  }
  return createPatchrightLauncher({
    ...opts,
    executablePath: bin,
    extraArgsFor: buildLobiumLaunchArgs,
    envFor: buildLobiumLaunchEnv,
  });
}
