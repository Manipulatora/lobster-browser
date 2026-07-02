import type {
  LaunchParams,
  LaunchResult,
  StatusParams,
  StatusResult,
  StopParams,
} from '@lobster/shared-types';

/**
 * The engine-runner contract. Day 1 implements this with patchright (Chromium) and
 * camoufox-js (Camoufox): launch a real engine with a per-profile user-data-dir + proxy,
 * inject the JS-safe fingerprint surfaces via isolated init scripts, and return the CDP
 * endpoints. Deep surfaces (canvas/webgl/audio) are handled by the native engine.
 */
export interface EngineRunner {
  launch(params: LaunchParams): Promise<LaunchResult>;
  stop(params: StopParams): Promise<void>;
  status(params: StatusParams): Promise<StatusResult>;
}

/** Day 0 placeholder — proves the IPC loop end-to-end; real launching arrives Day 1. */
export class NotImplementedRunner implements EngineRunner {
  launch(_params: LaunchParams): Promise<LaunchResult> {
    return Promise.reject(
      new Error('launch: engine integration lands Day 1 (patchright + camoufox-js)'),
    );
  }

  stop(_params: StopParams): Promise<void> {
    return Promise.reject(new Error('stop: not implemented until Day 1'));
  }

  status(_params: StatusParams): Promise<StatusResult> {
    return Promise.resolve({ running: [] });
  }
}
