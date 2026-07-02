import type {
  LaunchParams,
  LaunchResult,
  StatusParams,
  StatusResult,
  StopParams,
} from '@lobster/shared-types';
import type { EngineRunner } from '../runner.js';
import { buildCdpEmulation, buildFingerprintInitScript, buildLaunchOptions } from '../launch.js';
import { defaultLaunchers } from './default-launchers.js';
import type { LaunchContext, LaunchHandle, LauncherRegistry } from './types.js';

/**
 * The real engine runner. It prepares a coherent launch (options + CDP emulation + JS-safe init
 * script) from the profile's fingerprint, delegates the actual browser start to the per-engine
 * launcher, and tracks running instances (single-active-instance per profile).
 *
 * The launcher registry is injected, so this orchestration is fully unit-tested with a fake; the
 * real patchright adapter (which needs a browser binary) drops in via {@link defaultLaunchers}.
 */
export class CompositeRunner implements EngineRunner {
  private readonly launchers: LauncherRegistry;
  private readonly running = new Map<string, LaunchHandle>();

  constructor(launchers: LauncherRegistry = defaultLaunchers) {
    this.launchers = launchers;
  }

  async launch(params: LaunchParams): Promise<LaunchResult> {
    if (this.running.has(params.profileId)) {
      throw new Error(`profile ${params.profileId} is already running`);
    }
    const launcher = this.launchers[params.engine];
    if (!launcher) {
      throw new Error(`no launcher registered for engine "${params.engine}"`);
    }

    const ctx: LaunchContext = {
      profileId: params.profileId,
      engine: params.engine,
      options: buildLaunchOptions(params),
      emulation: buildCdpEmulation(params.fingerprint),
      initScript: buildFingerprintInitScript(params.fingerprint),
    };

    const handle = await launcher(ctx);
    this.running.set(params.profileId, handle);
    return {
      profileId: params.profileId,
      pid: handle.pid,
      ws: handle.ws,
      debuggerAddress: handle.debuggerAddress,
    };
  }

  async stop(params: StopParams): Promise<void> {
    const handle = this.running.get(params.profileId);
    if (!handle) {
      throw new Error(`profile ${params.profileId} is not running`);
    }
    await handle.close();
    this.running.delete(params.profileId);
  }

  status(params: StatusParams): Promise<StatusResult> {
    const running = [...this.running.entries()]
      .filter(([id]) => params.profileId === undefined || id === params.profileId)
      .map(([profileId, h]) => ({
        profileId,
        pid: h.pid,
        ws: h.ws,
        debuggerAddress: h.debuggerAddress,
      }));
    return Promise.resolve({ running });
  }
}
