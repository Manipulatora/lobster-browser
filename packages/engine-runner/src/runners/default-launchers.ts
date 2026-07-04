import { createLobiumLauncher, isLobiumAvailable } from './lobium-launcher.js';
import { createPatchrightLauncher, isChromiumAvailable } from './patchright-launcher.js';
import type { LaunchContext, LaunchHandle, LauncherRegistry } from './types.js';

/** Thrown when an engine binary has not been provisioned in this environment. */
export class EngineNotProvisionedError extends Error {
  constructor(engine: string) {
    super(
      `engine "${engine}" is not provisioned — run engines/download-engines.mjs (interim Chromium) ` +
        `or build Lobium, then register a real launcher.`,
    );
    this.name = 'EngineNotProvisionedError';
  }
}

/**
 * Default launchers. The real adapter (patchright driving a patched Chromium) is wired in by
 * {@link buildLaunchers} once a browser is installed; until then these fail with a clear, actionable
 * error rather than pretending to launch. The CompositeRunner is fully exercised in tests by
 * injecting fake launchers instead.
 */
const notProvisioned =
  (engine: string) =>
  (_ctx: LaunchContext): Promise<LaunchHandle> =>
    Promise.reject(new EngineNotProvisionedError(engine));

export const defaultLaunchers: LauncherRegistry = {
  lobium: notProvisioned('lobium'),
  chromium: notProvisioned('chromium'),
};

export interface BuildLaunchersOptions {
  headless?: boolean;
  /** Extra Chromium flags (e.g. `--no-sandbox` in containers/CI). */
  extraArgs?: string[];
}

/**
 * Build the live launcher registry. When a patched Chromium is installed (via
 * `patchright install chromium`), both `chromium` and `lobium` get the real patchright launcher;
 * otherwise they report "engine not provisioned". This is what the sidecar uses at startup.
 */
export async function buildLaunchers(opts: BuildLaunchersOptions = {}): Promise<LauncherRegistry> {
  const chromiumReady = await isChromiumAvailable();
  const lobiumReady = isLobiumAvailable();
  // Loud footgun guard: if LOBSTER_LOBIUM_BIN is SET but doesn't resolve, the operator likely intended
  // native Lobium but a typo/missing file silently downgrades them to interim Chromium (no native
  // canvas/WebGL/audio). Warn rather than pretend — an unset var (dev/CI) is silent and fine.
  if (!lobiumReady && process.env.LOBSTER_LOBIUM_BIN) {
    console.warn(
      `[lobium] LOBSTER_LOBIUM_BIN="${process.env.LOBSTER_LOBIUM_BIN}" does not exist — falling back ` +
        'to the interim Chromium engine for "lobium" launches; native fingerprint surfaces will NOT apply.',
    );
  }
  return {
    // Lobium is the flagship custom Chromium build. When its binary is provisioned
    // (`LOBSTER_LOBIUM_BIN`), `lobium` launches spawn it with the native config channel wired up
    // (`--lobium-fp-config`); otherwise it falls back to the interim patched Chromium so dev/CI still
    // works — deep surfaces are then interim-only until the native binary ships.
    lobium: lobiumReady
      ? createLobiumLauncher(opts)
      : chromiumReady
        ? createPatchrightLauncher(opts)
        : notProvisioned('lobium'),
    chromium: chromiumReady ? createPatchrightLauncher(opts) : notProvisioned('chromium'),
  };
}
