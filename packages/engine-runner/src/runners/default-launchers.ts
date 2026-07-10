import {
  createLobiumLauncher,
  isLobiumAvailable,
  type NativeLobiumLauncherOptions,
} from './lobium-launcher.js';
import type { LaunchContext, LaunchHandle, LauncherRegistry } from './types.js';

/** Thrown when an engine binary has not been provisioned in this environment. */
export class EngineNotProvisionedError extends Error {
  constructor(engine: string) {
    super(
      `engine "${engine}" is not provisioned — build Lobium, set LOBSTER_LOBIUM_BIN, ` +
        `or package a Lobium runtime with the desktop app.`,
    );
    this.name = 'EngineNotProvisionedError';
  }
}

/**
 * Default launchers. Lobium is the only product engine; until the native binary is provisioned this
 * fails with a clear, actionable error rather than falling back to an uncustomized browser. The
 * CompositeRunner is fully exercised in tests by injecting fake launchers instead.
 */
const notProvisioned =
  (engine: string) =>
  (_ctx: LaunchContext): Promise<LaunchHandle> =>
    Promise.reject(new EngineNotProvisionedError(engine));

export const defaultLaunchers: LauncherRegistry = {
  lobium: notProvisioned('lobium'),
};

export type BuildLaunchersOptions = Pick<NativeLobiumLauncherOptions, 'headless' | 'extraArgs'>;

/** Build the live launcher registry used by the sidecar. Only native Lobium is registered. */
export async function buildLaunchers(opts: BuildLaunchersOptions = {}): Promise<LauncherRegistry> {
  const lobiumReady = isLobiumAvailable();
  if (!lobiumReady && process.env.LOBSTER_LOBIUM_BIN) {
    console.warn(
      `[lobium] LOBSTER_LOBIUM_BIN="${process.env.LOBSTER_LOBIUM_BIN}" does not exist — ` +
        'Lobium launches are unavailable until the native binary is provisioned.',
    );
  }
  return {
    lobium: lobiumReady ? createLobiumLauncher(opts) : notProvisioned('lobium'),
  };
}
