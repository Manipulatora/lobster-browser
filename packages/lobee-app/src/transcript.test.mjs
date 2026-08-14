import assert from 'node:assert/strict';
import { test } from 'node:test';

// The panel persists through `chrome.storage.local` when present; stub it so save/load are observable.
let bin = {};
// Mirror the real API the module uses: `window.chrome.storage.local`, whose `get` takes a DEFAULTS
// object and returns a record. A stub that takes a key string silently returns undefined instead.
globalThis.window = {
  chrome: {
    storage: {
      local: {
        get: (defaults) =>
          Promise.resolve(
            Object.fromEntries(Object.entries(defaults).map(([k, d]) => [k, bin[k] ?? d])),
          ),
        set: (obj) => {
          Object.assign(bin, obj);
          return Promise.resolve();
        },
      },
    },
  },
};
globalThis.chrome = globalThis.window.chrome;

const { loadTranscript, saveTranscript, redactTranscriptText } = await import('./transcript.ts');

test('the local index never stores transcript or page-derived bodies', async () => {
  // Core memory is AES-256-GCM per profile. A second, plaintext copy of the same content in
  // chrome.storage.local defeated that: the redaction here only ever caught LABELLED secrets, so an
  // address, an order total, or a private message the agent read stayed readable on disk.
  bin = {};
  const secretish = 'Order total £4,182.90 shipping to 14 Marlow Road, delivered to Dr. A. Patel';
  await saveTranscript([
    {
      id: 1,
      threadId: 'thread-a',
      task: 'check my order',
      status: 'done',
      answer: secretish,
      steps: [{ label: 'click [3]', ctx: 'Orders' }],
    },
  ]);

  const raw = JSON.stringify(bin);
  assert.doesNotMatch(
    raw,
    /Marlow Road/,
    'page-derived content must not be persisted by the panel',
  );
  assert.doesNotMatch(raw, /4,182\.90/, 'nor must figures the agent read');
  assert.doesNotMatch(raw, /check my order/, 'the user task belongs in encrypted thread memory');
  assert.doesNotMatch(
    raw,
    /Orders/,
    'page titles and activity must not be duplicated in plaintext',
  );

  // What survives is only the correlation index needed to re-read encrypted memory.
  const [turn] = await loadTranscript();
  assert.equal(turn.status, 'done');
  assert.equal(turn.threadId, 'thread-a', 'the thread id is what makes hydration possible');
  assert.equal(turn.task, undefined);
  assert.equal(turn.steps, undefined);
  assert.ok(!turn.answer, 'no body is restored from local storage');
});

test('legacy bodies are retained until an encrypted counterpart is explicitly verified', async () => {
  bin = {
    'lobee.transcript.v1': [
      { id: 1, task: 'older turn', status: 'done', answer: 'previously stored body' },
    ],
  };
  const turns = await loadTranscript();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].task, 'older turn');
  assert.equal(turns[0].answer, 'previously stored body');
  assert.equal(turns[0].needsSecureMigration, true);

  await saveTranscript(turns);
  assert.match(JSON.stringify(bin), /older turn/);
  assert.match(JSON.stringify(bin), /previously stored body/);

  await saveTranscript([
    {
      id: 1,
      threadId: 'verified-thread',
      turnKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789',
      status: 'done',
    },
  ]);
  assert.doesNotMatch(JSON.stringify(bin), /older turn|previously stored body/);
});

test('metadata-only rows survive normalization and can be hydrated later', async () => {
  bin = {
    'lobee.transcript.v1': [
      {
        id: 7,
        threadId: 'thread-seven',
        sessionId: 'session-seven',
        turnKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789',
        status: 'error',
        tokensIn: 12,
        tokensOut: 3,
      },
    ],
  };
  assert.deepEqual(await loadTranscript(), [
    {
      id: 7,
      threadId: 'thread-seven',
      sessionId: 'session-seven',
      turnKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789',
      status: 'error',
      tokensIn: 12,
      tokensOut: 3,
    },
  ]);
});

test('starting another thread can retain an unverified legacy row beside new metadata', async () => {
  bin = {};
  await saveTranscript([
    {
      id: 1,
      threadId: 'old-thread',
      task: 'legacy private task',
      answer: 'legacy private answer',
      status: 'done',
      needsSecureMigration: true,
    },
    { id: 2, threadId: 'new-thread', sessionId: 'new-session', status: 'done' },
  ]);
  const rows = await loadTranscript();
  assert.equal(rows.length, 2);
  assert.equal(rows[0].task, 'legacy private task');
  assert.equal(rows[0].needsSecureMigration, true);
  assert.equal(rows[1].threadId, 'new-thread');
});

test('a newly terminal safety copy survives a failed encrypted-history read until verification', async () => {
  bin = {};
  await saveTranscript([
    {
      id: 9,
      threadId: 'current-thread',
      sessionId: 'current-session',
      task: 'send the private invoice; api key: should-not-remain-readable',
      answer: 'Done with Bearer abcdef0123456789',
      status: 'done',
      needsSecureMigration: true,
    },
  ]);

  let [fallback] = await loadTranscript();
  assert.equal(fallback.needsSecureMigration, true);
  assert.match(fallback.task, /send the private invoice/);
  assert.doesNotMatch(JSON.stringify(fallback), /should-not-remain-readable|abcdef0123456789/);

  // This is what the panel writes only after an exact encrypted exchange (and its stable identity)
  // has been observed. The plaintext safety copy must then disappear, not survive another reload.
  await saveTranscript([
    {
      id: 9,
      threadId: 'current-thread',
      sessionId: 'current-session',
      turnKey: 'abcdefghijklmnopqrstuvwxyzABCDEFGH123456789',
      status: 'done',
    },
  ]);
  [fallback] = await loadTranscript();
  assert.equal(fallback.needsSecureMigration, undefined);
  assert.equal(fallback.task, undefined);
  assert.equal(fallback.answer, undefined);
});

test('overlapping transcript writes cannot let an older snapshot finish last', async () => {
  bin = {};
  const originalSet = window.chrome.storage.local.set;
  let releaseFirst;
  let firstStarted;
  const firstStartedPromise = new Promise((resolve) => {
    firstStarted = resolve;
  });
  const firstGate = new Promise((resolve) => {
    releaseFirst = resolve;
  });
  let calls = 0;
  window.chrome.storage.local.set = async (obj) => {
    calls += 1;
    if (calls === 1) {
      firstStarted();
      await firstGate;
    }
    Object.assign(bin, obj);
  };

  try {
    const older = saveTranscript([
      { id: 1, threadId: 'thread-order', sessionId: 'old-session', status: 'done' },
    ]);
    await firstStartedPromise;
    const terminal = saveTranscript([
      {
        id: 2,
        threadId: 'thread-order',
        sessionId: 'terminal-session',
        task: 'terminal fallback',
        answer: 'terminal result',
        status: 'done',
        needsSecureMigration: true,
      },
    ]);
    await Promise.resolve();
    assert.equal(calls, 1, 'the newer write waits behind the already-started write');
    releaseFirst();
    await Promise.all([older, terminal]);
  } finally {
    window.chrome.storage.local.set = originalSet;
  }

  const [latest] = await loadTranscript();
  assert.equal(latest.sessionId, 'terminal-session');
  assert.equal(latest.task, 'terminal fallback');
  assert.equal(latest.needsSecureMigration, true);
});

test('new metadata cannot evict any of the bounded unverified legacy history', async () => {
  bin = {};
  const legacy = Array.from({ length: 24 }, (_, index) => ({
    id: index + 1,
    threadId: 'legacy-thread',
    task: `legacy task ${index}`,
    answer: `legacy answer ${index}`,
    status: 'done',
    needsSecureMigration: true,
  }));
  await saveTranscript([
    ...legacy,
    { id: 25, threadId: 'new-thread', sessionId: 'new-session', status: 'done' },
  ]);

  const rows = await loadTranscript();
  assert.equal(rows.length, 24);
  assert.deepEqual(
    rows.map((row) => row.task),
    legacy.map((row) => row.task),
    'reproducible metadata yields its slot before an unverified legacy body does',
  );
  assert.ok(rows.every((row) => row.needsSecureMigration));
});

test('redaction still blanks labelled secrets wherever it is applied', () => {
  assert.match(redactTranscriptText('password: hunter2'), /\[REDACTED\]/);
  assert.match(redactTranscriptText('Bearer abcdef0123456789'), /Bearer \[REDACTED\]/);
  assert.doesNotMatch(
    redactTranscriptText('tsk_testOnlyTemporaryFallbackCredential123456789'),
    /testOnlyTemporaryFallbackCredential/,
  );
  assert.doesNotMatch(
    redactTranscriptText('https://example.test/callback?token=testOnlyQueryCredential12345'),
    /testOnlyQueryCredential/,
  );
});
