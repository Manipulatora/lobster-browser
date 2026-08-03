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

test('an answer body is never written to local storage', async () => {
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

  // What survives is the index: enough to list history and re-read it from encrypted memory.
  const [turn] = await loadTranscript();
  assert.equal(turn.task, 'check my order');
  assert.equal(turn.status, 'done');
  assert.equal(turn.threadId, 'thread-a', 'the thread id is what makes hydration possible');
  assert.ok(!turn.answer, 'no body is restored from local storage');
});

test('a transcript written by an older panel still loads', async () => {
  // Older bundles wrote `answer`. Dropping those rows would silently erase a user's history.
  bin = {
    'lobee.transcript.v1': [
      { id: 1, task: 'older turn', status: 'done', answer: 'previously stored body' },
    ],
  };
  const turns = await loadTranscript();
  assert.equal(turns.length, 1);
  assert.equal(turns[0].task, 'older turn');
});

test('redaction still blanks labelled secrets wherever it is applied', () => {
  assert.match(redactTranscriptText('password: hunter2'), /\[REDACTED\]/);
  assert.match(redactTranscriptText('Bearer abcdef0123456789'), /Bearer \[REDACTED\]/);
});
