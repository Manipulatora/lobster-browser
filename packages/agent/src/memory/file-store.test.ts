import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { FileMemoryStore } from './file-store.js';

const key = (): string => randomBytes(32).toString('base64');

async function recordRun(
  store: FileMemoryStore,
  input: {
    id: string;
    task: string;
    startedAt: string;
    summary: string;
    status?: string;
    mode?: 'ask' | 'agent';
    model?: string;
  },
): Promise<void> {
  await store.startRun(input.id, input.task, input.startedAt, {
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.model ? { model: input.model } : {}),
  });
  await store.finishRun(input.id, {
    status: input.status ?? 'done',
    summary: input.summary,
    usage: { tokensIn: 10, tokensOut: 5 },
    endedAt: new Date(Date.parse(input.startedAt) + 1_000).toISOString(),
  });
}

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
    assert.equal(await store.loadConversationContext(), '');
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

test('conversation recall spans Ask and Agent modes but excludes legacy, failed, and sensitive runs', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-conversation-'));
  const encryptionKey = key();
  try {
    await mkdir(join(dir, 'runs'), { recursive: true });
    await writeFile(
      join(dir, 'runs', 'legacy.json'),
      JSON.stringify({
        id: 'legacy',
        task: 'Legacy question',
        status: 'done',
        startedAt: '2026-01-01T00:00:00.000Z',
        summary: 'Legacy answer',
        steps: [],
      }),
    );
    const store = new FileMemoryStore(dir, { encryptionKey });
    await recordRun(store, {
      id: 'ask-1',
      task: 'My name is Ada.',
      startedAt: '2026-01-02T00:00:00.000Z',
      summary: 'I will remember that your name is Ada.',
      mode: 'ask',
      model: 'claude-test',
    });
    await recordRun(store, {
      id: 'agent-1',
      task: 'Open example.com',
      startedAt: '2026-01-03T00:00:00.000Z',
      summary: 'Opened the page.',
      mode: 'agent',
    });
    await recordRun(store, {
      id: 'ask-failed',
      task: 'A failed question',
      startedAt: '2026-01-04T00:00:00.000Z',
      summary: 'Provider unavailable.',
      status: 'error',
      mode: 'ask',
    });
    await recordRun(store, {
      id: 'ask-secret-task',
      task: 'My password is hunter2',
      startedAt: '2026-01-05T00:00:00.000Z',
      summary: 'Understood.',
      mode: 'ask',
    });
    await recordRun(store, {
      id: 'ask-secret-output',
      task: 'Show the temporary authorization value.',
      startedAt: '2026-01-06T00:00:00.000Z',
      summary: 'Bearer abcdefghijklmnopqrst',
      mode: 'ask',
    });
    await recordRun(store, {
      id: 'ask-2',
      task: 'My favorite color is violet.',
      startedAt: '2026-01-07T00:00:00.000Z',
      summary: 'Noted: violet.',
      mode: 'ask',
    });

    // Re-instantiation models a new sidecar/app process using the stable per-profile memory key.
    const reloaded = new FileMemoryStore(dir, { encryptionKey });
    const context = await reloaded.loadConversationContext();
    assert.match(context, /User: My name is Ada\./);
    assert.match(context, /Assistant: I will remember that your name is Ada\./);
    assert.match(context, /User: My favorite color is violet\./);
    assert.match(context, /User: Open example\.com/);
    assert.match(context, /Assistant: Opened the page\./);
    assert.ok(context.indexOf('My name is Ada') < context.indexOf('favorite color'));
    assert.doesNotMatch(
      context,
      /Legacy question|failed question|hunter2|authorization value|abcdefghijklmnopqrst/,
    );
    assert.match(await readFile(join(dir, 'runs', 'legacy.json'), 'utf8'), /^lobster-memory-v1:/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('recall is best-effort: a corrupt or wrong-key run file is skipped, never fatal', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-recall-resilient-'));
  const encryptionKey = key();
  try {
    const store = new FileMemoryStore(dir, { encryptionKey });
    await recordRun(store, {
      id: 'good-1',
      task: 'My name is Ada.',
      startedAt: '2026-03-01T00:00:00.000Z',
      summary: 'Hello, Ada!',
      mode: 'ask',
    });
    // A garbage file and a run encrypted under a DIFFERENT key (as after a key rotation) sit beside it.
    await writeFile(join(dir, 'runs', 'corrupt.json'), 'lobster-memory-v1:@@not-base64@@');
    const other = new FileMemoryStore(dir, { encryptionKey: key() });
    await recordRun(other, {
      id: 'badkey-1',
      task: 'From another key',
      startedAt: '2026-03-02T00:00:00.000Z',
      summary: 'unreadable here',
      mode: 'ask',
    });
    // The good run is still recalled; the unreadable files are skipped and do NOT throw.
    const context = await store.loadConversationContext();
    assert.match(context, /User: My name is Ada\./);
    assert.doesNotMatch(context, /another key|unreadable here/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('Ask conversation context is bounded to recent complete turns', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-conversation-bound-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    for (let index = 0; index < 10; index += 1) {
      await recordRun(store, {
        id: `ask-${index}`,
        task: `Question ${index} ${'q'.repeat(220)}`,
        startedAt: `2026-02-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
        summary: `Answer ${index} ${'a'.repeat(220)}`,
        mode: 'ask',
      });
    }
    const context = await store.loadConversationContext();
    assert.ok(
      context.length <= 4_000,
      'conversation context must stay inside its hard character bound',
    );
    assert.doesNotMatch(context, /Question 0 /);
    assert.match(context, /Question 9 /);
    assert.ok(context.indexOf('Question 8 ') < context.indexOf('Question 9 '));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('starting a new run marks an interrupted running Ask record stale so it is never recalled', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-stale-run-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    await store.startRun('stale', 'An unfinished question', '2026-03-01T00:00:00.000Z', {
      mode: 'ask',
      model: 'claude-test',
    });
    await recordRun(store, {
      id: 'current',
      task: 'A completed question',
      startedAt: '2026-03-02T00:00:00.000Z',
      summary: 'A completed answer',
      mode: 'ask',
    });
    const context = await store.loadConversationContext();
    assert.doesNotMatch(context, /unfinished question/);
    assert.match(context, /completed question/);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
