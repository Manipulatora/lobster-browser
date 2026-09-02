import assert from 'node:assert/strict';
import test from 'node:test';

import { FREE_PLAN_PROFILE_LIMIT } from '@lobster/shared-types';

import { accountProfileLimit, type AccountSubscription } from './account-profile-limit';

const future = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
const past = new Date(Date.now() - 1000).toISOString();

test('an account with no subscription rows is on the free allowance', () => {
  assert.equal(accountProfileLimit([]), FREE_PLAN_PROFILE_LIMIT);
});

test('the best LIVE entitlement wins; lapsed and cancelled packages add nothing', () => {
  const rows: AccountSubscription[] = [
    { status: 'trialing', profileLimit: FREE_PLAN_PROFILE_LIMIT, currentPeriodEnd: undefined },
    { status: 'active', profileLimit: 100, currentPeriodEnd: future },
    { status: 'active', profileLimit: 1000, currentPeriodEnd: past },
    { status: 'canceled', profileLimit: 200, currentPeriodEnd: future },
  ];

  assert.equal(accountProfileLimit(rows), 100);
});

test('three free teams are three profiles, not nine — the bypass the account rule closes', () => {
  const free: AccountSubscription = {
    status: 'trialing',
    profileLimit: FREE_PLAN_PROFILE_LIMIT,
    currentPeriodEnd: undefined,
  };

  assert.equal(accountProfileLimit([free, free, free]), FREE_PLAN_PROFILE_LIMIT);
});

test('a support-granted limit on a free-tier row still counts, and a limit below the free one is honoured as bought', () => {
  assert.equal(
    accountProfileLimit([{ status: 'active', profileLimit: 50, currentPeriodEnd: undefined }]),
    50,
  );
  assert.equal(
    accountProfileLimit([{ status: 'active', profileLimit: 2, currentPeriodEnd: future }]),
    2,
  );
});
