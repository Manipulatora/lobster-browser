// The panel talks DIRECTLY to the sidecar's loopback agent bridge (the manifest allows
// `connect-src http://127.0.0.1:*`). No ephemeral service-worker relay to be recycled mid-run. A run
// reconnects with replay rather than guessing that a slow model has failed.
import type { AgentEvent, AgentRunSnapshot } from './types';

export interface BridgeConfig {
  origin: string;
  token: string;
  profileId: string;
}
export interface RunConfig {
  mode: string;
  model: string;
  effort?: string;
  /** Conversation this message belongs to; the sidecar resolves prior turns from it. */
  threadId?: string;
}
export interface RunHandlers {
  onEvent: (e: AgentEvent) => void;
}

interface ActiveRun {
  handlers: RunHandlers;
  sessionId: string | null;
  early: AgentEvent[];
}

let bridgeCfg: BridgeConfig | null | undefined;
let bridgeCfgLoadedAt = 0;
let bridgeLoad: Promise<BridgeConfig | null> | null = null;
let sseAbort: AbortController | null = null;
let active: ActiveRun | null = null;
let streamConnected = false;
let lastEventId = 0;
let streamBridgeKey = '';
const streamWaiters = new Set<() => void>();
const STREAM_CONNECT_TIMEOUT_MS = 10_000;
const EARLY_EVENT_LIMIT = 256;
const CONFIG_CACHE_MS = 30_000;
const MISSING_CONFIG_CACHE_MS = 1_000;
const STREAM_RETRY_MS = 800;

export async function getBridge(forceRefresh = false): Promise<BridgeConfig | null> {
  const ttl = bridgeCfg ? CONFIG_CACHE_MS : MISSING_CONFIG_CACHE_MS;
  if (!forceRefresh && bridgeCfg !== undefined && Date.now() - bridgeCfgLoadedAt < ttl) {
    return bridgeCfg;
  }
  if (bridgeLoad) return bridgeLoad;
  bridgeLoad = readBridgeConfig().finally(() => {
    bridgeLoad = null;
  });
  return bridgeLoad;
}

async function readBridgeConfig(): Promise<BridgeConfig | null> {
  let next: BridgeConfig | null = null;
  try {
    const getURL = window.chrome?.runtime?.getURL;
    if (getURL) {
      const res = await fetch(getURL('bridge.json'), { cache: 'no-store' });
      const value: unknown = res.ok ? await res.json() : null;
      next = validBridge(value) ? value : null;
    }
  } catch {
    next = null;
  }

  const previous = bridgeCfg;
  bridgeCfg = next;
  bridgeCfgLoadedAt = Date.now();
  if (previous && next && bridgeKey(previous) !== bridgeKey(next)) {
    lastEventId = 0;
    streamBridgeKey = '';
    const run = active;
    if (run?.sessionId) {
      deliver(run, {
        type: 'run.finished',
        sessionId: run.sessionId,
        profileId: previous.profileId,
        status: 'error',
        error:
          'The local agent service restarted before this run finished. Your message is safe to retry.',
      });
    }
  }
  return next;
}

async function bridgeFetch(path: string, init?: RequestInit, retried = false): Promise<Response> {
  const b = await getBridge(retried);
  if (!b?.origin || !b?.token) throw new Error('bridge not configured for this profile');
  try {
    const response = await fetch(b.origin + path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        'x-lobee-token': b.token,
        ...(init?.headers ?? {}),
      },
    });
    const method = (init?.method ?? 'GET').toUpperCase();
    if (!retried && method === 'GET' && response.status === 401) {
      return bridgeFetch(path, init, true);
    }
    return response;
  } catch (error) {
    const method = (init?.method ?? 'GET').toUpperCase();
    // GETs are safe to retry once after re-reading bridge.json. Never replay POST /run: the first
    // request may have reached the sidecar even if its response was lost.
    if (!retried && method === 'GET') return bridgeFetch(path, init, true);
    throw error;
  }
}

export async function fetchModels(): Promise<{ models?: unknown[] } | null> {
  try {
    const res = await bridgeFetch('/models');
    return res.ok ? ((await res.json()) as { models?: unknown[] }) : null;
  } catch {
    return null;
  }
}

export async function fetchStatus(): Promise<AgentRunSnapshot[] | null> {
  try {
    const res = await bridgeFetch('/status');
    if (!res.ok) return null;
    const data = (await res.json()) as { runs?: AgentRunSnapshot[] };
    return Array.isArray(data.runs) ? data.runs : [];
  } catch {
    return null;
  }
}

function deliver(run: ActiveRun, event: AgentEvent): void {
  if (active !== run) return;
  run.handlers.onEvent(event);
  if (event.type === 'run.finished') active = null;
}

function dispatch(event: AgentEvent): void {
  const run = active;
  const bridge = bridgeCfg;
  if (!run || (event.profileId && bridge?.profileId && event.profileId !== bridge.profileId))
    return;
  if (!run.sessionId) {
    run.early.push(event);
    if (run.early.length > EARLY_EVENT_LIMIT) run.early.shift();
    return;
  }
  if (event.sessionId !== run.sessionId) return;
  deliver(run, event);
}

function resolveStreamWaiters(): void {
  for (const resolve of streamWaiters) resolve();
  streamWaiters.clear();
}

async function ensureEventStream(): Promise<void> {
  const b = await getBridge();
  if (!b?.origin || !b?.token) throw new Error('bridge not configured for this profile');
  if (!sseAbort) {
    const controller = new AbortController();
    sseAbort = controller;
    void streamEvents(controller.signal).finally(() => {
      if (sseAbort === controller) sseAbort = null;
    });
  }
  if (streamConnected) return;
  await new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout>;
    const ready = (): void => {
      clearTimeout(timer);
      streamWaiters.delete(ready);
      resolve();
    };
    timer = setTimeout(() => {
      streamWaiters.delete(ready);
      reject(new Error('timed out connecting to the agent event stream'));
    }, STREAM_CONNECT_TIMEOUT_MS);
    streamWaiters.add(ready);
    if (streamConnected) ready();
  });
}

async function streamEvents(signal: AbortSignal): Promise<void> {
  let refreshConfig = false;
  while (!signal.aborted) {
    try {
      const b = await getBridge(refreshConfig);
      refreshConfig = false;
      if (!b) throw new Error('bridge not configured');
      const key = bridgeKey(b);
      if (streamBridgeKey && streamBridgeKey !== key) lastEventId = 0;
      streamBridgeKey = key;
      const query = new URLSearchParams({ token: b.token, since: String(lastEventId) });
      const res = await fetch(`${b.origin}/events?${query}`, { signal });
      if (!res.ok || !res.body) throw new Error('events ' + res.status);
      streamConnected = true;
      resolveStreamWaiters();
      void reconcileActive();
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      let buf = '';
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        if (buf.length > 1_000_000) throw new Error('agent event frame exceeded its limit');
        let i: number;
        while ((i = buf.indexOf('\n\n')) >= 0) {
          const chunk = buf.slice(0, i);
          buf = buf.slice(i + 2);
          const lines = chunk.split('\n');
          const data = lines
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trimStart())
            .join('\n');
          if (!data) continue;
          try {
            const idLine = lines.find((line) => line.startsWith('id:'));
            const id = idLine ? Number(idLine.slice(3).trim()) : 0;
            if (id && (!Number.isSafeInteger(id) || id <= lastEventId)) continue;
            const event = JSON.parse(data) as AgentEvent;
            if (id) lastEventId = id;
            dispatch(event);
          } catch {
            /* ignore malformed frame */
          }
        }
      }
    } catch {
      if (signal.aborted) break;
      refreshConfig = true;
    } finally {
      streamConnected = false;
    }
    await retryDelay(signal);
  }
}

async function reconcileActive(): Promise<void> {
  const run = active;
  if (!run?.sessionId) return;
  const snapshots = await fetchStatus();
  if (active !== run || !snapshots) return;
  const snapshot = snapshots.find((item) => item.sessionId === run.sessionId);
  if (!snapshot) return;
  if (snapshot.status === 'awaiting_input' && snapshot.awaitingPrompt) {
    deliver(run, {
      type: 'run.needsInput',
      sessionId: snapshot.sessionId,
      profileId: snapshot.profileId,
      prompt: snapshot.awaitingPrompt,
      kind: snapshot.awaitingKind ?? 'ask',
      sensitive: snapshot.awaitingSensitive === true,
    });
  } else if (
    snapshot.status === 'done' ||
    snapshot.status === 'error' ||
    snapshot.status === 'stopped'
  ) {
    deliver(run, {
      type: 'run.finished',
      sessionId: snapshot.sessionId,
      profileId: snapshot.profileId,
      status: snapshot.status,
      ...(snapshot.result ? { result: snapshot.result } : {}),
      ...(snapshot.error ? { error: snapshot.error } : {}),
    });
  }
}

/** Reattach a newly-mounted panel to the latest run retained by the sidecar. */
export async function resumeTask(sessionId: string, handlers: RunHandlers): Promise<boolean> {
  const b = await getBridge();
  if (!b) return false;
  const run: ActiveRun = { handlers, sessionId, early: [] };
  active = run;
  try {
    await ensureEventStream();
    await reconcileActive();
  } catch {
    // The persistent stream loop keeps reconnecting. Never turn a transport delay into a fake run error.
  }
  return true;
}

function friendly(raw: unknown): string {
  const s = String(raw);
  return /failed to fetch|networkerror|load failed|refused/i.test(s)
    ? 'Can’t reach the Lobster agent service — make sure the app is running, then try again.'
    : s;
}

export type RunStartResult = 'started' | 'unavailable' | 'failed';

/** Start a run and distinguish a real startup failure from standalone demo mode. */
export async function runTask(
  task: string,
  cfg: RunConfig,
  handlers: RunHandlers,
): Promise<RunStartResult> {
  const b = await getBridge();
  if (!b) return 'unavailable';
  const run: ActiveRun = { handlers, sessionId: null, early: [] };
  active = run;
  try {
    await ensureEventStream();
    const res = await bridgeFetch('/run', {
      method: 'POST',
      body: JSON.stringify({
        task,
        mode: cfg.mode,
        model: cfg.model,
        effort: cfg.effort,
        threadId: cfg.threadId,
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      error?: string;
      sessionId?: string;
    };
    if (!res.ok || data.ok === false) {
      if (active === run) {
        handlers.onEvent({
          type: 'run.finished',
          status: 'error',
          error: data.error || `The run could not start (${res.status}).`,
        });
        active = null;
      }
      return 'failed';
    }
    if (!data.sessionId) throw new Error('the agent service returned no session id');
    run.sessionId = data.sessionId;
    for (const event of run.early.splice(0)) {
      if (active !== run) break;
      if (event.sessionId === run.sessionId) deliver(run, event);
    }
    if (active === run) await reconcileActive();
  } catch (e) {
    if (active === run) {
      handlers.onEvent({
        type: 'run.finished',
        status: 'error',
        error: friendly(e instanceof Error ? e.message : e),
      });
      active = null;
    }
  }
  return active === run || run.sessionId ? 'started' : 'failed';
}

export async function sendInput(text: string): Promise<void> {
  try {
    const res = await bridgeFetch('/input', { method: 'POST', body: JSON.stringify({ text }) });
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      delivered?: boolean;
      error?: string;
    };
    if (!res.ok || data.ok === false || data.delivered !== true) {
      throw new Error(data.error || 'The agent is no longer waiting for that input.');
    }
  } catch (error) {
    throw new Error(friendly(error instanceof Error ? error.message : error));
  }
}

export function stopRun(): void {
  void bridgeFetch('/stop', { method: 'POST', body: '{}' }).catch(() => {});
}

function bridgeKey(config: BridgeConfig): string {
  return `${config.origin}\u0000${config.token}\u0000${config.profileId}`;
}

function validBridge(value: unknown): value is BridgeConfig {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<BridgeConfig>;
  if (
    typeof candidate.origin !== 'string' ||
    typeof candidate.token !== 'string' ||
    !candidate.token ||
    candidate.token.length > 512 ||
    typeof candidate.profileId !== 'string' ||
    !/^[a-zA-Z0-9_-]{1,128}$/.test(candidate.profileId)
  ) {
    return false;
  }
  try {
    const url = new URL(candidate.origin);
    const port = Number(url.port);
    return (
      url.protocol === 'http:' &&
      url.hostname === '127.0.0.1' &&
      url.pathname === '/' &&
      !url.username &&
      !url.password &&
      Number.isSafeInteger(port) &&
      port >= 1 &&
      port <= 65_535
    );
  } catch {
    return false;
  }
}

async function retryDelay(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, STREAM_RETRY_MS);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Test-only lifecycle reset; production panels naturally discard this module when their page closes. */
export function __resetBridgeForTests(): void {
  sseAbort?.abort();
  sseAbort = null;
  bridgeCfg = undefined;
  bridgeCfgLoadedAt = 0;
  bridgeLoad = null;
  active = null;
  streamConnected = false;
  lastEventId = 0;
  streamBridgeKey = '';
  resolveStreamWaiters();
}
