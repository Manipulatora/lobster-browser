import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  canSwitchThread,
  findSnapshotForThread,
  matchThreadHistory,
  resumeFailureEvent,
  threadExchanges,
} from './history.ts';

test('encrypted thread messages reconstruct tasks, outcomes, timestamps, and stable ids', () => {
  assert.deepEqual(
    threadExchanges([
      { role: 'compaction', content: 'older summary' },
      { role: 'user', content: 'first task', ts: '2026-08-03T10:00:00.000Z' },
      { role: 'assistant', content: 'first answer', status: 'done', turnId: 'turn-one' },
      { role: 'user', content: 'second task' },
      { role: 'assistant', content: 'could not finish', status: 'error', turnId: 'turn-two' },
      { role: 'assistant', content: 'orphaned and ignored' },
    ]),
    [
      {
        task: 'first task',
        response: 'first answer',
        status: 'done',
        startedAt: '2026-08-03T10:00:00.000Z',
        turnId: 'turn-one',
      },
      {
        task: 'second task',
        response: 'could not finish',
        status: 'error',
        turnId: 'turn-two',
      },
    ],
  );
});

test('missing-middle metadata matches by identity instead of shifting onto its neighbor', () => {
  const exchanges = [
    { task: 'first', response: 'A', status: 'done', turnId: 'id-a' },
    { task: 'middle', response: 'B', status: 'done', turnId: 'id-b' },
    { task: 'latest', response: 'C', status: 'done', turnId: 'id-c' },
  ];
  const result = matchThreadHistory(exchanges, [
    { status: 'done', turnId: 'id-a' },
    { status: 'done', turnId: 'id-c' },
  ]);
  assert.deepEqual(result.matches, [
    { exchangeIndex: 0, metadataIndex: 0 },
    { exchangeIndex: 2, metadataIndex: 1 },
  ]);
  assert.deepEqual(result.unmatchedExchangeIndices, [1]);
  assert.deepEqual(result.unmatchedMetadataIndices, []);
});

test('a latest legacy body retires only after one exact encrypted match', () => {
  const exchanges = [
    { task: 'older', response: 'A', status: 'done' },
    { task: 'latest', response: 'C', status: 'done' },
  ];
  const exact = matchThreadHistory(exchanges, [{ task: 'latest', response: 'C', status: 'done' }]);
  assert.deepEqual(exact.matches, [{ exchangeIndex: 1, metadataIndex: 0 }]);

  const ambiguous = matchThreadHistory(
    [
      { task: 'same', response: 'same', status: 'done' },
      { task: 'same', response: 'same', status: 'done' },
    ],
    [{ task: 'same', response: 'same', status: 'done' }],
  );
  assert.deepEqual(ambiguous.matches, []);
  assert.deepEqual(ambiguous.unmatchedMetadataIndices, [0]);
});

test('new-chat reopen ignores a retained snapshot from the previous thread', () => {
  const snapshots = [
    { sessionId: 'old-run', threadId: 'old-thread' },
    { sessionId: 'current-run', threadId: 'current-thread' },
  ];
  assert.equal(findSnapshotForThread(snapshots, 'new-thread'), undefined);
  assert.deepEqual(findSnapshotForThread(snapshots, 'current-thread'), snapshots[1]);
  assert.equal(
    findSnapshotForThread([{ sessionId: 'legacy-without-thread' }], 'current-thread'),
    undefined,
    'thread-less snapshots fail closed instead of leaking into the current chat',
  );
});

test('conversation switching is locked while a run still owns the rendered turn ids', () => {
  assert.equal(canSwitchThread(true, false, 'other-thread', 'current-thread'), false);
  assert.equal(canSwitchThread(false, true, 'other-thread', 'current-thread'), false);
  assert.equal(canSwitchThread(false, false, 'other-thread', 'current-thread'), true);
  assert.equal(canSwitchThread(false, false, 'current-thread', 'current-thread'), false);
  assert.equal(canSwitchThread(false, false, '', 'current-thread'), false);
});

test('a retained run that cannot reattach becomes a truthful terminal error', () => {
  assert.equal(resumeFailureEvent(true), null);
  assert.deepEqual(resumeFailureEvent(false), {
    type: 'run.finished',
    status: 'error',
    error:
      'Lobee could not reconnect to this retained run. It may still be active in the agent service; reconnect before starting another task.',
  });
});
