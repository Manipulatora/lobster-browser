export async function fetchWithRetry(
  url: string,
  init: RequestInit,
  opts: { signal?: AbortSignal; timeoutMs?: number; attempts?: number } = {},
): Promise<Response> {
  const attempts = opts.attempts ?? 3;
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    if (opts.signal?.aborted) throw opts.signal.reason ?? new Error('aborted');
    const controller = new AbortController();
    const onAbort = (): void => controller.abort(opts.signal?.reason);
    opts.signal?.addEventListener('abort', onAbort, { once: true });
    const timer = setTimeout(
      () => controller.abort(new Error('LLM request timed out')),
      opts.timeoutMs ?? 60_000,
    );
    try {
      const response = await fetch(url, { ...init, signal: controller.signal });
      if (!retryableStatus(response.status) || attempt === attempts) return response;
      const delay = retryDelay(response, attempt);
      await response.body?.cancel().catch(() => {});
      await wait(delay, opts.signal);
    } catch (error) {
      if (opts.signal?.aborted) throw opts.signal.reason ?? error;
      lastError = error;
      // A per-attempt timeout aborts this controller too. Retry it like any other transient
      // transport failure; only an abort from the caller should end the whole operation early.
      if (attempt === attempts) throw error;
      await wait(backoff(attempt), opts.signal);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener('abort', onAbort);
    }
  }
  throw lastError instanceof Error ? lastError : new Error('LLM request failed');
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryDelay(response: Response, attempt: number): number {
  const raw = response.headers.get('retry-after');
  if (raw) {
    const seconds = Number(raw);
    if (Number.isFinite(seconds)) return Math.min(30_000, Math.max(0, seconds * 1000));
    const date = Date.parse(raw);
    if (Number.isFinite(date)) return Math.min(30_000, Math.max(0, date - Date.now()));
  }
  return backoff(attempt);
}

function backoff(attempt: number): number {
  return Math.min(8_000, 400 * 2 ** (attempt - 1) + Math.floor(Math.random() * 250));
}

function wait(ms: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error('aborted'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(signal?.reason ?? new Error('aborted'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
