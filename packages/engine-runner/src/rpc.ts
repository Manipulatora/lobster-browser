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
import {
  androidProfileStatus,
  startAndroidProfile,
  stopAndroidProfile,
} from './start-android-profile.js';
import { startAndroidEmulatedProfile } from './start-android-emulated-profile.js';
import { ensureHostCalibration } from './ensure-host-calibration.js';

/** Dispatch one sidecar request to the runner and produce a response. Never throws. */
export async function dispatch(
  runner: EngineRunner,
  req: SidecarRequest,
): Promise<SidecarResponse> {
  try {
    switch (req.method) {
      case 'ping':
        return { id: req.id, ok: true, result: { pong: true } };
      case 'startProfile': {
        const params = req.params as StartProfileParams;
        if (params.os === 'android') {
          // Default: emulated native mobile Chrome (real window, no hardware). 'adb' opts into the
          // real-device/APK runner instead.
          const result =
            params.androidTransport === 'adb'
              ? await startAndroidProfile(params)
              : await startAndroidEmulatedProfile(runner, params);
          return { id: req.id, ok: true, result };
        }
        return {
          id: req.id,
          ok: true,
          result: await startProfile(runner, params),
        };
      }
      case 'launch':
        return { id: req.id, ok: true, result: await runner.launch(req.params as LaunchParams) };
      case 'stop': {
        const params = req.params as StopParams;
        if (await stopAndroidProfile(params.profileId)) return { id: req.id, ok: true };
        await runner.stop(req.params as StopParams);
        return { id: req.id, ok: true };
      }
      case 'status': {
        const params = req.params as StatusParams;
        const desktop = await runner.status(params);
        const android = androidProfileStatus(params.profileId).map((result) => ({
          profileId: result.profileId,
          pid: result.pid,
          ws: result.ws,
          debuggerAddress: result.debuggerAddress,
        }));
        return {
          id: req.id,
          ok: true,
          result: { ...desktop, running: [...desktop.running, ...android] },
        };
      }
      case 'exportCookies': {
        const params = req.params as { profileId: string };
        return { id: req.id, ok: true, result: await runner.exportCookies(params.profileId) };
      }
      case 'ensureHostCalibration': {
        // Persistence + load path. Live GPU probe is supplied by the desktop/CI harness when
        // available; without a probe this returns source=missing and startProfile falls back
        // to the catalog (safe for headless CI).
        const result = await ensureHostCalibration(
          (req.params as { path?: string } | undefined) ?? {},
        );
        return { id: req.id, ok: true, result };
      }
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
