// Small, dependency-free guardrail for the battery's grading oracles.
//
// This file is also the compatibility CLI named by the Windows release runbook. Importing it exposes
// only `fetchOracleText`; executing it delegates to the real live battery entrypoint.
//
// An oracle is infrastructure, not the capability under test. A hung request, an HTTP error page,
// or an empty body must therefore produce an explicit BLOCKED attempt instead of silently turning
// into a false agent failure (or, worse, an accidentally permissive expectation).
import { pathToFileURL } from 'node:url';

const DEFAULT_TIMEOUT_MS = 15_000;
const DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`${label} must be a positive integer`);
  }
  return value;
}

async function readBoundedBody(response, maxBytes) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new Error(`oracle response exceeded ${maxBytes} bytes`);
  }

  if (!response.body?.getReader) {
    const text = await response.text();
    if (Buffer.byteLength(text, 'utf8') > maxBytes) {
      throw new Error(`oracle response exceeded ${maxBytes} bytes`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new Error(`oracle response exceeded ${maxBytes} bytes`);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

/**
 * Fetch one text oracle within a hard wall-clock and body-size bound.
 *
 * `fetchImpl` is injectable so ordinary CI can prove every failure mode without touching the
 * network. The timeout races the whole operation, including body consumption; aborting is only the
 * cleanup mechanism and is not trusted to make a non-cooperative implementation settle.
 */
export async function fetchOracleText(
  url,
  {
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    maxBytes = DEFAULT_MAX_BYTES,
  } = {},
) {
  if (typeof fetchImpl !== 'function') throw new TypeError('oracle fetch is unavailable');
  positiveInteger(timeoutMs, 'oracle timeoutMs');
  positiveInteger(maxBytes, 'oracle maxBytes');

  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new TypeError(`invalid oracle URL: ${String(url)}`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new TypeError(`unsupported oracle protocol: ${parsed.protocol}`);
  }

  const controller = new AbortController();
  let timedOut = false;
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
      reject(new Error(`oracle fetch timed out after ${timeoutMs}ms: ${parsed.href}`));
    }, timeoutMs);
  });

  const operation = (async () => {
    const response = await fetchImpl(parsed.href, {
      redirect: 'follow',
      signal: controller.signal,
      headers: { accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1' },
    });
    if (!response || typeof response.ok !== 'boolean') {
      throw new Error(`oracle fetch returned an invalid response: ${parsed.href}`);
    }
    if (!response.ok) {
      throw new Error(
        `oracle fetch returned HTTP ${response.status ?? 'unknown'} for ${parsed.href}`,
      );
    }
    const body = await readBoundedBody(response, maxBytes);
    if (!body.trim()) throw new Error(`oracle fetch returned an empty body: ${parsed.href}`);
    return body;
  })();

  try {
    return await Promise.race([operation, timeout]);
  } catch (error) {
    if (timedOut) throw new Error(`oracle fetch timed out after ${timeoutMs}ms: ${parsed.href}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

if (process.argv[1]) {
  if (pathToFileURL(process.argv[1]).href === import.meta.url) {
    // Do not await this import: agent-battery -> agent-battery-tasks -> this helper is an intentional
    // module cycle, and awaiting the battery while this module is still evaluating would deadlock it.
    void import('./agent-battery.mjs').catch((error) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 2;
    });
  }
}
