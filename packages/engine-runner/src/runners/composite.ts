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
      ...(params.osVersion !== undefined ? { osVersion: params.osVersion } : {}),
      fingerprint: params.fingerprint,
      ...(params.fingerprintPolicy !== undefined
        ? { fingerprintPolicy: params.fingerprintPolicy }
        : {}),
      ...(params.webrtcPolicy !== undefined ? { webrtcPolicy: params.webrtcPolicy } : {}),
      ...(params.fingerprintSeed !== undefined ? { fingerprintSeed: params.fingerprintSeed } : {}),
      options: buildLaunchOptions(params),
      emulation: buildCdpEmulation(params.fingerprint),
      initScript: buildFingerprintInitScript(params.fingerprint),
    };

    const handle = await launcher(ctx);
    this.running.set(params.profileId, handle);
    // Evict the profile if the browser dies out-of-band (crash / user closes the window). Without this
    // the map entry survives and `launch` rejects with "already running" forever — a crash would brick
    // the profile until restart. Guarded so we only delete THIS handle (a fast relaunch may have
    // replaced it). Explicit stop() also deletes; Map.delete is idempotent.
    handle.onClose?.(() => {
      if (this.running.get(params.profileId) === handle) {
        this.running.delete(params.profileId);
      }
    });
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
