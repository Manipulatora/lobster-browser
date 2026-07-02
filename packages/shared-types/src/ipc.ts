import type { EngineKind } from './engine.js';
import type { Fingerprint } from './fingerprint.js';
import type { ProxyConfig } from './proxy.js';

/**
 * The stable local IPC contract between the Rust desktop core (control plane) and the
 * Node engine-runner sidecar. Newline-delimited JSON over stdio. The Rust side owns
 * privilege/auth; the sidecar only launches and controls engines.
 *
 * See docs/contracts/sidecar-ipc.md for the full spec.
 */

export type SidecarMethod = 'launch' | 'stop' | 'status' | 'ping';

export interface SidecarRequest<M extends SidecarMethod = SidecarMethod, P = unknown> {
  /** Correlation id echoed back in the response. */
  id: string;
  method: M;
  params: P;
}

export interface SidecarResponse<R = unknown> {
  id: string;
  ok: boolean;
  result?: R;
  error?: { code: string; message: string };
}

export interface LaunchParams {
  profileId: string;
  engine: EngineKind;
  /** Absolute path to the per-profile persistent user-data-dir. */
  userDataDir: string;
  /** Fully-resolved coherent fingerprint (deep surfaces handled natively by the engine). */
  fingerprint: Fingerprint;
  proxy?: ProxyConfig;
  headless?: boolean;
}

export interface LaunchResult {
  profileId: string;
  pid: number;
  /** CDP websocket URL for connectOverCDP. */
  ws: string;
  /** host:port for Selenium debuggerAddress. */
  debuggerAddress: string;
}

export interface StopParams {
  profileId: string;
}

export interface StatusParams {
  profileId?: string;
}

export interface StatusResult {
  running: Array<{ profileId: string; pid: number; ws: string; debuggerAddress: string }>;
}
