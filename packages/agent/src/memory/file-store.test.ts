import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { FileMemoryStore } from './file-store.js';

const key = (): string => randomBytes(32).toString('base64');

test('memory is authenticated/encrypted, atomically updated, and domain-scoped', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-memory-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    await store.rememberFact({ domain: 'example.com', key: 'locale', value: 'de-DE' });
    await store.startRun('run_1', 'private task', '2026-01-01T00:00:00.000Z');
    await store.appendStep('run_1', {
      index: 1,
      url: 'https://example.com',
      action: '{"kind":"wait"}',
      outcome: 'ok',
      ts: '2026-01-01T00:00:01.000Z',
    });
    const memoryBytes = await readFile(join(dir, 'memory.json'), 'utf8');
    const runBytes = await readFile(join(dir, 'runs', 'run_1.json'), 'utf8');
    assert.match(memoryBytes, /^lobster-memory-v1:/);
    assert.match(runBytes, /^lobster-memory-v1:/);
    assert.doesNotMatch(memoryBytes + runBytes, /private task|de-DE/);
    assert.match(await store.loadContext('sub.example.com', 'remember locale'), /de-DE/);
    assert.doesNotMatch(await store.loadContext('notexample.com', 'remember locale'), /de-DE/);
    assert.doesNotMatch(await store.loadContext(undefined, 'open a site'), /de-DE/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('legacy plaintext run records migrate and a wrong key fails authentication', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-migrate-'));
  const encryptionKey = key();
  try {
    await mkdir(join(dir, 'runs'), { recursive: true });
    await writeFile(
      join(dir, 'runs', 'old.json'),
      JSON.stringify({
        id: 'old',
        mode: 'ask',
        task: 'My password is legacy-secret',
        status: 'done',
        startedAt: '2025-01-01T00:00:00.000Z',
        endedAt: '2025-01-01T00:00:01.000Z',
        summary: 'Saved password legacy-secret',
        steps: [
          {
            index: 1,
            url: 'https://example.com/login?token=legacy-secret',
            action: '{"kind":"type","text":"legacy-secret"}',
            outcome: 'password: legacy-secret',
            ts: '2025-01-01T00:00:00.500Z',
          },
        ],
      }),
    );
    const store = new FileMemoryStore(dir, { encryptionKey });
    await store.startRun('new', 'new', 'x');
    assert.match(await readFile(join(dir, 'runs', 'old.json'), 'utf8'), /^lobster-memory-v1:/);
    const wrong = new FileMemoryStore(dir, { encryptionKey: key() });
    await assert.rejects(
      wrong.appendStep('new', { index: 1, url: '', action: '', outcome: '', ts: '' }),
      /authentication failed/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('secret-labelled facts are rejected', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-secret-fact-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    await assert.rejects(
      store.rememberFact({ domain: 'example.com', key: 'password', value: 'do-not-save' }),
      /secrets must not be saved/,
    );
    await assert.rejects(
      store.rememberFact({
        domain: 'example.com',
        key: 'login hint',
        value: 'The verification code is 123456',
      }),
      /secrets must not be saved/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------------------------------
// Conversation threads. These cover the reported failure directly: a long answer used to delete its own
// turn from history, because one 4,000-char constant served as BOTH the per-turn and the total budget
// and oversized turns were skipped rather than clipped.

test('a long answer keeps its turn instead of erasing it', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobee-thread-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    // Comfortably past the old 4,000-char drop threshold, and typical of the Markdown the Ask prompt
    // explicitly asks the model to produce.
    const long = `# Proxies\n\n${'A detailed paragraph explaining the setup. '.repeat(200)}`;
    assert.ok(long.length > 4_000);

    await store.appendThreadTurn('t1', {
      user: 'How do I configure a proxy?',
      assistant: long,
      status: 'done',
    });
    await store.appendThreadTurn('t1', {
      user: 'And DNS?',
      assistant: 'Use DNS-over-HTTPS.',
      status: 'done',
    });

    const messages = await store.loadThread('t1');
    assert.equal(messages.length, 4);
    assert.equal(messages[0]?.content, 'How do I configure a proxy?');
    // The answer may be clipped to fit, but the turn must still be there and still be recognisable.
    assert.match(messages[1]?.content ?? '', /Proxies/);
    assert.equal(messages[1]?.role, 'assistant');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a failed turn is retained and labelled, so "try that again" has a referent', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobee-thread-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    await store.appendThreadTurn('t1', {
      user: 'Summarise this page.',
      assistant: 'The page could not be reached.',
      status: 'error',
    });
    const messages = await store.loadThread('t1');
    assert.equal(messages.length, 2);
    assert.equal(messages[0]?.content, 'Summarise this page.');
    assert.equal(messages[1]?.status, 'error');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('threads are isolated: an unrelated conversation never bleeds in', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobee-thread-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    await store.appendThreadTurn('work', {
      user: 'Book a flight.',
      assistant: 'Done.',
      status: 'done',
    });
    await store.appendThreadTurn('other', {
      user: 'What is Rust?',
      assistant: 'A language.',
      status: 'done',
    });

    const work = await store.loadThread('work');
    assert.equal(work.length, 2);
    assert.ok(!work.some((m) => /Rust/.test(m.content)));
    assert.equal((await store.loadThread('unknown')).length, 0);

    const listed = await store.listThreads();
    assert.deepEqual(listed.map((t) => t.id).sort(), ['other', 'work']);
    assert.equal(listed.find((t) => t.id === 'work')?.title, 'Book a flight.');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('an overlong thread compacts oldest-first and keeps recent turns verbatim', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobee-thread-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    const bulky = 'x'.repeat(12_000);
    for (let i = 0; i < 20; i += 1) {
      await store.appendThreadTurn('t1', {
        user: `Question ${i}`,
        assistant: bulky,
        status: 'done',
      });
    }
    const messages = await store.loadThread('t1');
    // Oldest turns collapsed into a visible marker rather than vanishing silently...
    assert.equal(messages[0]?.role, 'compaction');
    assert.match(messages[0]?.content ?? '', /Question 0/);
    // ...and the newest exchange is still present, untouched.
    assert.equal(messages.at(-2)?.content, 'Question 19');
    assert.equal(messages.at(-1)?.content, bulky);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
