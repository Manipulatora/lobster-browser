import type {
  AgentLlmProvider,
  AgentAttachBrowserParams,
  AgentSendInputParams,
  AgentStartParams,
  AgentStatusParams,
  AgentStopParams,
  LaunchParams,
  SidecarRequest,
  SidecarResponse,
  StartProfileParams,
  StatusParams,
  StopParams,
} from '@lobster/shared-types';
import { provisionProfile } from './agent/bridge-registry.js';
import { listModels } from '@lobster/agent';
import type { EngineRunner } from './runner.js';
import type { AgentManager } from './agent/manager.js';
import { startProfile } from './start-profile.js';
import {
  androidProfileStatus,
  startAndroidProfile,
  stopAndroidProfile,
} from './start-android-profile.js';
import { startAndroidEmulatedProfile } from './start-android-emulated-profile.js';
import { ensureHostCalibration } from './ensure-host-calibration.js';

/** Extra dependencies dispatch may need beyond the engine runner (kept optional for tests). */
export interface DispatchDeps {
  agents?: AgentManager;
}

/** Dispatch one sidecar request to the runner and produce a response. Never throws. */
export async function dispatch(
  runner: EngineRunner,
  req: SidecarRequest,
  deps: DispatchDeps = {},
): Promise<SidecarResponse> {
  try {
    switch (req.method) {
      case 'ping':
        return { id: req.id, ok: true, result: { pong: true } };
      case 'startProfile': {
        const params = req.params as StartProfileParams;
        // Provision this profile's Lobee bridge with its encrypted-memory key, so a task started from
        // the in-browser side panel can run without a round-trip to the desktop core for the secret.
        if (typeof params.agentMemoryKey === 'string' && params.agentMemoryKey) {
          provisionProfile(params.profileId, { memoryKey: params.agentMemoryKey });
        }
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
      // Per-profile web agent. `agent.start` returns immediately (the run streams AgentEvent
      // notifications); the others are quick control calls. They require the manager to be wired.
      case 'agent.start': {
        const agents = requireAgents(deps);
        const result = await agents.start(
          requireObject(req.params, 'agent.start params') as unknown as AgentStartParams,
        );
        return { id: req.id, ok: true, result };
      }
      case 'agent.stop': {
        const agents = requireAgents(deps);
        const params = requireObject(req.params, 'agent.stop params') as unknown as AgentStopParams;
        const result = agents.stop(requireString(params.profileId, 'profileId'));
        return { id: req.id, ok: true, result };
      }
      case 'agent.attachBrowser': {
        // The desktop core launched (or failed to launch) the profile a waiting run asked for.
        const agents = requireAgents(deps);
        const params = requireObject(
          req.params,
          'agent.attachBrowser params',
        ) as unknown as AgentAttachBrowserParams;
        const result = await agents.attachBrowser(
          requireString(params.profileId, 'profileId'),
          params.error === undefined ? undefined : requireString(params.error, 'error', 4_000),
        );
        return { id: req.id, ok: true, result };
      }
      case 'agent.sendInput': {
        const agents = requireAgents(deps);
        const params = requireObject(
          req.params,
          'agent.sendInput params',
        ) as unknown as AgentSendInputParams;
        const result = agents.sendInput(
          requireString(params.profileId, 'profileId'),
          requireString(params.text, 'text', 20_000),
        );
        return { id: req.id, ok: true, result };
      }
      case 'agent.status': {
        const agents = requireAgents(deps);
        const raw =
          req.params === undefined ? {} : requireObject(req.params, 'agent.status params');
        const params = raw as unknown as AgentStatusParams;
        const result = agents.status(
          params.profileId === undefined ? undefined : requireString(params.profileId, 'profileId'),
        );
        return { id: req.id, ok: true, result };
      }
      case 'agent.listModels': {
        // Stateless: validate the BYOK key + list its usable chat models (no profile/session needed).
        const params = requireObject(req.params, 'agent.listModels params') as unknown as {
          provider: string;
          apiKey?: string;
        };
        const models = await listModels({
          provider: requireString(params.provider, 'provider') as AgentLlmProvider,
          apiKey: requireString(params.apiKey, 'apiKey'),
        });
        return { id: req.id, ok: true, result: { models } };
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

function requireObject(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string, max = 256): string {
  if (typeof value !== 'string' || !value || value.length > max) {
    throw new Error(`${name} must be a non-empty string of at most ${max} characters`);
  }
  return value;
}

function requireAgents(deps: DispatchDeps): AgentManager {
  if (!deps.agents) {
    throw new Error('agent methods are unavailable: no AgentManager wired into the sidecar');
  }
  return deps.agents;
}
