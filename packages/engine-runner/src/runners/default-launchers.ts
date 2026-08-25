import {
  createLobiumLauncher,
  resolveLobiumRuntime,
  type NativeLobiumLauncherOptions,
  type ResolvedLobiumRuntime,
} from './lobium-launcher.js';
import type { LauncherRegistry } from './types.js';

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

export type BuildLaunchersOptions = Pick<NativeLobiumLauncherOptions, 'headless' | 'extraArgs'>;

export interface BuildLaunchersDependencies {
  resolveRuntime: () => ResolvedLobiumRuntime | undefined;
  createLauncher: (opts: NativeLobiumLauncherOptions) => NonNullable<LauncherRegistry['lobium']>;
}

const liveDependencies: BuildLaunchersDependencies = {
  resolveRuntime: resolveLobiumRuntime,
  createLauncher: createLobiumLauncher,
};

function lazyLobiumLauncher(
  opts: BuildLaunchersOptions,
  deps: BuildLaunchersDependencies,
): NonNullable<LauncherRegistry['lobium']> {
  const concrete = () => {
    const runtime = deps.resolveRuntime();
    if (!runtime) throw new EngineNotProvisionedError('lobium');
    return deps.createLauncher({
      ...opts,
      executablePath: runtime.executablePath,
      managedRuntime: runtime.managed,
    });
  };
  const launch: NonNullable<LauncherRegistry['lobium']> = async (ctx) => concrete()(ctx);
  launch.getBuildCapabilities = async () => {
    const getBuildCapabilities = concrete().getBuildCapabilities;
    if (!getBuildCapabilities) {
      throw new Error('the concrete Lobium launcher has no native capability probe');
    }
    return getBuildCapabilities();
  };
  return launch;
}

/** Default registry used by CompositeRunner; resolution remains lazy across first-run provisioning. */
export const defaultLaunchers: LauncherRegistry = {
  lobium: lazyLobiumLauncher({}, liveDependencies),
};

/** Build a lazy live registry so first-run provisioning is visible without restarting the sidecar. */
export async function buildLaunchers(
  opts: BuildLaunchersOptions = {},
  deps: BuildLaunchersDependencies = liveDependencies,
): Promise<LauncherRegistry> {
  return {
    lobium: lazyLobiumLauncher(opts, deps),
  };
}
