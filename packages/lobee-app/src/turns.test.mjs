import assert from 'node:assert/strict';
import { test } from 'node:test';

// turns.ts is deliberately React-free, so the reducer and the migration rules can be exercised
// directly. These are the parts where a mistake silently destroys someone's conversation.
const {
  applyEvent,
  mergeStoredMetadata,
  snapshotToTurn,
  storedToTurn,
  toStoredTurn,
  turnsFromThread,
} = await import('./turns.ts');

function running(overrides = {}) {
  return {
    id: 1,
    threadId: 't1',
    localRecord: true,
    needsSecureMigration: true,
    task: 'do the thing',
    status: 'running',
    statusText: 'Working…',
    steps: new Map(),
    answer: '',
    failure: '',
    streamed: false,
    tokensIn: 0,
    tokensOut: 0,
    cachedTokensIn: 0,
    memoryWarning: '',
    stopError: '',
    await: null,
    inputError: '',
    animateAnswer: false,
    ...overrides,
  };
}

test('a failure is never presented as an answer', () => {
  const failed = applyEvent(running({ answer: 'partial' }), {
    type: 'run.finished',
    status: 'error',
    error: 'the site refused the login',
  });
  assert.equal(failed.status, 'error');
  assert.equal(failed.failure, 'the site refused the login');
  assert.equal(failed.answer, 'partial');
  assert.equal(failed.animateAnswer, false);

  const empty = applyEvent(running(), { type: 'run.finished', status: 'error' });
  assert.equal(empty.failure, 'The run ended without a result.');
});

test('a streamed reply is never replayed through the typewriter', () => {
  const streamed = applyEvent(running(), { type: 'answer.delta', text: 'Hel' });
  assert.equal(streamed.answer, 'Hel');
  assert.equal(streamed.streamed, true);
  const finished = applyEvent(streamed, { type: 'run.finished', status: 'done', result: 'Hello' });
  assert.equal(finished.answer, 'Hello');
  assert.equal(finished.animateAnswer, false);

  // Nothing streamed, so the finished answer is the first time this text appears on screen.
  const atOnce = applyEvent(running(), { type: 'run.finished', status: 'done', result: 'Hello' });
  assert.equal(atOnce.animateAnswer, true);
});

test('steps carry the event timestamp and action kind for the rail dots', () => {
  let turn = applyEvent(running(), {
    type: 'step.thinking',
    step: 0,
    ts: '2026-08-27T10:00:00.000Z',
  });
  assert.equal(turn.steps.get(0).ts, '2026-08-27T10:00:00.000Z');
  assert.equal(turn.steps.get(0).kind, undefined);

  turn = applyEvent(turn, {
    type: 'step.action',
    step: 0,
    ts: '2026-08-27T10:00:01.000Z',
    action: { kind: 'navigate', url: 'https://example.com/plans' },
  });
  assert.equal(turn.steps.get(0).ts, '2026-08-27T10:00:01.000Z');
  assert.equal(turn.steps.get(0).kind, 'navigate');
  assert.equal(turn.steps.get(0).done, true);

  turn = applyEvent(turn, {
    type: 'step.observation',
    step: 0,
    ts: '2026-08-27T10:00:02.000Z',
    title: 'Pricing',
  });
  assert.equal(turn.steps.get(0).ts, '2026-08-27T10:00:02.000Z');
  assert.equal(turn.steps.get(0).kind, 'navigate', 'an observation never erases the action kind');
  assert.equal(turn.steps.get(0).ctx, 'Pricing');

  // Events without a timestamp (older sidecars) still reduce into a renderable step.
  const bare = applyEvent(running(), { type: 'step.action', step: 1, action: { kind: 'click' } });
  assert.equal(bare.steps.get(1).ts, undefined);
  assert.equal(bare.steps.get(1).kind, 'click');
});

test('finishing clears a pending stop question and settles the thinking step', () => {
  const stopping = applyEvent(running({ stopError: 'the stop did not land' }), {
    type: 'step.thinking',
    step: 0,
  });
  assert.equal(stopping.steps.get(0).thinking, true);
  const done = applyEvent(stopping, { type: 'run.finished', status: 'done', result: 'ok' });
  assert.equal(done.stopError, '');
  assert.equal(done.steps.get(0).thinking, false);
  assert.equal(done.steps.get(0).done, true);
});

test('usage accumulates instead of being discarded', () => {
  let turn = running();
  turn = applyEvent(turn, { type: 'usage', usage: { tokensIn: 10, tokensOut: 2 } });
  turn = applyEvent(turn, { type: 'usage', usage: { tokensIn: 5, cachedTokensIn: 4 } });
  assert.equal(turn.tokensIn, 15);
  assert.equal(turn.tokensOut, 2);
  assert.equal(turn.cachedTokensIn, 4);
});

test('degraded memory is surfaced without failing the run', () => {
  const turn = applyEvent(running(), { type: 'memory.degraded', scope: 'thread' });
  assert.equal(turn.status, 'running');
  assert.match(turn.memoryWarning, /could not be saved/);
});

test('only terminal, locally-owned turns are persisted, and bodies only while unverified', () => {
  assert.equal(toStoredTurn(running()), null);
  assert.equal(toStoredTurn(running({ status: 'done', localRecord: false })), null);

  const unverified = toStoredTurn(
    running({ status: 'done', answer: 'the reply', tokensIn: 7, needsSecureMigration: true }),
  );
  assert.equal(unverified.answer, 'the reply');
  assert.equal(unverified.needsSecureMigration, true);
  assert.equal(unverified.tokensIn, 7);

  // Once the encrypted copy is verified the local row keeps correlation metadata and nothing else.
  const verified = toStoredTurn(
    running({ status: 'done', answer: 'the reply', needsSecureMigration: false }),
  );
  assert.equal(verified.answer, undefined);
  assert.equal(verified.task, undefined);
  assert.equal(verified.threadId, 't1');
});

test('a stored legacy row round-trips into a renderable turn', () => {
  const turn = storedToTurn({
    id: 4,
    threadId: 't1',
    status: 'error',
    task: 'log in',
    answer: 'it refused',
    needsSecureMigration: true,
    steps: [{ label: 'Navigate', ctx: 'example.com' }],
  });
  assert.equal(turn.failure, 'it refused');
  assert.equal(turn.answer, '');
  assert.equal(turn.statusText, 'Failed');
  assert.equal(turn.stopError, '');
  assert.equal(turn.steps.get(0).label, 'Navigate');
});

test('a retained snapshot keeps its awaiting prompt and stays unverified', () => {
  const turn = snapshotToTurn(
    {
      sessionId: 's1',
      profileId: 'p1',
      task: 'book a table',
      status: 'awaiting_input',
      step: 2,
      startedAt: '2026-01-01T00:00:00.000Z',
      awaitingPrompt: 'Which time?',
      awaitingKind: 'ask',
    },
    9,
    't1',
  );
  assert.equal(turn.status, 'running');
  assert.equal(turn.statusText, 'Needs you');
  assert.equal(turn.await.prompt, 'Which time?');
  assert.equal(turn.needsSecureMigration, true);
});

test('metadata only merges onto the encrypted turn it actually verifies', () => {
  const encrypted = turnsFromThread(
    [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one', turnId: 'k1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'two', turnId: 'k2' },
    ],
    't1',
  );
  assert.equal(encrypted.length, 2);
  assert.equal(encrypted[0].needsSecureMigration, false);

  const merged = mergeStoredMetadata(encrypted, [
    storedToTurn({
      id: 41,
      threadId: 't1',
      status: 'done',
      task: 'second',
      answer: 'two',
      needsSecureMigration: true,
      tokensIn: 3,
    }),
  ]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, 41);
  assert.equal(merged[1].tokensIn, 3);
  // The exact body was found in the encrypted thread, so the local plaintext may now be retired.
  assert.equal(merged[1].needsSecureMigration, false);
  assert.equal(merged[0].localRecord, false);
});

test('metadata that verifies nothing is kept as its own row rather than shifted onto a neighbour', () => {
  const encrypted = turnsFromThread(
    [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'one' },
    ],
    't1',
  );
  const orphan = storedToTurn({
    id: 77,
    threadId: 't1',
    status: 'done',
    task: 'something else entirely',
    answer: 'and a different answer',
    needsSecureMigration: true,
  });
  const merged = mergeStoredMetadata(encrypted, [orphan]);
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, 77);
  assert.equal(merged[1].needsSecureMigration, true);
});

test('a step outcome becomes the brief line beside the rail dot', () => {
  let turn = applyEvent(running(), {
    type: 'step.action',
    step: 2,
    ts: '2026-09-02T10:00:01.000Z',
    action: { kind: 'browser_config', op: 'clear_session', site: 'outlook.com' },
  });
  turn = applyEvent(turn, {
    type: 'step.outcome',
    step: 2,
    ts: '2026-09-02T10:00:03.000Z',
    text: 'result: cleared 4 cookie(s) and site storage for outlook.com',
  });
  assert.equal(turn.steps.get(2).kind, 'browser_config');
  assert.match(turn.steps.get(2).outcome, /cleared 4 cookie/);
  assert.equal(turn.steps.get(2).ts, '2026-09-02T10:00:03.000Z');
  // An empty outcome never blanks a line the user already read.
  const kept = applyEvent(turn, { type: 'step.outcome', step: 2, text: '' });
  assert.match(kept.steps.get(2).outcome, /cleared 4 cookie/);
});

test('a mid-run message from the user lands in the rail between the steps', () => {
  let turn = applyEvent(running(), { type: 'step.action', step: 2, action: { kind: 'click' } });
  turn = applyEvent(turn, {
    type: 'run.steered',
    step: 2,
    ts: '2026-09-02T10:00:05.000Z',
    text: 'actually, boots not shoes',
  });
  turn = applyEvent(turn, { type: 'step.action', step: 3, action: { kind: 'navigate' } });
  const order = [...turn.steps.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s.kind);
  assert.deepEqual(order, ['click', 'steer', 'navigate']);
  assert.equal(turn.steps.get(2.5).label, 'actually, boots not shoes');
  assert.equal(turn.steps.get(2.5).done, true);
  // A second message in the same gap joins the row rather than replacing it.
  const twice = applyEvent(turn, { type: 'run.steered', step: 2, text: 'and size 42' });
  assert.equal(twice.steps.get(2.5).label, 'actually, boots not shoes\nand size 42');
  // An empty message changes nothing.
  assert.equal(applyEvent(turn, { type: 'run.steered', step: 2, text: '  ' }), turn);
});

test('streamed progress keeps the thinking step alive with a rough size, and never touches a settled one', () => {
  let turn = applyEvent(running(), {
    type: 'step.thinking',
    step: 3,
    ts: '2026-09-02T10:00:00.000Z',
  });
  turn = applyEvent(turn, { type: 'step.progress', step: 3, kind: 'reasoning', chars: 420 });
  assert.equal(turn.steps.get(3).label, 'Reasoning…');
  assert.equal(turn.steps.get(3).thinking, true);
  turn = applyEvent(turn, { type: 'step.progress', step: 3, kind: 'tool', chars: 2350 });
  assert.equal(turn.steps.get(3).label, 'Deciding… 2.4k');
  // Once the action lands the step is settled; late progress must not overwrite its line.
  turn = applyEvent(turn, {
    type: 'step.action',
    step: 3,
    action: { kind: 'click', note: 'open the inbox' },
  });
  const settled = turn.steps.get(3).label;
  const late = applyEvent(turn, { type: 'step.progress', step: 3, kind: 'text', chars: 9000 });
  assert.equal(late.steps.get(3).label, settled);
});
