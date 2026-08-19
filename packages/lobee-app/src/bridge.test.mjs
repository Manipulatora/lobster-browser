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
      assert.equal(new URL(target).searchParams.has('token'), false);
      assert.equal(init.headers['x-lobee-token'], 'token-two');
      return eventsResponse(init.signal, [`id: 1\ndata: ${JSON.stringify(started)}\n\n`], false);
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

test('run policy and conversation identity are propagated to the sidecar', async () => {
  let posted;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40112', token: 'token-policy', profileId: 'p1' });
    }
    if (target.includes('/events?')) return eventsResponse(init.signal);
    if (target.endsWith('/run')) {
      posted = JSON.parse(String(init.body));
      return json({ ok: true, sessionId: 'session-policy' });
    }
    if (target.endsWith('/status')) return json({ runs: [] });
    throw new Error(`unexpected request: ${target}`);
  };

  assert.equal(
    await bridge.runTask(
      'work safely',
      {
        mode: 'agent',
        model: 'test/model',
        effort: 'high',
        threadId: 'thread_policy',
        autonomy: 'confirm',
        allowedDomains: ['example.com', 'accounts.example.com'],
        tokenBudget: 50_000,
      },
      { onEvent: () => {} },
    ),
    'started',
  );
  assert.match(posted.requestId, /^[0-9a-f-]{36}$/);
  const { requestId: _requestId, ...postedPolicy } = posted;
  assert.deepEqual(postedPolicy, {
    task: 'work safely',
    mode: 'agent',
    model: 'test/model',
    effort: 'high',
    threadId: 'thread_policy',
    autonomy: 'confirm',
    allowedDomains: ['example.com', 'accounts.example.com'],
    tokenBudget: 50_000,
  });
});

test('explicit unlimited token policy is represented as null on the wire', async () => {
  let posted;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40113', token: 'token-unlimited', profileId: 'p1' });
    }
    if (target.includes('/events?')) return eventsResponse(init.signal);
    if (target.endsWith('/run')) {
      posted = JSON.parse(String(init.body));
      return json({ ok: true, sessionId: 'session-unlimited' });
    }
    if (target.endsWith('/status')) return json({ runs: [] });
    throw new Error(`unexpected request: ${target}`);
  };

  assert.equal(
    await bridge.runTask(
      'unbounded by explicit choice',
      { mode: 'ask', model: 'test/model', tokenBudget: null },
      { onEvent: () => {} },
    ),
    'started',
  );
  assert.equal(posted.tokenBudget, null);
});

test('encrypted thread loading distinguishes an empty thread from a transient failure', async () => {
  let fail = true;
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40114', token: 'token-thread', profileId: 'p1' });
    }
    if (target.includes('/thread?')) {
      if (fail) return json({ ok: false, error: 'memory temporarily unavailable' }, 503);
      return json({
        ok: true,
        messages: [
          { role: 'user', content: 'task' },
          { role: 'assistant', content: 'answer', status: 'done', turnId: 'stable-turn-id' },
        ],
      });
    }
    throw new Error(`unexpected request: ${target}`);
  };

  assert.deepEqual(await bridge.fetchThread('thread-a'), {
    ok: false,
    error: 'memory temporarily unavailable',
  });
  fail = false;
  assert.deepEqual(await bridge.fetchThread('thread-a'), {
    ok: true,
    messages: [
      { role: 'user', content: 'task' },
      { role: 'assistant', content: 'answer', status: 'done', turnId: 'stable-turn-id' },
    ],
  });
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
          : configReads === 2
            ? {}
            : { origin: 'http://127.0.0.1:40104', token: 'new-token', profileId: 'p1' },
        configReads === 2 ? 404 : 200,
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
  await new Promise((resolve) => setTimeout(resolve, 2_000));
  const terminal = received.find((event) => event.type === 'run.finished');
  assert.equal(terminal?.status, 'error');
  assert.match(terminal?.error ?? '', /service restarted/i);
  assert.ok(configReads >= 3);
});

test('a lost run response is retried with one stable request ID', async () => {
  const posted = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40115', token: 'token-retry', profileId: 'p1' });
    }
    if (target.includes('/events?')) return eventsResponse(init.signal);
    if (target.endsWith('/run')) {
      posted.push(JSON.parse(String(init.body)));
      if (posted.length === 1) throw new TypeError('response connection reset');
      return json({ ok: true, sessionId: 'session-retried' });
    }
    if (target.endsWith('/status')) return json({ runs: [] });
    throw new Error(`unexpected request: ${target}`);
  };

  assert.equal(
    await bridge.runTask(
      'retry safely',
      { mode: 'agent', model: 'test/model' },
      { onEvent: () => {} },
    ),
    'started',
  );
  assert.equal(posted.length, 2);
  assert.match(posted[0].requestId, /^[0-9a-f-]{36}$/);
  assert.equal(posted[1].requestId, posted[0].requestId);
  assert.deepEqual(posted[1], posted[0]);
});

test('two lost run responses reattach through status without emitting a false terminal event', async () => {
  const received = [];
  let runAttempts = 0;
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40117', token: 'token-reconcile', profileId: 'p1' });
    }
    if (target.includes('/events?')) return eventsResponse(init.signal);
    if (target.endsWith('/run')) {
      runAttempts += 1;
      throw new TypeError('response connection reset');
    }
    if (target.endsWith('/status')) {
      return json({
        runs: [
          {
            sessionId: 'session-reconciled',
            profileId: 'p1',
            threadId: 'thread_reconcile',
            task: 'reconcile me',
            status: 'running',
            step: 1,
            startedAt: new Date().toISOString(),
            usage: { tokensIn: 0, tokensOut: 0 },
          },
        ],
      });
    }
    throw new Error(`unexpected request: ${target}`);
  };

  assert.equal(
    await bridge.runTask(
      '  reconcile me  ',
      { mode: 'agent', model: 'test/model', threadId: 'thread_reconcile' },
      { onEvent: (event) => received.push(event) },
    ),
    'started',
  );
  assert.equal(runAttempts, 2);
  assert.equal(
    received.some((event) => event.type === 'run.finished'),
    false,
  );
});

test('an unconfirmed start retries in the background with the same request ID', async () => {
  const received = [];
  const requests = [];
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40118', token: 'token-background', profileId: 'p1' });
    }
    if (target.includes('/events?')) return eventsResponse(init.signal);
    if (target.endsWith('/run')) {
      requests.push(JSON.parse(String(init.body)));
      if (requests.length <= 2) throw new TypeError('response connection reset');
      return json({ ok: true, sessionId: 'session-background-recovered' });
    }
    if (target.endsWith('/status')) return json({ ok: false }, 503);
    throw new Error(`unexpected request: ${target}`);
  };

  assert.equal(
    await bridge.runTask(
      'recover in background',
      { mode: 'agent', model: 'test/model' },
      { onEvent: (event) => received.push(event) },
    ),
    'started',
  );
  await waitUntil(() => requests.length === 3);
  assert.equal(new Set(requests.map((request) => request.requestId)).size, 1);
  assert.equal(
    received.some((event) => event.type === 'run.finished'),
    false,
  );
});

test('lost input responses reconcile authoritative status instead of leaving a stale approval', async () => {
  let inputAttempts = 0;
  let requestId = '';
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40116', token: 'token-input', profileId: 'p1' });
    }
    if (target.includes('/events?')) return eventsResponse(init.signal);
    if (target.endsWith('/run')) return json({ ok: true, sessionId: 'session-input' });
    if (target.endsWith('/input')) {
      inputAttempts += 1;
      const posted = JSON.parse(String(init.body));
      if (!requestId) requestId = posted.requestId;
      assert.equal(posted.requestId, requestId);
      assert.equal(posted.sessionId, 'session-input');
      throw new TypeError('response connection reset');
    }
    if (target.endsWith('/status')) {
      return json({
        runs: [
          {
            sessionId: 'session-input',
            profileId: 'p1',
            task: 'approve safely',
            status: 'running',
            step: 1,
            startedAt: new Date(0).toISOString(),
            usage: { tokensIn: 0, tokensOut: 0 },
          },
        ],
      });
    }
    throw new Error(`unexpected request: ${target}`);
  };

  assert.equal(
    await bridge.runTask(
      'approve safely',
      { mode: 'agent', model: 'test/model' },
      { onEvent: () => {} },
    ),
    'started',
  );
  await bridge.sendInput('approve');
  assert.equal(inputAttempts, 2);
  assert.match(requestId, /^[0-9a-f-]{36}$/);
});

test('a refused run is reported as a named entitlement, not as a generic failure', async () => {
  globalThis.fetch = async (url, init = {}) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40140', token: 'token-refused', profileId: 'p1' });
    }
    if (target.includes('/events?')) return eventsResponse(init.signal);
    if (target.endsWith('/run')) {
      return json(
        {
          ok: false,
          code: 'plan_required',
          error: 'Lobee is included with Plus, Pro and Max. Your team is on Light.',
          tier: 'light',
          requiredTiers: ['plus', 'pro', 'max'],
          minimumTier: 'plus',
        },
        403,
      );
    }
    if (target.endsWith('/status')) return json({ runs: [] });
    throw new Error(`unexpected request: ${target}`);
  };

  const refusals = [];
  const events = [];
  const result = await bridge.runTask(
    'do something expensive',
    { mode: 'agent', model: 'test/model' },
    { onEvent: (event) => events.push(event), onRefusal: (value) => refusals.push(value) },
  );

  assert.equal(result, 'failed');
  // The panel can only offer "upgrade to Plus" if the tiers survive the refusal as data; a sentence
  // in an error field cannot be turned back into a button.
  assert.deepEqual(refusals, [
    {
      entitled: false,
      code: 'plan_required',
      tier: 'light',
      requiredTiers: ['plus', 'pro', 'max'],
      minimumTier: 'plus',
      message: 'Lobee is included with Plus, Pro and Max. Your team is on Light.',
    },
  ]);
  assert.equal(events.at(-1).status, 'error');
});

test('an unreachable entitlement question is unknown, never a refusal', async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40141', token: 'token-entitle', profileId: 'p1' });
    }
    if (target.endsWith('/entitlement')) return json({ error: 'nope' }, 503);
    throw new Error(`unexpected request: ${target}`);
  };
  // Locking the panel on an unanswered question is the same lie as offering what is refused.
  assert.equal(await bridge.fetchEntitlement(), null);
});

test('an entitled account reports its package and nothing to act on', async () => {
  globalThis.fetch = async (url) => {
    const target = String(url);
    if (target.startsWith('chrome-extension://')) {
      return json({ origin: 'http://127.0.0.1:40142', token: 'token-entitled', profileId: 'p1' });
    }
    if (target.endsWith('/entitlement')) return json({ ok: true, entitled: true, tier: 'pro' });
    throw new Error(`unexpected request: ${target}`);
  };
  assert.deepEqual(await bridge.fetchEntitlement(), { entitled: true, tier: 'pro' });
});

async function waitUntil(predicate, timeoutMs = 1_000) {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for bridge recovery');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
