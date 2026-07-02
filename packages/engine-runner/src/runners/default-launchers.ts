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
  return {
    // Lobium is the flagship custom Chromium build; until it ships, the patched interim Chromium
    // serves `lobium` launches too.
    lobium: chromiumReady ? createPatchrightLauncher(opts) : notProvisioned('lobium'),
    chromium: chromiumReady ? createPatchrightLauncher(opts) : notProvisioned('chromium'),
  };
}
