import { resolveCdpTarget } from '../cdp-client.js';
import type { CdpSession } from '../cdp-client.js';

/**
 * A LONG-LIVED first-party CDP session for an agent run.
 *
 * `withCdpSession` closes the socket after one operation — right for cookie inject / calibration, wrong
 * for an agent that issues hundreds of commands across many steps. This keeps the DevTools WebSocket
 * open for the run's lifetime while preserving the exact stealth discipline: it NEVER calls
 * `Runtime.enable` / `Page.enable` (only one-shot `Runtime.evaluate`, `Input.*`, `Page.navigate`,
 * `Page.captureScreenshot` — all commands that need no domain-enable). Attaching an agent therefore
 * adds no automation tell to the session.
 */
export interface PersistentCdpSession extends CdpSession {
  /** Resolves if the socket closes out-of-band (tab/window closed, browser exit). */
  readonly closed: Promise<void>;
  close(): void;
}

export async function openPersistentCdpSession(
  wsUrl: string,
  opts: { commandTimeoutMs?: number; resolveTarget?: boolean } = {},
): Promise<PersistentCdpSession> {
  const targetWs = opts.resolveTarget === false ? wsUrl : await resolveCdpTarget(wsUrl);
  const commandTimeoutMs = opts.commandTimeoutMs ?? 30_000;
  const ws = new WebSocket(targetWs);

  let nextId = 1;
  const pending = new Map<
    number,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let closeResolve: () => void;
  const closed = new Promise<void>((r) => {
    closeResolve = r;
  });
  let isClosed = false;

  const rejectAll = (err: Error): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    pending.clear();
  };

  ws.addEventListener('message', (ev) => {
    let msg: { id?: number; result?: unknown; error?: { message?: string } };
    try {
      msg = JSON.parse(String((ev as MessageEvent).data));
    } catch {
      return;
    }
    if (msg.id === undefined) return; // events (we enable none, but ignore any that arrive)
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
    else p.resolve(msg.result);
  });
  ws.addEventListener('close', () => {
    if (!isClosed) {
      isClosed = true;
      rejectAll(new Error('CDP socket closed'));
      closeResolve();
    }
  });
  ws.addEventListener('error', () => {
    if (!isClosed) {
      isClosed = true;
      rejectAll(new Error('CDP socket error'));
      closeResolve();
    }
  });

  await new Promise<void>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('CDP connect timed out')), 15_000);
    ws.addEventListener('open', () => {
      clearTimeout(t);
      resolve();
    });
    ws.addEventListener('error', () => {
      clearTimeout(t);
      reject(new Error('CDP connect failed'));
    });
  });

  const send = (method: string, params?: Record<string, unknown>): Promise<unknown> => {
    if (isClosed) return Promise.reject(new Error('CDP session is closed'));
    return new Promise<unknown>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP ${method} timed out`));
      }, commandTimeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ id, method, params }));
    });
  };

  return {
    send,
    closed,
    close(): void {
      if (isClosed) return;
      isClosed = true;
      rejectAll(new Error('CDP session closed by caller'));
      closeResolve();
      try {
        ws.close();
      } catch {
        /* already closing */
      }
    },
  };
}

export interface CdpTarget {
  id: string;
  type: string;
  title: string;
  url: string;
  webSocketDebuggerUrl: string;
}

/** Query page targets without enabling CDP discovery domains. */
export async function listCdpTargets(wsUrl: string): Promise<CdpTarget[]> {
  const url = new URL(wsUrl);
  const response = await fetch(`http://${url.host}/json/list`, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) throw new Error(`CDP target list failed: HTTP ${response.status}`);
  const raw = (await response.json()) as Array<Partial<CdpTarget>>;
  return raw
    .filter(
      (target): target is CdpTarget =>
        target.type === 'page' &&
        typeof target.id === 'string' &&
        typeof target.webSocketDebuggerUrl === 'string',
    )
    .map((target) => ({
      id: target.id,
      type: 'page',
      title: target.title ?? '',
      url: target.url ?? '',
      webSocketDebuggerUrl: target.webSocketDebuggerUrl,
    }));
}
