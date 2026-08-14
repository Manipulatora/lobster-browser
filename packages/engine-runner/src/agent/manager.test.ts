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

test('manager snapshots retain the conversation id across panel reopen', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-thread-'));
  const manager = new AgentManager({ resolveWs: async () => undefined, emit: () => {} });
  const profileId = `manager-thread-${Date.now()}`;
  const memoryKey = randomBytes(32).toString('base64');
  try {
    const started = await manager.start(startParams(root, profileId, memoryKey));
    const snapshot = manager.status(profileId).runs[0];
    assert.equal(snapshot?.threadId, 'thread_reopen');
    assert.equal(snapshot?.task, 'answer briefly');

    // Production always supplies the encrypted journal in a per-profile subdirectory and reuses the
    // exact profile key. Wait for the fire-and-forget loop's first fsynced create.
    const journal = new RunJournalStore(join(root, 'agent', 'journals'), {
      encryptionKey: memoryKey,
    });
    let durable = await journal.load(started.sessionId);
    for (let attempt = 0; !durable && attempt < 50; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 10));
      durable = await journal.load(started.sessionId);
    }
    assert.ok(durable);
  } finally {
    await stopAndSettle(manager, profileId);
    await rm(root, { recursive: true, force: true });
  }
});

test('admission closes clean, pending, and read-dispatch journals without replay', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-safe-recovery-'));
  const key = randomBytes(32);
  const store = new RunJournalStore(join(root, 'journals'), { encryptionKey: key });
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
    await store.create({ runId: 'read_dispatch', task: 'task', mode: 'agent' });
    await append(store, 'read_dispatch', {
      type: 'action.proposed',
      actionId: 'a1',
      actionKind: 'extract',
      effect: 'read',
      summary: 'Proposed extract action',
      host: 'example.test',
    });
    await append(store, 'read_dispatch', { type: 'action.dispatching', actionId: 'a1' });

    await admitUnfinishedRunJournals(store, 'profile-safe');

    for (const runId of ['clean', 'pending', 'read_dispatch']) {
      assert.equal((await store.load(runId))?.state.phase, 'stopped');
    }
    const read = await store.load('read_dispatch');
    assert.ok(read);
    assert.deepEqual(
      read.journal.events.slice(-3).map((event) => event.type),
      ['action.observed', 'recovery.resolved', 'run.stopped'],
    );
    assert.equal(
      read.journal.events.some((event) => event.type === 'action.proposed' && 'args' in event),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('admission rejects ambiguous writes and leaves their journals unresolved', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-write-recovery-'));
  const store = new RunJournalStore(join(root, 'journals'), { encryptionKey: randomBytes(32) });
  try {
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

    await assert.rejects(
      admitUnfinishedRunJournals(store, 'profile-write'),
      /recovery required.*write.*Verify the live browser.*will not replay/is,
    );
    const unresolved = await store.load('write_dispatch');
    assert.equal(unresolved?.state.phase, 'dispatching');
    assert.equal(
      unresolved?.journal.events.some(
        (event) =>
          event.type === 'run.completed' ||
          event.type === 'run.failed' ||
          event.type === 'run.stopped',
      ),
      false,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('admission rejects unfinished sensitive journals even before an action dispatch', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-sensitive-recovery-'));
  const store = new RunJournalStore(join(root, 'journals'), { encryptionKey: randomBytes(32) });
  try {
    await store.create({ runId: 'sensitive_handoff', task: 'task', mode: 'agent' });
    await append(store, 'sensitive_handoff', { type: 'run.sensitive', reason: 'credential' });
    await assert.rejects(
      admitUnfinishedRunJournals(store, 'profile-sensitive'),
      /recovery required.*credential.*will not replay/is,
    );
    assert.equal((await store.load('sensitive_handoff'))?.state.phase, 'running');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('admission never discards unfinished unexpected-navigation reconciliation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lobee-manager-drift-recovery-'));
  const store = new RunJournalStore(join(root, 'journals'), { encryptionKey: randomBytes(32) });
  try {
    await store.create({ runId: 'drift', task: 'task', mode: 'agent' });
    await append(store, 'drift', {
      type: 'action.proposed',
      actionId: 'reconcile-1',
      actionKind: 'navigation_reconcile',
      effect: 'write',
      summary: 'Unexpected navigation requires reconciliation',
      host: 'outside.test',
    });

    await assert.rejects(
      admitUnfinishedRunJournals(store, 'profile-drift'),
      /recovery required.*unexpected navigation.*will not replay/is,
    );
    const unresolved = await store.load('drift');
    assert.equal(unresolved?.state.phase, 'proposed');
    assert.equal(unresolved?.state.activeAction?.actionKind, 'navigation_reconcile');
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
