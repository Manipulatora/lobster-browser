import type {
  LaunchParams,
  LaunchResult,
  ExportCookiesResult,
  StatusParams,
  StatusResult,
  StopParams,
} from '@lobster/shared-types';
import type { LobiumBuildCapabilities } from './lobium-capabilities.js';

/**
 * The engine-runner contract. Implemented by CompositeRunner + the direct native Lobium launcher:
 * launch a real Lobium engine with a per-profile user-data-dir + proxy, write the native fingerprint
 * config, and return CDP endpoints for automation/control. Production fingerprinting belongs in
 * Lobium's native config channel, not Patchright/JS spoofing.
 */
export interface EngineRunner {
  /** Probe the exact executable selected by this runner; profile launch uses this to fail closed. */
  getLobiumBuildCapabilities(): Promise<LobiumBuildCapabilities>;
  launch(params: LaunchParams): Promise<LaunchResult>;
  stop(params: StopParams): Promise<void>;
  status(params: StatusParams): Promise<StatusResult>;
  exportCookies(profileId: string): Promise<ExportCookiesResult>;
}

/** Day 0 placeholder — proves the IPC loop end-to-end; real launching arrives Day 1. */
export class NotImplementedRunner implements EngineRunner {
  getLobiumBuildCapabilities(): Promise<LobiumBuildCapabilities> {
    return Promise.reject(new Error('Lobium capability probe: not implemented'));
  }

  launch(_params: LaunchParams): Promise<LaunchResult> {
    return Promise.reject(new Error('launch: not implemented — use CompositeRunner'));
  }

  stop(_params: StopParams): Promise<void> {
    return Promise.reject(new Error('stop: not implemented until Day 1'));
  }

  status(_params: StatusParams): Promise<StatusResult> {
    return Promise.resolve({ running: [] });
  }

  exportCookies(_profileId: string): Promise<ExportCookiesResult> {
    return Promise.reject(new Error('cookie export: not implemented'));
  }
}
