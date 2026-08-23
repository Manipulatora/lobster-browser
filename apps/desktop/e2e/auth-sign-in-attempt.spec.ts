import { expect, test } from '@playwright/test';

import { SignInAttemptGate } from '../src/features/auth/signInAttempt';

test('an accepted cancellation suppresses a late completion and is sent only once', async () => {
  const gate = new SignInAttemptGate('attempt-one');
  let calls = 0;
  const cancel = async (attemptId: string): Promise<boolean> => {
    calls += 1;
    expect(attemptId).toBe('attempt-one');
    return true;
  };

  const first = gate.requestCancel(cancel);
  const duplicate = gate.requestCancel(cancel);

  await expect(first).resolves.toBe(true);
  await expect(duplicate).resolves.toBe(true);
  await expect(gate.acceptsCompletion()).resolves.toBe(false);
  expect(calls).toBe(1);
});

test('a commit-winning or failed cancel leaves the real sign-in completion authoritative', async () => {
  const committed = new SignInAttemptGate('committed');
  await expect(committed.requestCancel(async () => false)).resolves.toBe(false);
  await expect(committed.acceptsCompletion()).resolves.toBe(true);

  const unconfirmed = new SignInAttemptGate('unconfirmed');
  await expect(
    unconfirmed.requestCancel(async () => {
      throw new Error('IPC unavailable');
    }),
  ).rejects.toThrow('IPC unavailable');
  await expect(unconfirmed.acceptsCompletion()).resolves.toBe(true);
});

test('an unconfirmed cancellation can be retried after IPC recovers', async () => {
  const gate = new SignInAttemptGate('retryable');
  let calls = 0;
  const cancel = async (): Promise<boolean> => {
    calls += 1;
    if (calls === 1) throw new Error('IPC unavailable');
    return true;
  };

  await expect(gate.requestCancel(cancel)).rejects.toThrow('IPC unavailable');
  await expect(gate.requestCancel(cancel)).resolves.toBe(true);
  await expect(gate.acceptsCompletion()).resolves.toBe(false);
  expect(calls).toBe(2);
});

test('attempt gates are isolated even when their operations overlap', async () => {
  const oldAttempt = new SignInAttemptGate('old');
  const newAttempt = new SignInAttemptGate('new');

  await oldAttempt.requestCancel(async () => true);

  await expect(oldAttempt.acceptsCompletion()).resolves.toBe(false);
  await expect(newAttempt.acceptsCompletion()).resolves.toBe(true);
});
