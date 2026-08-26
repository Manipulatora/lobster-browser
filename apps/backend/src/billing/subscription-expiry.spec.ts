import assert from 'node:assert/strict';
import { test } from 'node:test';

import { planEntitledTier } from '@lobster/shared-types';

import { InMemoryBillingRepository } from './in-memory-billing.repository';
import { RenewalService } from './renewal.service';

/**
 * The half of the subscription lifecycle that did not exist.
 *
 * `findDueForRenewal` selects only `autoRenew: true` rows, and nothing in the codebase ever wrote
 * `status: 'canceled'`. So a package whose auto-renew was switched off kept `status='active'` at
 * its paid tier forever once its window closed, and the agent gate — which tested `status` alone —
 * went on selling agent time against a plan that had stopped being paid for.
 */

const HOUR = 60 * 60 * 1000;

function repoWithLapsedPlan(autoRenew: boolean) {
  const repo = new InMemoryBillingRepository();
  const now = new Date('2026-08-26T12:00:00.000Z');
  const started = new Date(now.getTime() - 30 * 24 * HOUR);
  const ended = new Date(now.getTime() - HOUR); // one hour into the past
  return {
    repo,
    now,
    ended,
    seed: async () => {
      await repo.activateSubscription({
        teamId: 'team-1',
        tier: 'pro',
        profileLimit: 25,
        priceCents: 2900,
        billingPeriod: 'monthly',
        billingAnchorDay: 26,
        currentPeriodStart: started,
        currentPeriodEnd: ended,
      });
      if (!autoRenew) await repo.setAutoRenew('team-1', false);
    },
  };
}

function sweeper(repo: InMemoryBillingRepository) {
  // The interval config is only read in onModuleInit, which the sweep itself does not need.
  return new RenewalService(repo, {
    get: () => undefined,
  } as unknown as ConstructorParameters<typeof RenewalService>[1]);
}

test('a package with auto-renew off is ended once its window closes', async () => {
  const { repo, now, seed } = repoWithLapsedPlan(false);
  await seed();

  const before = await repo.getSubscription('team-1');
  assert.equal(before?.status, 'active', 'precondition: the row still claims to be active');
  assert.equal(before?.tier, 'pro');

  const result = await sweeper(repo).sweep(now);
  assert.equal(result.expired, 1, 'the sweep ends exactly the one lapsed package');

  const after = await repo.getSubscription('team-1');
  assert.equal(after?.status, 'canceled');
  assert.equal(after?.tier, 'free', 'the tier drops, so the agent gate stops honouring it');
  assert.equal(after?.priceCents, 0);
});

test('a package with auto-renew ON is left to the renewal pass, never expired', async () => {
  const { repo, now, seed } = repoWithLapsedPlan(true);
  await seed();

  const result = await sweeper(repo).sweep(now);
  assert.equal(result.expired, 0, 'expiry must not steal rows the renewal pass owns');
  // It is the renewal pass that touched it: either renewed, or lapsed for want of Credit.
  assert.equal(result.examined, 1);
});

test('expiry is compare-and-swapped, so a second concurrent sweep is a no-op', async () => {
  const { repo, now, ended, seed } = repoWithLapsedPlan(false);
  await seed();

  const first = await repo.expireSubscription({
    teamId: 'team-1',
    expectedPeriodEnd: ended.toISOString(),
  });
  const second = await repo.expireSubscription({
    teamId: 'team-1',
    expectedPeriodEnd: ended.toISOString(),
  });
  assert.equal(first, 'expired');
  assert.equal(second, 'not_due', 'the row has already moved; the loser must not re-apply');
});

test('planEntitledTier lapses on the period end, not on the status field', () => {
  const now = new Date('2026-08-26T12:00:00.000Z');
  const past = new Date(now.getTime() - HOUR).toISOString();
  const future = new Date(now.getTime() + HOUR).toISOString();

  // The exact shape the bug produced: active, paid tier, window closed.
  assert.equal(
    planEntitledTier({ status: 'active', tier: 'pro', currentPeriodEnd: past }, now),
    'free',
    'an elapsed window buys no agent time, whatever the row says',
  );
  assert.equal(
    planEntitledTier({ status: 'active', tier: 'pro', currentPeriodEnd: future }, now),
    'pro',
  );
  // A trial is a granted period, exactly as entitledProfileLimit treats it.
  assert.equal(
    planEntitledTier({ status: 'trialing', tier: 'pro', currentPeriodEnd: future }, now),
    'pro',
  );
  assert.equal(
    planEntitledTier({ status: 'past_due', tier: 'pro', currentPeriodEnd: future }, now),
    'free',
  );
  assert.equal(planEntitledTier(null, now), 'free');
  // A row with no period end at all is open-ended, not expired.
  assert.equal(planEntitledTier({ status: 'active', tier: 'pro' }, now), 'pro');
});
