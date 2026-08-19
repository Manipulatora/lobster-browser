/**
 * First-party CDP client over a raw DevTools WebSocket.
 *
 * This is the project's OWN Chrome DevTools Protocol client — no third-party automation fork
 * (Playwright/Puppeteer/patchright). It opens the DevTools WebSocket directly, correlates
 * `{id,method,params}` requests with responses, and closes cleanly. It deliberately issues only the
 * commands we need and NEVER calls `Runtime.enable` / `Page.enable` (whose domain-enabled state and
 * `executionContextCreated` events are a classic "automation controlled" tell). Used for:
 *   - cookie inject/export on a launched profile (`Network.*`),
 *   - the one-time host-GPU calibration probe (`Runtime.evaluate`),
 *   - graceful shutdown (`Browser.close`).
 *
 * Fingerprint spoofing is NOT done here — that is native in the Lobium engine (`--lobium-fp-config`).
 * CDP is only a thin control/measurement channel.
 */

/** Minimal CDP session: send a method, get its result. */
export interface CdpSession {
  /** `opts.timeoutMs` is honoured by transports that support a per-command deadline. */
  send(
    method: string,
    params?: Record<string, unknown>,
    opts?: { timeoutMs?: number },
  ): Promise<unknown>;
}

/**
 * Resolve a page-target WebSocket from a browser DevTools endpoint via `/json/list`, falling back to
 * the browser endpoint (fine for browser-scoped commands like `Network.*` / `Browser.close`).
 */
export async function resolveCdpTarget(wsUrl: string): Promise<string> {
  try {
    const u = new URL(wsUrl);
    const listUrl = `http://${u.hostname}:${u.port}/json/list`;
    // Bounded: this runs BEFORE the session timer below exists, so an endpoint that accepts the
    // connection and never answers would hang the caller with no deadline at all.
    const targets = (await fetch(listUrl, { signal: AbortSignal.timeout(5_000) }).then((r) =>
      r.json(),
    )) as Array<{
      type?: string;
      webSocketDebuggerUrl?: string;
    }>;
    const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
    if (page?.webSocketDebuggerUrl) return page.webSocketDebuggerUrl;
  } catch {
    /* browser endpoint is fine for browser-scoped commands */
  }
  return wsUrl;
}

/**
 * Open a first-party CDP session to the resolved page target, run `operation`, then close the socket.
 * Rejects on socket error or after `timeoutMs`.
 */
export async function withCdpSession<T>(
  wsUrl: string,
  operation: (session: CdpSession) => Promise<T>,
  opts: { timeoutMs?: number } = {},
): Promise<T> {
  const targetWs = await resolveCdpTarget(wsUrl);
  const timeoutMs = opts.timeoutMs ?? 15_000;
  return new Promise<T>((resolve, reject) => {
    const ws = new WebSocket(targetWs);
    let nextId = 1;
    const pending = new Map<
      number,
      { resolve: (v: unknown) => void; reject: (e: Error) => void }
    >();
    const send = (
      method: string,
      params?: Record<string, unknown>,
      sendOpts?: { timeoutMs?: number },
    ) =>
      new Promise<unknown>((res, rej) => {
        const id = nextId++;
        // A per-command deadline is what lets a caller bound ONE slow command (a probe evaluate, a
        // large cookie batch) without widening the whole session's deadline.
        const commandTimeoutMs = sendOpts?.timeoutMs;
        const commandTimer =
          commandTimeoutMs === undefined
            ? undefined
            : setTimeout(() => {
                pending.delete(id);
                rej(new Error(`CDP command ${method} timed out after ${commandTimeoutMs}ms`));
              }, commandTimeoutMs);
        commandTimer?.unref();
        pending.set(id, {
          resolve: (value) => {
            if (commandTimer) clearTimeout(commandTimer);
            res(value);
          },
          reject: (error) => {
            if (commandTimer) clearTimeout(commandTimer);
            rej(error);
          },
        });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          pending.delete(id);
          if (commandTimer) clearTimeout(commandTimer);
          rej(err instanceof Error ? err : new Error(String(err)));
        }
      });

    /** Fail every in-flight command at once: nothing can answer them after the socket is gone. */
    const rejectPending = (error: Error): void => {
      for (const p of [...pending.values()]) p.reject(error);
      pending.clear();
    };

    const timer = setTimeout(() => {
      ws.close();
      rejectPending(new Error('CDP operation timed out'));
      reject(new Error('CDP operation timed out'));
    }, timeoutMs);

    ws.addEventListener('open', () => {
      void (async () => {
        try {
          const result = await operation({ send });
          clearTimeout(timer);
          // Settle before closing: the close handler below reports an unfinished session, and it must
          // not win the race against the outcome this operation already produced.
          resolve(result);
          ws.close();
        } catch (err) {
          clearTimeout(timer);
          reject(err instanceof Error ? err : new Error(String(err)));
          ws.close();
        }
      })();
    });
    ws.addEventListener('message', (ev) => {
      try {
        const msg = JSON.parse(String(ev.data)) as {
          id?: number;
          result?: unknown;
          error?: { message?: string };
        };
        if (msg.id === undefined) return;
        const p = pending.get(msg.id);
        if (!p) return;
        pending.delete(msg.id);
        if (msg.error) p.reject(new Error(msg.error.message || 'CDP error'));
        else p.resolve(msg.result);
      } catch {
        /* ignore non-JSON events */
      }
    });
    ws.addEventListener('error', () => {
      clearTimeout(timer);
      rejectPending(new Error('CDP websocket error'));
      reject(new Error('CDP websocket error'));
    });
    // The browser closing the transport mid-operation is otherwise invisible: the commands it never
    // answered would sit pending until the coarse session timeout above expires.
    ws.addEventListener('close', () => {
      clearTimeout(timer);
      rejectPending(new Error('CDP websocket closed'));
      reject(new Error('CDP websocket closed'));
    });
  });
}

/**
 * Evaluate a JS expression string in the page's default world and return the value by value.
 * Uses `Runtime.evaluate` WITHOUT `Runtime.enable` (leak-free), awaits promises, and surfaces
 * uncaught exceptions. `expression` must be an expression that yields the value (wrap arrow functions
 * with a trailing call, e.g. `(async () => {...})()`).
 */
export async function cdpEvaluate<T>(
  session: CdpSession,
  expression: string,
  opts?: { timeoutMs?: number },
): Promise<T> {
  const res = (await session.send(
    'Runtime.evaluate',
    {
      expression,
      returnByValue: true,
      awaitPromise: true,
    },
    opts,
  )) as {
    result?: { value?: T };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
  };
  if (res.exceptionDetails) {
    const detail =
      res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'unknown error';
    throw new Error(`CDP Runtime.evaluate failed: ${detail}`);
  }
  return res.result?.value as T;
}
