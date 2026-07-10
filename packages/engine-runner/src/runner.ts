import type {
  LaunchParams,
  LaunchResult,
  StatusParams,
  StatusResult,
  StopParams,
} from '@lobster/shared-types';

/**
 * The engine-runner contract. Implemented by CompositeRunner + the direct native Lobium launcher:
 * launch a real Lobium engine with a per-profile user-data-dir + proxy, write the native fingerprint
 * config, and return CDP endpoints for automation/control. Production fingerprinting belongs in
 * Lobium's native config channel, not Patchright/JS spoofing.
 */
export interface EngineRunner {
  launch(params: LaunchParams): Promise<LaunchResult>;
  stop(params: StopParams): Promise<void>;
  status(params: StatusParams): Promise<StatusResult>;
}

/** Day 0 placeholder — proves the IPC loop end-to-end; real launching arrives Day 1. */
export class NotImplementedRunner implements EngineRunner {
  launch(_params: LaunchParams): Promise<LaunchResult> {
    return Promise.reject(new Error('launch: not implemented — use CompositeRunner'));
  }

  stop(_params: StopParams): Promise<void> {
    return Promise.reject(new Error('stop: not implemented until Day 1'));
  }

  status(_params: StatusParams): Promise<StatusResult> {
    return Promise.resolve({ running: [] });
  }
}
