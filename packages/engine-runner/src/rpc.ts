import type {
  LaunchParams,
  SidecarRequest,
  SidecarResponse,
  StartProfileParams,
  StatusParams,
  StopParams,
} from '@lobster/shared-types';
import type { EngineRunner } from './runner.js';
import { startProfile } from './start-profile.js';

/** Dispatch one sidecar request to the runner and produce a response. Never throws. */
export async function dispatch(
  runner: EngineRunner,
  req: SidecarRequest,
): Promise<SidecarResponse> {
  try {
    switch (req.method) {
      case 'ping':
        return { id: req.id, ok: true, result: { pong: true } };
      case 'startProfile':
        return {
          id: req.id,
          ok: true,
          result: await startProfile(runner, req.params as StartProfileParams),
        };
      case 'launch':
        return { id: req.id, ok: true, result: await runner.launch(req.params as LaunchParams) };
      case 'stop':
        await runner.stop(req.params as StopParams);
        return { id: req.id, ok: true };
      case 'status':
        return { id: req.id, ok: true, result: await runner.status(req.params as StatusParams) };
      default:
        return {
          id: req.id,
          ok: false,
          error: { code: 'unknown_method', message: `Unknown method: ${String(req.method)}` },
        };
    }
  } catch (e) {
    return {
      id: req.id,
      ok: false,
      error: { code: 'internal', message: e instanceof Error ? e.message : String(e) },
    };
  }
}
