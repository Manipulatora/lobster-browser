import { createPatchrightLauncher, isChromiumAvailable } from './patchright-launcher.js';
import type { LaunchContext, LaunchHandle, LauncherRegistry } from './types.js';

/** Thrown when an engine binary has not been provisioned in this environment. */
export class EngineNotProvisionedError extends Error {
  constructor(engine: string) {
    super(
      `engine "${engine}" is not provisioned — run engines/download-engines.mjs (interim engines) ` +
        `or build the Lobster Kernel, then register a real launcher (T-002c).`,
    );
    this.name = 'EngineNotProvisionedError';
  }
}

/**
 * Default launchers. The real adapters (patchright for chromium/kernel, camoufox-js for camoufox)
 * are wired in once engine binaries are available; until then they fail with a clear, actionable
 * error rather than pretending to launch. The CompositeRunner is fully exercised in tests by
 * injecting fake launchers instead.
 */
const notProvisioned =
  (engine: string) =>
  (_ctx: LaunchContext): Promise<LaunchHandle> =>
    Promise.reject(new EngineNotProvisionedError(engine));

export const defaultLaunchers: LauncherRegistry = {
  kernel: notProvisioned('kernel'),
  chromium: notProvisioned('chromium'),
  camoufox: notProvisioned('camoufox'),
};

export interface BuildLaunchersOptions {
  headless?: boolean;
  /** Extra Chromium flags (e.g. `--no-sandbox` in containers/CI). */
  extraArgs?: string[];
}

/**
 * Build the live launcher registry. When a patched Chromium is installed (via
 * `patchright install chromium`), the `chromium` and interim `kernel` engines get the real
 * patchright launcher; otherwise they report "engine not provisioned". Camoufox is wired in a
 * later ticket. This is what the sidecar uses at startup.
 */
export async function buildLaunchers(opts: BuildLaunchersOptions = {}): Promise<LauncherRegistry> {
  const chromiumReady = await isChromiumAvailable();
  return {
    // The Lobster Kernel is the flagship Chromium build; until it exists, the patched interim
    // Chromium serves `kernel` launches too.
    kernel: chromiumReady ? createPatchrightLauncher(opts) : notProvisioned('kernel'),
    chromium: chromiumReady ? createPatchrightLauncher(opts) : notProvisioned('chromium'),
    camoufox: notProvisioned('camoufox'),
  };
}
