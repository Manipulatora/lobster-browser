import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';

globalThis.window = {
  chrome: { runtime: { getURL: (path) => `chrome-extension://lobee/${path}` } },
};

const bridge = await import('./bridge.ts');
const encoder = new TextEncoder();

afterEach(() => {
  bridge.__resetBridgeForTests();
  delete globalThis.fetch;
});

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function eventsResponse(signal, frames = [], closeImmediately = false) {
  let controller;
  const body = new ReadableStream({
    start(value) {
      controller = value;
      value.enqueue(encoder.encode(': ready\n\n'));
      for (const frame of frames) value.enqueue(encoder.encode(frame));
      if (closeImmediately) value.close();
    },
  });
  signal?.addEventListener(
    'abort',
    () => {
      try {
        controller?.close();
      } catch {
        // already closed
      }
    },
    { once: true },
  );
  return new Response(body, { headers: { 'content-type': 'text/event-stream' } });
}

test('a missing bridge config is refreshable instead of cached forever', async () => {
  let reads = 0;
  globalThis.fetch = async (url) => {
    if (!String(url).startsWith('chrome-extension://')) throw new Error('unexpected request');
    reads += 1;
    return reads === 1
      ? json({}, 404)
      : json({ origin: 'http://127.0.0.1:40101', token: 'token-one', profileId: 'p1' });
  };

  assert.equal(await bridge.getBridge(), null);
  assert.deepEqual(await bridge.getBridge(true), {
    origin: 'http://127.0.0.1:40101',
    token: 'token-one',
    profileId: 'p1',
  });
});

test('events arriving before POST /run returns are correlated and delivered', async () => {
  const received = [];
  const started = {
    type: 'run.started',
    sessionId: 'session-1',
    profileId: 'p1',
    task: 'hello',
  };
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40102', token: 'token-two', profileId: 'p1' });
    }
    if (target.includes('/events?')) {
      return eventsResponse(
        init.signal,
        [`id: 1\ndata: ${JSON.stringify(started)}\n\n`],
        false,
      );
    }
    if (target.endsWith('/run')) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return json({ ok: true, sessionId: 'session-1' });
    }
    if (target.endsWith('/status')) return json({ runs: [] });
    throw new Error(`unexpected request: ${target}`);
  };

  const result = await bridge.runTask(
    'hello',
    { mode: 'ask', model: 'test/model' },
    { onEvent: (event) => received.push(event) },
  );
  assert.equal(result, 'started');
  assert.deepEqual(received, [started]);
});

test('event stream refreshes rotated bridge credentials and terminates the stale run truthfully', async () => {
  const received = [];
  let configReads = 0;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      configReads += 1;
      return json(
        configReads === 1
          ? { origin: 'http://127.0.0.1:40103', token: 'old-token', profileId: 'p1' }
          : { origin: 'http://127.0.0.1:40104', token: 'new-token', profileId: 'p1' },
      );
    }
    if (target.startsWith('http://127.0.0.1:40103/events?')) {
      return eventsResponse(init.signal, [], true);
    }
    if (target === 'http://127.0.0.1:40103/run') {
      return json({ ok: true, sessionId: 'session-old' });
    }
    if (target === 'http://127.0.0.1:40103/status') {
      return json({ runs: [{ sessionId: 'session-old', profileId: 'p1', status: 'running' }] });
    }
    if (target.startsWith('http://127.0.0.1:40104/events?')) {
      return eventsResponse(init.signal);
    }
    if (target === 'http://127.0.0.1:40104/status') return json({ runs: [] });
    throw new Error(`unexpected request: ${target}`);
  };

  assert.equal(
    await bridge.runTask(
      'keep working',
      { mode: 'agent', model: 'test/model' },
      { onEvent: (event) => received.push(event) },
    ),
    'started',
  );
  await new Promise((resolve) => setTimeout(resolve, 1_000));
  const terminal = received.find((event) => event.type === 'run.finished');
  assert.equal(terminal?.status, 'error');
  assert.match(terminal?.error ?? '', /service restarted/i);
  assert.ok(configReads >= 2);
});
