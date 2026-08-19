import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemaphore } from './semaphore.js';

/** Resolve on demand, so a task's duration is decided by the test rather than by a timer. */
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

test('tasks beyond the limit wait instead of all starting at once', async () => {
  const semaphore = createSemaphore(2);
  const gates = [deferred(), deferred(), deferred()];
  const started: number[] = [];

  const runs = gates.map((gate, index) =>
    semaphore.run(async () => {
      started.push(index);
      await gate.promise;
      return index;
    }),
  );

  await Promise.resolve();
  assert.deepEqual(started, [0, 1]);
  assert.equal(semaphore.active, 2);
  assert.equal(semaphore.waiting, 1);

  gates[0]?.resolve();
  assert.deepEqual(await runs[0], 0);
  assert.deepEqual(started, [0, 1, 2]);

  gates[1]?.resolve();
  gates[2]?.resolve();
  assert.deepEqual(await Promise.all(runs), [0, 1, 2]);
  assert.equal(semaphore.active, 0);
  assert.equal(semaphore.waiting, 0);
});

test('a failing task releases its permit so the queue keeps moving', async () => {
  const semaphore = createSemaphore(1);
  const failing = semaphore.run(() => Promise.reject(new Error('launch failed')));
  const following = semaphore.run(() => Promise.resolve('ok'));

  await assert.rejects(failing, /launch failed/);
  assert.equal(await following, 'ok');
  assert.equal(semaphore.active, 0);
});

test('a nonsensical limit still admits one task rather than deadlocking', async () => {
  const semaphore = createSemaphore(0);
  assert.equal(await semaphore.run(() => Promise.resolve('ran')), 'ran');
});
