import assert from 'node:assert/strict';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { FileMemoryStore } from './file-store.js';

const key = (): string => randomBytes(32).toString('base64');

/**
 * The store's entire contract is now NEGATIVE: nothing persists, and nothing is recalled. These
 * tests pin that contract from both directions — writes leave no trace on disk, and reads answer
 * with emptiness even when plausible-looking data sits in the directory. They are the guard against
 * a well-meaning future change quietly re-introducing durable agent memory without the owner
 * re-making that decision explicitly.
 */

test('every write is dropped: a fully exercised store leaves the directory untouched', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-memory-'));
  try {
    const store = new FileMemoryStore(dir, { encryptionKey: key() });
    await store.appendThreadTurn('thread_1', {
      user: 'private request',
      assistant: 'private answer',
      status: 'done',
    });
    await store.rememberFact({ domain: 'example.com', key: 'locale', value: 'de-DE' });
    await store.learnSkill({
      name: 'export-invoice',
      trigger: 'invoice needed',
      steps: '1. Reports. 2. Export.',
      origin: 'learned',
      domain: 'example.com',
      learnedAt: '2026-01-01T00:00:00.000Z',
    });
    await store.startRun('run_1', 'private task', '2026-01-01T00:00:00.000Z', { mode: 'agent' });
    await store.appendStep('run_1', {
      index: 1,
      url: 'https://example.com',
      action: '{"kind":"wait"}',
      outcome: 'ok',
      ts: '2026-01-01T00:00:01.000Z',
    });
    await store.finishRun('run_1', {
      status: 'done',
      summary: 'private summary',
      usage: { tokensIn: 1, tokensOut: 1 },
      endedAt: '2026-01-01T00:00:02.000Z',
    });
    await store.setSettings({ model: 'test/model' });

    // The decisive assertion: no file, no subdirectory, no marker — the mkdtemp dir is exactly as
    // empty as it was created. Anything appearing here is persisted agent memory, which is banned.
    assert.deepEqual(await readdir(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('every read answers empty, even over residue a previous product version left behind', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-agent-memory-residue-'));
  try {
    // Simulate an upgraded profile: plaintext-era records are still on disk. The store must not
    // read them — not as data, and not as a migration source. (They are also deliberately not
    // deleted: automated destruction of user files is a desktop-core decision, not this store's.)
    await writeFile(join(dir, 'memory.json'), JSON.stringify({ facts: [{ key: 'x' }] }));
    const store = new FileMemoryStore(dir, { encryptionKey: key() });

    assert.deepEqual(await store.loadThread('thread_1'), []);
    assert.deepEqual(await store.loadThreadStrict('thread_1'), []);
    assert.deepEqual(await store.listThreads(), []);
    assert.equal(await store.loadContext('example.com', 'remember locale'), '');
    assert.equal(await store.loadContext(undefined, 'open a site'), '');
    assert.deepEqual(await store.getSettings(), {});

    // The residue file was left alone (never re-encrypted, never removed).
    assert.equal(await readFile(join(dir, 'memory.json'), 'utf8'), '{"facts":[{"key":"x"}]}');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a mis-provisioned profile key still fails loudly at construction', async () => {
  // The store persists nothing, but the key check stays: the same profile key drives the REAL
  // encrypted run journal, and a caller that constructs memory with a bad key would otherwise sail
  // on until the journal store fails much deeper in a run.
  assert.throws(
    () => new FileMemoryStore('/tmp/anywhere', { encryptionKey: 'not-a-key' }),
    /32 bytes/,
  );
});
