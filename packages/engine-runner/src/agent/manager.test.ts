import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { RunJournalStore } from '@lobster/agent';
import type { AgentStartParams } from '@lobster/shared-types';
import { admitUnfinishedRunJournals, AgentManager } from './manager.js';

async function append(
  store: RunJournalStore,
  runId: string,
  event: Parameters<RunJournalStore['append']>[1],
): Promise<void> {
  const current = await store.load(runId);
  assert.ok(current);
  await store.append(runId, event, current.journal.revision);
}

function startParams(root: string, profileId: string, memoryKey: string): AgentStartParams {
  return {
    profileId,
    origin: 'panel',
    threadId: 'thread_reopen',
    task: 'answer briefly',
    memoryDir: join(root, 'agent'),
    memoryKey,
    llm: {
      provider: 'openrouter',
      managed: true,
      model: 'test/model',
      baseUrl: 'http://127.0.0.1:9/agent/llm',
      apiKey: 'test-proxy-token',
    },
    config: { mode: 'ask' },
  };
}

async function stopAndSettle(manager: AgentManager, profileId: string): Promise<void> {
  manager.stop(profileId);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const status = manager.status(profileId).runs[0]?.status;
    if (status !== 'running' && status !== 'awaiting_input') return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('manager snapshots retain the conversation id, and a finished run leaves no journal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-thread-'));
  const manager = new AgentManager({ resolveWs: async () => undefined, emit: () => {} });
  const profileId = `manager-thread-${Date.now()}`;
  const memoryKey = randomBytes(32).toString('base64');
  try {
    const started = await manager.start(startParams(root, profileId, memoryKey));
    const snapshot = manager.status(profileId).runs[0];
    assert.equal(snapshot?.threadId, 'thread_reopen');
    assert.equal(snapshot?.task, 'answer briefly');

    // The run fails fast (its LLM endpoint is unreachable by construction) and reaches a terminal
    // status; production reuses the profile key for the per-profile journal store, and the loop
    // deletes the journal file the moment the terminal marker lands — completion must leave NOTHING.
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const status = manager.status(profileId).runs[0]?.status;
      if (status && status !== 'running' && status !== 'awaiting_input') break;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const journal = new RunJournalStore(join(root, 'agent', 'journals'), {
      encryptionKey: memoryKey,
    });
    assert.equal(await journal.load(started.sessionId), null, 'no journal may survive completion');
    assert.deepEqual(await journal.listRunIds(), []);
  } finally {
    await stopAndSettle(manager, profileId);
    await rm(root, { recursive: true, force: true });
  }
});

test('admission heals every interrupted journal — no phase throws, no residue remains', async () => {
  // The four shapes that used to strand a profile behind "Agent recovery required …": a clean
  // checkpoint, a pending proposal, an ambiguous write dispatch, and an unreconciled navigation.
  // Each is now walked to a terminal state through the legal recovery transitions (never replayed)
  // and its file deleted, so the next start finds an empty directory instead of a locked door.
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-self-heal-'));
  const store = new RunJournalStore(join(root, 'journals'), { encryptionKey: randomBytes(32) });
  try {
    await store.create({ runId: 'clean', task: 'task', mode: 'agent' });
    await store.create({ runId: 'pending', task: 'task', mode: 'agent' });
    await append(store, 'pending', {
      type: 'action.proposed',
      actionId: 'a1',
      actionKind: 'type',
      effect: 'write',
      summary: 'Proposed type action',
      host: 'example.test',
    });
    await store.create({ runId: 'write_dispatch', task: 'task', mode: 'agent' });
    await append(store, 'write_dispatch', {
      type: 'action.proposed',
      actionId: 'a1',
      actionKind: 'type',
      effect: 'write',
      summary: 'Proposed type action',
      host: 'example.test',
    });
    await append(store, 'write_dispatch', { type: 'action.dispatching', actionId: 'a1' });
    await store.create({ runId: 'drift', task: 'task', mode: 'agent' });
    await append(store, 'drift', {
      type: 'action.proposed',
      actionId: 'reconcile-1',
      actionKind: 'navigation_reconcile',
      effect: 'write',
      summary: 'Unexpected navigation requires reconciliation',
      host: 'outside.test',
    });

    const warnings: string[] = [];
    await admitUnfinishedRunJournals(store, 'profile-heal', (message) => warnings.push(message));

    assert.deepEqual(await store.listRunIds(), [], 'every journal file must be gone');
    assert.deepEqual(await store.listUnfinished(), []);
    // The discard is loud, not silent: each auto-closed run is named, and the ambiguous write warns
    // the operator to verify the site manually — the honesty the old throw used to enforce.
    assert.equal(warnings.filter((w) => /auto-closed interrupted run/.test(w)).length, 4);
    assert.ok(warnings.some((w) => /may already have taken effect/.test(w)));
    assert.ok(warnings.every((w) => !/replay/.test(w) || /without replay/.test(w)));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('an interrupted SENSITIVE journal is auto-healed on the next start, and the run proceeds', async () => {
  // The exact user-facing failure this refactor kills: a run marked sensitive (credential handoff,
  // upload path, screenshot) was interrupted, and every later `agent.start` threw "Agent recovery
  // required … resolve or discard this encrypted journal" forever. Now the start itself heals it.
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-sensitive-heal-'));
  const manager = new AgentManager({ resolveWs: async () => undefined, emit: () => {} });
  const profileId = `manager-heal-${Date.now()}`;
  const memoryKey = randomBytes(32).toString('base64');
  try {
    const params = startParams(root, profileId, memoryKey);
    const store = new RunJournalStore(join(params.memoryDir, 'journals'), {
      encryptionKey: memoryKey,
    });
    await store.create({ runId: 'stranded_sensitive', task: 'task', mode: 'agent' });
    await append(store, 'stranded_sensitive', { type: 'run.sensitive', reason: 'credential' });

    // No throw: the new run is admitted. (It then fails fast on its unreachable LLM endpoint,
    // which is irrelevant here — admission was the wall.)
    const started = await manager.start(params);
    assert.equal(started.profileId, profileId);

    // The stranded journal was closed without replay and its file deleted.
    assert.equal(await store.load('stranded_sensitive'), null);
  } finally {
    await stopAndSettle(manager, profileId);
    await rm(root, { recursive: true, force: true });
  }
});

test('a corrupt journal is quarantined aside instead of blocking every future start', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-corrupt-heal-'));
  const store = new RunJournalStore(join(root, 'journals'), { encryptionKey: randomBytes(32) });
  try {
    await store.create({ runId: 'healthy', task: 'task', mode: 'agent' });
    // Plant bytes that fail authenticated decryption where a journal is expected.
    await writeFile(join(root, 'journals', 'mangled.journal'), 'lobee-run-journal-v1:garbage');

    const warnings: string[] = [];
    await admitUnfinishedRunJournals(store, 'profile-corrupt', (message) => warnings.push(message));

    assert.deepEqual(await store.listRunIds(), [], 'the healthy journal healed, the corrupt moved');
    assert.ok(warnings.some((w) => /mangled\.journal\.corrupt/.test(w)));
    const { readdir } = await import('node:fs/promises');
    const names = await readdir(join(root, 'journals'));
    assert.ok(names.includes('mangled.journal.corrupt'), 'the bytes survive for forensics');
    assert.ok(!names.includes('mangled.journal'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('concurrent starts are serialized before asynchronous journal admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-start-race-'));
  const manager = new AgentManager({ resolveWs: async () => undefined, emit: () => {} });
  const profileId = `manager-race-${Date.now()}`;
  const params = startParams(root, profileId, randomBytes(32).toString('base64'));
  try {
    const results = await Promise.allSettled([manager.start(params), manager.start(params)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = results.find((result) => result.status === 'rejected');
    assert.ok(rejection?.status === 'rejected');
    assert.match(
      String(rejection.reason),
      /already has an agent starting|already has a running agent/,
    );
  } finally {
    await stopAndSettle(manager, profileId);
    await rm(root, { recursive: true, force: true });
  }
});

test('separate manager instances cannot race one profile', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-cross-instance-'));
  const first = new AgentManager({ resolveWs: async () => undefined, emit: () => {} });
  const second = new AgentManager({ resolveWs: async () => undefined, emit: () => {} });
  const profileId = `manager-cross-${Date.now()}`;
  const params = startParams(root, profileId, randomBytes(32).toString('base64'));
  try {
    const results = await Promise.allSettled([first.start(params), second.start(params)]);
    assert.equal(results.filter((result) => result.status === 'fulfilled').length, 1);
    const rejection = results.find((result) => result.status === 'rejected');
    assert.ok(rejection?.status === 'rejected');
    assert.match(String(rejection.reason), /already has a running agent/);
  } finally {
    await stopAndSettle(first, profileId);
    await stopAndSettle(second, profileId);
    await rm(root, { recursive: true, force: true });
  }
});

test('a lease owned by a dead process is recovered before journal admission', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-stale-lease-'));
  const manager = new AgentManager({ resolveWs: async () => undefined, emit: () => {} });
  const profileId = `manager-stale-${Date.now()}`;
  const params = startParams(root, profileId, randomBytes(32).toString('base64'));
  try {
    await mkdir(params.memoryDir, { recursive: true });
    await writeFile(
      join(params.memoryDir, '.lobee-agent.lock'),
      JSON.stringify({ version: 1, profileId, pid: 2_147_483_647, nonce: 'stale' }),
    );
    const started = await manager.start(params);
    assert.equal(started.profileId, profileId);
  } finally {
    await stopAndSettle(manager, profileId);
    await rm(root, { recursive: true, force: true });
  }
});
