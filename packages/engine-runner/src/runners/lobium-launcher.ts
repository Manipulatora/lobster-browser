import { existsSync } from 'node:fs';
import type { ProxyConfig } from '@lobster/shared-types';
import { writeFontConfig } from '../fonts.js';
import { buildLobiumConfig, lobiumConfigArg, writeLobiumConfig } from '../lobium-config.js';
import { createPatchrightLauncher, type PatchrightLauncherOptions } from './patchright-launcher.js';
import type { Launcher, LaunchContext } from './types.js';

/**
 * The **native Lobium launcher** (T-011 / RUN-1) — the piece that makes the from-source Lobium engine
 * reachable by the product instead of only by the detector harness.
 *
 * It spawns the native Lobium binary (`LOBSTER_LOBIUM_BIN`) via the same patchright driver as the
 * interim engine, but with the **native config channel** wired up: for each launch it writes the
 * profile's resolved fingerprint to `<userDataDir>/lobium-fp.json` (owner-only) and passes
 * `--lobium-fp-config=<path>`, so canvas/WebGL/audio/screen/navigator are spoofed in C++ (no JS tell).
 * The JS-safe surfaces (timezone/locale/geo) are still applied over CDP on top, exactly as for the
 * interim engine — so `connectOverCDP` / Selenium `debuggerAddress` work identically.
 *
 * When `LOBSTER_LOBIUM_BIN` is not set, the caller falls back to the interim patched Chromium for
 * `lobium` launches (see `buildLaunchers`), preserving the current dev/CI behaviour.
 */

/** Resolve the native Lobium binary: `LOBSTER_LOBIUM_BIN` if it exists on disk, else undefined. */
export function resolveLobiumBinary(): string | undefined {
  const p = process.env.LOBSTER_LOBIUM_BIN;
  return p && existsSync(p) ? p : undefined;
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
