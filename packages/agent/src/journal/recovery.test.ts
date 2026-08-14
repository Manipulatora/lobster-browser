import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { projectRunRecovery } from './recovery.js';
import type { JournalActionEffect } from './schema.js';
import { RunJournalStore, type RunJournalSnapshot } from './store.js';

const NOW = '2026-08-03T12:00:00.000Z';

async function scenario(
  events: Parameters<RunJournalStore['append']>[1][],
  task = 'Complete the browser task',
): Promise<{ snapshot: RunJournalSnapshot; projection: ReturnType<typeof projectRunRecovery> }> {
  const dir = await mkdtemp(join(tmpdir(), 'lobee-recovery-'));
  try {
    const store = new RunJournalStore(dir, {
      encryptionKey: randomBytes(32),
      clock: () => NOW,
    });
    let snapshot = await store.create({ runId: 'run', task, mode: 'agent' });
    for (const event of events) {
      snapshot = await store.append('run', event, snapshot.journal.revision);
    }
    return { snapshot, projection: projectRunRecovery(snapshot.state) };
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function proposal(effect: JournalActionEffect): Parameters<RunJournalStore['append']>[1] {
  return {
    type: 'action.proposed',
    actionId: 'a1',
    actionKind: effect === 'read' ? 'extract_text' : 'click',
    effect,
    summary: effect === 'read' ? 'Read visible page text' : 'Commit the requested change',
    host: 'example.com',
  };
}

test('clean and merely pending work always replans; no stored proposal is replayed', async () => {
  assert.deepEqual((await scenario([])).projection, {
    kind: 'replan',
    reason: 'clean_checkpoint',
  });

  const proposed = await scenario([proposal('write')]);
  assert.deepEqual(proposed.projection, {
    kind: 'replan',
    reason: 'pending_action_discarded',
    actionId: 'a1',
  });
  assert.deepEqual(Object.keys(proposed.snapshot.state.activeAction ?? {}).sort(), [
    'actionId',
    'actionKind',
    'effect',
    'host',
    'summary',
  ]);
  assert.equal('args' in (proposed.snapshot.state.activeAction ?? {}), false);
  assert.equal('selector' in (proposed.snapshot.state.activeAction ?? {}), false);
  assert.equal('coordinates' in (proposed.snapshot.state.activeAction ?? {}), false);

  assert.deepEqual(
    (await scenario([proposal('consequential'), { type: 'approval.requested', actionId: 'a1' }]))
      .projection,
    { kind: 'replan', reason: 'pending_action_discarded', actionId: 'a1' },
  );
  assert.deepEqual(
    (
      await scenario([
        proposal('consequential'),
        { type: 'approval.requested', actionId: 'a1' },
        { type: 'approval.resolved', actionId: 'a1', decision: 'approved' },
      ])
    ).projection,
    { kind: 'replan', reason: 'pending_action_discarded', actionId: 'a1' },
  );
});

test('ambiguous dispatch recovery matrix distinguishes reads from possible side effects', async () => {
  const read = await scenario([proposal('read'), { type: 'action.dispatching', actionId: 'a1' }]);
  assert.deepEqual(read.projection, {
    kind: 'replan',
    reason: 'read_only_dispatch_ambiguous',
    actionId: 'a1',
  });

  for (const effect of ['write', 'consequential'] as const) {
    const ambiguous = await scenario([
      proposal(effect),
      { type: 'action.dispatching', actionId: 'a1' },
    ]);
    assert.deepEqual(ambiguous.projection, {
      kind: 'recovery_required',
      reason: 'side_effect_may_have_occurred',
      actionId: 'a1',
    });
  }

  const explicitlyUnknown = await scenario([
    proposal('read'),
    { type: 'action.dispatching', actionId: 'a1' },
    {
      type: 'action.observed',
      actionId: 'a1',
      outcome: 'unknown',
      summary: 'Page closed before acknowledgement',
    },
  ]);
  assert.deepEqual(explicitlyUnknown.projection, {
    kind: 'recovery_required',
    reason: 'outcome_unknown',
    actionId: 'a1',
  });
});

test('a known action outcome returns to a clean replan boundary', async () => {
  for (const outcome of ['succeeded', 'failed'] as const) {
    const result = await scenario([
      proposal('write'),
      { type: 'action.dispatching', actionId: 'a1' },
      { type: 'action.observed', actionId: 'a1', outcome, summary: outcome },
    ]);
    assert.deepEqual(result.projection, { kind: 'replan', reason: 'clean_checkpoint' });
  }
});

test('sensitive unfinished journals are non-resumable regardless of action phase', async () => {
  const sensitive = await scenario(
    [proposal('read'), { type: 'action.dispatching', actionId: 'a1' }],
    'Sign in with password: hunter2-secret',
  );
  assert.equal(sensitive.snapshot.journal.sensitive, true);
  assert.deepEqual(sensitive.projection, {
    kind: 'non_resumable',
    reason: 'sensitive_journal',
  });

  const explicitlyMarked = await scenario([{ type: 'run.sensitive', reason: 'unknown' }]);
  assert.deepEqual(explicitlyMarked.projection, {
    kind: 'non_resumable',
    reason: 'sensitive_journal',
  });
});

test('terminal journals project their result and are never presented as resumable', async () => {
  for (const [type, status] of [
    ['run.completed', 'completed'],
    ['run.failed', 'failed'],
    ['run.stopped', 'stopped'],
  ] as const) {
    const result = await scenario([{ type, summary: `${status} summary` }]);
    assert.deepEqual(result.projection, {
      kind: 'terminal',
      status,
      summary: `${status} summary`,
    });
  }
});
