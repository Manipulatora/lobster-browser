import { expect, test } from '@playwright/test';

import type { AuthState, CloudUser } from '../src/api/auth';
import { AuthBootstrapGate } from '../src/features/auth/authBootstrap';

const cachedUser: CloudUser = { id: 'cached', email: 'cached@example.test' };
const cached: AuthState = { user: cachedUser, offline: false };
const signedOut: AuthState = { user: null, offline: false };

test('verified signed-out state wins regardless of cached response order', () => {
  const cachedFirst = new AuthBootstrapGate();
  const firstGeneration = cachedFirst.begin();
  expect(cachedFirst.acceptCached(firstGeneration, cached)).toEqual(cached);
  expect(cachedFirst.acceptNetwork(firstGeneration, signedOut)).toEqual(signedOut);

  const networkFirst = new AuthBootstrapGate();
  const secondGeneration = networkFirst.begin();
  expect(networkFirst.acceptNetwork(secondGeneration, signedOut)).toEqual(signedOut);
  expect(networkFirst.acceptCached(secondGeneration, cached)).toBeUndefined();
});

test('network completion alone never releases first paint before the local cache settles', () => {
  const gate = new AuthBootstrapGate();
  const generation = gate.begin();

  gate.acceptNetwork(generation, signedOut);
  expect(gate.readyForFirstPaint(generation)).toBe(false);
  expect(gate.markCachedSettled(generation)).toBe(true);
  expect(gate.readyForFirstPaint(generation)).toBe(true);
});

test('starting a new login invalidates an old-account boot response before login completes', () => {
  const gate = new AuthBootstrapGate();
  const oldGeneration = gate.begin();
  // App invokes this synchronously through AuthScreen.onAttemptStarted, before auth_sign_in IPC.
  gate.supersede();

  expect(gate.acceptCached(oldGeneration, cached)).toBeUndefined();
  expect(gate.acceptNetwork(oldGeneration, signedOut)).toBeUndefined();
});

test('a terminal unauthenticated attempt can rediscover the superseded valid session', () => {
  const gate = new AuthBootstrapGate();
  const abandonedBoot = gate.begin();
  gate.supersede();
  expect(gate.acceptNetwork(abandonedBoot, cached)).toBeUndefined();

  // App's terminal-attempt callback bumps authRefresh, whose effect begins this fresh generation.
  const recovery = gate.begin();
  expect(gate.acceptNetwork(recovery, cached)).toEqual(cached);
});

test('a restarted boot pass rejects responses from the abandoned pass', () => {
  const gate = new AuthBootstrapGate();
  const abandoned = gate.begin();
  const current = gate.begin();

  expect(gate.acceptCached(abandoned, cached)).toBeUndefined();
  expect(gate.acceptNetwork(abandoned, signedOut)).toBeUndefined();
  expect(gate.acceptCached(current, cached)).toEqual(cached);
});

test('offline verification retains a cached display identity in either response order', () => {
  const offline: AuthState = { user: null, offline: true };
  const cachedFirst = new AuthBootstrapGate();
  const firstGeneration = cachedFirst.begin();
  cachedFirst.acceptCached(firstGeneration, cached);
  expect(cachedFirst.acceptNetwork(firstGeneration, offline)).toEqual({
    user: cachedUser,
    offline: true,
  });

  const networkFirst = new AuthBootstrapGate();
  const secondGeneration = networkFirst.begin();
  networkFirst.acceptNetwork(secondGeneration, offline);
  expect(networkFirst.acceptCached(secondGeneration, cached)).toEqual({
    user: cachedUser,
    offline: true,
  });
});
