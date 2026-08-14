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
  /** Pause before every mutating action (`confirm`) or only at unconditional safety gates (`auto`). */
  autonomy?: 'auto' | 'confirm';
  /** Registrable-domain fence for this run. Empty means no explicit domain fence. */
  allowedDomains?: string[];
  /** Combined input/output token ceiling. `null` explicitly requests no ceiling. */
  tokenBudget?: number | null;
}
export interface RunHandlers {
  onEvent: (e: AgentEvent) => void;
}

interface ActiveRun {
  handlers: RunHandlers;
  sessionId: string | null;
  early: AgentEvent[];
  pendingStart?: { task: string; threadId?: string; attemptedAt: number };
  startRecovery?: AbortController;
}

let bridgeCfg: BridgeConfig | null | undefined;
/** Last valid identity survives a transient missing/unreadable bridge.json during sidecar rotation. */
let lastKnownBridge: BridgeConfig | null = null;
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
const STATUS_REQUEST_TIMEOUT_MS = 5_000;
const START_RECOVERY_ATTEMPTS = 10;
const START_RECOVERY_INTERVAL_MS = 1_000;
const START_RECOVERY_REQUEST_TIMEOUT_MS = 1_500;

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

  const previous = lastKnownBridge;
  bridgeCfg = next;
  bridgeCfgLoadedAt = Date.now();
  if (next) {
    lastKnownBridge = next;
    if (previous && bridgeKey(previous) !== bridgeKey(next)) {
      lastEventId = 0;
      streamBridgeKey = '';
      const run = active;
      if (run) {
        deliver(run, {
          type: 'run.finished',
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          profileId: previous.profileId,
          status: 'error',
          error:
            'The local agent service restarted before this run finished. Your message is safe to retry.',
        });
      }
    }
  }
  return next;
}

async function bridgeFetch(
  path: string,
  init?: RequestInit,
  retried = false,
  replaySafe = false,
  expectedBridgeIdentity?: string,
): Promise<Response> {
  const b = await getBridge(retried);
  if (!b?.origin || !b?.token) throw new Error('bridge not configured for this profile');
  const identity = bridgeKey(b);
  if (expectedBridgeIdentity && identity !== expectedBridgeIdentity) {
    throw new Error('the local agent service identity changed');
  }
  const retryIdentity = replaySafe ? (expectedBridgeIdentity ?? identity) : undefined;
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
    if (!retried && (method === 'GET' || replaySafe) && response.status === 401) {
      return bridgeFetch(path, init, true, replaySafe, retryIdentity);
    }
    return response;
  } catch (error) {
    const method = (init?.method ?? 'GET').toUpperCase();
    // GETs and mutations carrying a server-deduplicated request ID are safe to retry once after
    // re-reading bridge.json. Other POSTs may have reached the sidecar and must never be replayed.
    if (!retried && (method === 'GET' || replaySafe)) {
      return bridgeFetch(path, init, true, replaySafe, retryIdentity);
    }
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

export async function fetchStatus(
  timeoutMs = STATUS_REQUEST_TIMEOUT_MS,
): Promise<AgentRunSnapshot[] | null> {
  try {
    const res = await bridgeFetch('/status', { signal: AbortSignal.timeout(timeoutMs) });
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
  if (event.type === 'run.finished') {
    run.startRecovery?.abort();
    active = null;
  }
}

function dispatch(event: AgentEvent): void {
  const run = active;
  const bridge = bridgeCfg;
  if (!run || (event.profileId && bridge?.profileId && event.profileId !== bridge.profileId))
    return;
  if (!run.sessionId) {
    run.early.push(event);
    if (run.early.length > EARLY_EVENT_LIMIT) run.early.shift();
    if (run.pendingStart && event.type === 'run.started') void reconcileActive();
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
      const query = new URLSearchParams({ since: String(lastEventId) });
      const res = await fetch(`${b.origin}/events?${query}`, {
        signal,
        headers: { 'x-lobee-token': b.token },
      });
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
      // Re-read bridge.json after ANY stream end, not only after a throw. A sidecar restart closes the
      // SSE response cleanly, so the read loop simply finishes and no exception is raised — leaving the
      // cached credentials in place, the rotation undetected, and the in-flight run hanging forever
      // with no terminal event. Reconnecting is exactly when the config is most likely to have changed.
      refreshConfig = true;
    }
    await retryDelay(signal);
  }
}

async function reconcileActive(timeoutMs = STATUS_REQUEST_TIMEOUT_MS): Promise<void> {
  const run = active;
  if (!run) return;
  const snapshots = await fetchStatus(timeoutMs);
  if (active !== run || !snapshots) return;
  if (!run.sessionId) {
    const pending = run.pendingStart;
    if (!pending) return;
    const snapshot = snapshots.find((item) => {
      const startedAt = Date.parse(item.startedAt);
      return (
        item.task === pending.task &&
        (item.threadId ?? '') === (pending.threadId ?? '') &&
        Number.isFinite(startedAt) &&
        startedAt >= pending.attemptedAt - 5_000
      );
    });
    if (!snapshot) return;
    await acceptRunSession(run, snapshot.sessionId, false);
    if (active === run) deliverSnapshot(run, snapshot);
    return;
  }
  const snapshot = snapshots.find((item) => item.sessionId === run.sessionId);
  if (!snapshot) return;
  deliverSnapshot(run, snapshot);
}

function deliverSnapshot(run: ActiveRun, snapshot: AgentRunSnapshot): void {
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

async function acceptRunSession(
  run: ActiveRun,
  sessionId: string,
  reconcile = true,
): Promise<void> {
  if (active !== run) return;
  run.sessionId = sessionId;
  run.pendingStart = undefined;
  run.startRecovery?.abort();
  run.startRecovery = undefined;
  for (const event of run.early.splice(0)) {
    if (active !== run) return;
    if (event.sessionId === sessionId) deliver(run, event);
  }
  if (reconcile && active === run) await reconcileActive();
}

async function recoverPendingStart(
  run: ActiveRun,
  body: string,
  bridgeIdentity: string,
  signal: AbortSignal,
): Promise<void> {
  try {
    for (let attempt = 0; attempt < START_RECOVERY_ATTEMPTS; attempt += 1) {
      if (attempt > 0) await recoveryDelay(signal, START_RECOVERY_INTERVAL_MS);
      if (signal.aborted || active !== run || run.sessionId) return;
      await reconcileActive(START_RECOVERY_REQUEST_TIMEOUT_MS);
      if (signal.aborted || active !== run || run.sessionId) return;

      const requestController = new AbortController();
      const timeout = setTimeout(
        () => requestController.abort(),
        START_RECOVERY_REQUEST_TIMEOUT_MS,
      );
      const abortRequest = (): void => requestController.abort();
      signal.addEventListener('abort', abortRequest, { once: true });
      try {
        const res = await bridgeFetch(
          '/run',
          { method: 'POST', body, signal: requestController.signal },
          true,
          true,
          bridgeIdentity,
        );
        const data = (await res.json().catch(() => ({}))) as {
          ok?: boolean;
          error?: string;
          sessionId?: string;
        };
        if (res.ok && data.ok !== false && data.sessionId) {
          await acceptRunSession(run, data.sessionId);
          return;
        }
        if (!res.ok || data.ok === false) {
          finishUnconfirmedStart(run, data.error || `The run could not start (${res.status}).`);
          return;
        }
      } catch {
        // The same request ID makes another bounded retry safe; status is checked before each one.
      } finally {
        clearTimeout(timeout);
        signal.removeEventListener('abort', abortRequest);
      }
    }
    await reconcileActive(START_RECOVERY_REQUEST_TIMEOUT_MS);
    if (active === run && !run.sessionId) finishUnconfirmedStart(run);
  } catch {
    if (!signal.aborted && active === run && !run.sessionId) finishUnconfirmedStart(run);
  } finally {
    if (run.startRecovery?.signal === signal) run.startRecovery = undefined;
  }
}

function finishUnconfirmedStart(
  run: ActiveRun,
  error = 'The local agent service did not confirm whether this run started. Check agent status before retrying.',
): void {
  if (active !== run) return;
  deliver(run, {
    type: 'run.finished',
    ...(run.sessionId ? { sessionId: run.sessionId } : {}),
    ...(lastKnownBridge ? { profileId: lastKnownBridge.profileId } : {}),
    status: 'error',
    error,
  });
}

async function recoveryDelay(signal: AbortSignal, delayMs: number): Promise<void> {
  if (signal.aborted) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(done, delayMs);
    const onAbort = (): void => done();
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener('abort', onAbort);
      resolve();
    }
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Reattach a newly-mounted panel to the latest run retained by the sidecar. */
export async function resumeTask(sessionId: string, handlers: RunHandlers): Promise<boolean> {
  const b = await getBridge();
  if (!b) return false;
  const run: ActiveRun = { handlers, sessionId, early: [] };
  active?.startRecovery?.abort();
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
  active?.startRecovery?.abort();
  active = run;
  let startBody: string | undefined;
  let startBridgeIdentity = bridgeKey(b);
  try {
    await ensureEventStream();
    const requestId = createRequestId();
    const body = JSON.stringify({
      requestId,
      task,
      mode: cfg.mode,
      model: cfg.model,
      effort: cfg.effort,
      threadId: cfg.threadId,
      autonomy: cfg.autonomy,
      allowedDomains: cfg.allowedDomains,
      tokenBudget: cfg.tokenBudget,
    });
    startBody = body;
    run.pendingStart = {
      task: task.trim(),
      ...(cfg.threadId ? { threadId: cfg.threadId } : {}),
      attemptedAt: Date.now(),
    };
    const requestBridge = await getBridge();
    if (!requestBridge) throw new Error('bridge not configured for this profile');
    if (active !== run) return 'failed';
    const requestBridgeIdentity = bridgeKey(requestBridge);
    startBridgeIdentity = requestBridgeIdentity;
    const request = async (forceRefresh: boolean) => {
      const res = await bridgeFetch(
        '/run',
        { method: 'POST', body },
        forceRefresh,
        true,
        requestBridgeIdentity,
      );
      const data = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        sessionId?: string;
      };
      return { res, data };
    };
    let { res, data } = await request(false);
    // A successful response with an unreadable/missing body can also be response loss. Reconcile it
    // through the same idempotency key before reporting a startup failure.
    if (res.ok && data.ok !== false && !data.sessionId) {
      ({ res, data } = await request(true));
    }
    const typedData = data as {
      ok?: boolean;
      error?: string;
      sessionId?: string;
    };
    if (!res.ok || typedData.ok === false) {
      if (active === run) {
        handlers.onEvent({
          type: 'run.finished',
          status: 'error',
          error: typedData.error || `The run could not start (${res.status}).`,
        });
        active = null;
      }
      return 'failed';
    }
    if (!typedData.sessionId) throw new Error('the agent service returned no session id');
    await acceptRunSession(run, typedData.sessionId);
  } catch (e) {
    if (active === run && run.sessionId) return 'started';
    if (active === run && run.pendingStart) {
      // Both attempts may have reached the sidecar even when neither HTTP response made it back. Keep
      // the run attached and let status/SSE reconcile its session instead of reporting a false failure
      // and inviting a duplicate click. A real bridge rotation terminates this provisional run above.
      await reconcileActive(START_RECOVERY_REQUEST_TIMEOUT_MS);
      if (active === run && !run.sessionId && startBody && startBridgeIdentity) {
        const controller = new AbortController();
        run.startRecovery = controller;
        void recoverPendingStart(run, startBody, startBridgeIdentity, controller.signal);
      }
      return 'started';
    }
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
  const run = active;
  if (!run?.sessionId) throw new Error('The agent is no longer waiting for that input.');
  const body = JSON.stringify({
    requestId: createRequestId(),
    sessionId: run.sessionId,
    text,
  });
  try {
    const requestBridge = await getBridge();
    if (!requestBridge) throw new Error('bridge not configured for this profile');
    const res = await bridgeFetch(
      '/input',
      { method: 'POST', body },
      false,
      true,
      bridgeKey(requestBridge),
    );
    const data = (await res.json().catch(() => ({}))) as {
      ok?: boolean;
      delivered?: boolean;
      error?: string;
    };
    if (!res.ok || data.ok === false || data.delivered !== true) {
      throw new Error(data.error || 'The agent is no longer waiting for that input.');
    }
  } catch (error) {
    // The reply may have been lost after the sidecar consumed the input. Re-read authoritative run
    // state before leaving a stale approval in the panel or asking the user to submit it twice.
    const snapshots = await fetchStatus();
    if (active !== run) return;
    const snapshot = snapshots?.find((item) => item.sessionId === run.sessionId);
    if (snapshot) {
      deliverSnapshot(run, snapshot);
      if (snapshot.status !== 'awaiting_input') return;
    }
    throw new Error(friendly(error instanceof Error ? error.message : error));
  }
}

export function stopRun(): void {
  void bridgeFetch('/stop', { method: 'POST', body: '{}' }).catch(() => {});
}

function bridgeKey(config: BridgeConfig): string {
  return `${config.origin}\u0000${config.token}\u0000${config.profileId}`;
}

function createRequestId(): string {
  // Chromium's Web Crypto UUID is 122 bits of randomness and never depends on page/model input.
  return globalThis.crypto.randomUUID();
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
  active?.startRecovery?.abort();
  sseAbort?.abort();
  sseAbort = null;
  bridgeCfg = undefined;
  lastKnownBridge = null;
  bridgeCfgLoadedAt = 0;
  bridgeLoad = null;
  active = null;
  streamConnected = false;
  lastEventId = 0;
  streamBridgeKey = '';
  resolveStreamWaiters();
}

/**
 * Re-read one conversation from the profile's ENCRYPTED memory.
 *
 * Encrypted memory is the authoritative source. The panel normally stores only correlation metadata, but
 * may retain a bounded, heuristically redacted plaintext availability/migration fallback until an exact
 * encrypted counterpart is verified. Failures are discriminated from a valid empty thread so callers do
 * not retire that fallback after a transient or authentication error.
 */
export interface EncryptedThreadMessage {
  role: string;
  content: string;
  status?: string;
  ts?: string;
  turnId?: string;
}

export type FetchThreadResult =
  { ok: true; messages: EncryptedThreadMessage[] } | { ok: false; error: string };

export async function fetchThread(threadId: string): Promise<FetchThreadResult> {
  if (!threadId) return { ok: false, error: 'invalid conversation id' };
  try {
    const res = await bridgeFetch(`/thread?id=${encodeURIComponent(threadId)}`);
    const body = (await res.json()) as {
      ok?: boolean;
      error?: string;
      messages?: Array<{
        role?: string;
        content?: string;
        status?: string;
        ts?: string;
        turnId?: string;
      }>;
    };
    if (!res.ok || body.ok !== true || !Array.isArray(body.messages)) {
      return {
        ok: false,
        error: body.error || `Encrypted conversation could not be loaded (${res.status}).`,
      };
    }
    return {
      ok: true,
      messages: body.messages.map((m) => ({
        role: String(m.role ?? ''),
        content: String(m.content ?? ''),
        ...(m.status ? { status: String(m.status) } : {}),
        ...(m.ts ? { ts: String(m.ts) } : {}),
        ...(m.turnId ? { turnId: String(m.turnId) } : {}),
      })),
    };
  } catch (error) {
    return { ok: false, error: friendly(error instanceof Error ? error.message : error) };
  }
}
