import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import { PLAN_CATALOG, planByTier } from '@lobster/shared-types';

import type { TeamsRepository } from '../teams/teams.repository';
import { BillingService } from './billing.service';
import { InMemoryBillingRepository } from './in-memory-billing.repository';
import type { CreatedDeposit, PaymentProvider } from './payments/payment-provider';
import { RenewalService } from './renewal.service';

const TEAM = 'team-1';
const USER = 'user-1';

/** Teams stub: USER belongs to TEAM and nothing else. */
function teamsStub(): TeamsRepository {
  return {
    findTeamsForUser: async (userId: string) =>
      userId === USER ? [{ id: TEAM, name: 'T', ownerUserId: USER, createdAt: '' }] : [],
    getMembership: async (teamId: string, userId: string) =>
      teamId === TEAM && userId === USER
        ? { teamId, userId, role: 'admin' as const, createdAt: '' }
        : null,
  } as unknown as TeamsRepository;
}

function paymentsStub(): PaymentProvider {
  let n = 0;
  return {
    name: 'stub',
    isConfigured: () => true,
    createDeposit: async (): Promise<CreatedDeposit> => {
      n += 1;
      return {
        providerPaymentId: `pay-${n}`,
        address: '0xabc',
        amountCrypto: '10.0',
        asset: 'USDT',
        chain: 'usdtbsc',
      };
    },
    verifyWebhook: () => null,
  };
}

function makeService(): { svc: BillingService; repo: InMemoryBillingRepository } {
  const repo = new InMemoryBillingRepository();
  const svc = new BillingService(repo, teamsStub(), paymentsStub());
  return { svc, repo };
}

/** Put `cents` of Credit into TEAM's wallet without going through a real deposit. */
async function fund(repo: InMemoryBillingRepository, cents: number): Promise<void> {
  await repo.move({ teamId: TEAM, kind: 'adjustment', amountCents: cents, description: 'test' });
}

// --- Pricing contract --------------------------------------------------------

test('plan catalog matches the agreed pricing', () => {
  assert.deepEqual(
    PLAN_CATALOG.map((p) => [p.tier, p.priceCents, p.profileLimit]),
    [
      ['light', 1_000, 10],
      ['plus', 6_000, 100],
      ['pro', 10_000, 200],
      ['max', 20_000, 1_000],
    ],
  );
});

// --- Credit arithmetic -------------------------------------------------------

test('a debit larger than the balance is refused and changes nothing', async () => {
  const { repo } = makeService();
  await fund(repo, 5_000);

  const refused = await repo.move({
    teamId: TEAM,
    kind: 'purchase',
    amountCents: -6_000,
    description: 'Plus',
  });

  assert.equal(refused, null);
  assert.equal(await repo.getBalanceCents(TEAM), 5_000, 'balance must be untouched');
});

test('the ledger reconciles against the cached balance', async () => {
  const { repo } = makeService();
  await fund(repo, 10_000);
  await repo.move({ teamId: TEAM, kind: 'purchase', amountCents: -6_000, description: 'Plus' });
  await fund(repo, 2_500);

  const rows = await repo.listTransactions(TEAM, 100);
  const summed = rows.reduce((acc, r) => acc + r.amountCents, 0);

  assert.equal(summed, await repo.getBalanceCents(TEAM));
  // Newest first, and each row records the balance it produced.
  assert.equal(rows[0]?.balanceAfterCents, 6_500);
});

// --- Purchase ----------------------------------------------------------------

test('purchase debits exactly the plan price and sets its profile limit', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 10_000);

  const sub = await svc.purchasePlan(USER, 'pro');

  assert.equal(sub.tier, 'pro');
  assert.equal(sub.profileLimit, 200);
  assert.equal(sub.priceCents, 10_000);
  assert.equal(sub.status, 'active');
  assert.equal(await repo.getBalanceCents(TEAM), 0);
});

test('purchase without enough Credit fails and grants nothing', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 9_999); // one cent short of Pro

  await assert.rejects(() => svc.purchasePlan(USER, 'pro'), BadRequestException);

  assert.equal(await repo.getBalanceCents(TEAM), 9_999, 'no partial charge');
  assert.equal(await repo.getSubscription(TEAM), null, 'no subscription granted');
});

test('two concurrent purchases cannot both succeed on one plan price', async () => {
  // The lost-update case the repository interface exists to prevent: both callers see an
  // affordable balance, and without an atomic check-and-decrement both would be granted.
  const { svc, repo } = makeService();
  await fund(repo, 10_000); // enough for exactly one Pro

  const results = await Promise.allSettled([
    svc.purchasePlan(USER, 'pro'),
    svc.purchasePlan(USER, 'pro'),
  ]);

  const fulfilled = results.filter((r) => r.status === 'fulfilled');
  assert.equal(fulfilled.length, 1, 'exactly one purchase may succeed');
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'balance must never go negative');
});

test('buying the same active plan twice is rejected', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'pro');

  await assert.rejects(() => svc.purchasePlan(USER, 'pro'), ConflictException);
});

test('switching packages credits back the unused part of the current period', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'light'); // -1_000 → 29_000, 30 days ahead

  // Halfway through the period: half of Light's $10 is unused.
  await repo.activateSubscription({
    teamId: TEAM,
    tier: 'light',
    profileLimit: 10,
    priceCents: 1_000,
    currentPeriodEnd: new Date(Date.now() + 15 * 24 * 3600 * 1000),
  });

  await svc.purchasePlan(USER, 'pro'); // $100 less ~$5 unused Light

  const balance = await repo.getBalanceCents(TEAM);
  // 29_000 - (10_000 - ~500). Floored proration, so allow a cent of slack for clock movement.
  assert.ok(
    Math.abs(balance - 19_500) <= 2,
    `expected ~19_500 after prorated switch, got ${balance}`,
  );
  assert.equal((await repo.getSubscription(TEAM))?.profileLimit, 200);
});

test('a downgrade worth more than the new plan lands as a refund, not a negative charge', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'max'); // -20_000 → 10_000

  // Almost the whole Max period unused: ~$200 of credit against a $10 Light plan.
  await repo.activateSubscription({
    teamId: TEAM,
    tier: 'max',
    profileLimit: 1_000,
    priceCents: 20_000,
    currentPeriodEnd: new Date(Date.now() + 30 * 24 * 3600 * 1000),
  });

  await svc.purchasePlan(USER, 'light');

  const balance = await repo.getBalanceCents(TEAM);
  // 10_000 + (20_000 - 1_000) = 29_000, give or take the floor.
  assert.ok(Math.abs(balance - 29_000) <= 2, `expected ~29_000, got ${balance}`);

  const [latest] = await repo.listTransactions(TEAM, 1);
  assert.equal(latest?.kind, 'refund', 'a net credit must be recorded as a refund');
  assert.ok(latest!.amountCents > 0, 'a refund must be a positive movement');
});

test('a lapsed subscription earns no unused-time credit', async () => {
  // past_due means the last renewal was NOT paid, so there is no paid period to refund. Crediting
  // one would hand out money for time that was never bought.
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'pro'); // balance 0
  await expire(repo, 1);
  await renewal(repo).sweep(); // lapses to past_due

  await fund(repo, 1_000);
  await svc.purchasePlan(USER, 'light');

  assert.equal(await repo.getBalanceCents(TEAM), 0, 'charged Light in full, no proration credit');
});

test('a caller cannot spend a team they do not belong to', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 30_000);

  await assert.rejects(() => svc.purchasePlan(USER, 'pro', 'someone-elses-team'), ForbiddenException);
});

// --- Deposits ----------------------------------------------------------------

test('a deposit credits once, and duplicate webhook deliveries are no-ops', async () => {
  const { svc, repo } = makeService();
  const instruction = await svc.createDeposit(USER, 5_000, 'usdtbsc');
  assert.equal(instruction.amountCents, 5_000);

  const event = {
    providerPaymentId: 'pay-1',
    status: 'confirmed' as const,
    creditCents: 5_000,
    raw: {},
  };

  assert.equal(await svc.applyWebhook(event), true, 'first delivery credits');
  assert.equal(await svc.applyWebhook(event), false, 'redelivery is a no-op');
  assert.equal(await svc.applyWebhook(event), false, 'and stays a no-op');

  assert.equal(await repo.getBalanceCents(TEAM), 5_000, 'credited exactly once');
});

test('a non-final webhook records status without crediting', async () => {
  const { svc, repo } = makeService();
  await svc.createDeposit(USER, 5_000, 'usdtbsc');

  const credited = await svc.applyWebhook({
    providerPaymentId: 'pay-1',
    status: 'confirming',
    raw: {},
  });

  assert.equal(credited, false);
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'unconfirmed money is not spendable');
});

test('deposits below the minimum and on unknown chains are refused', async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.createDeposit(USER, 100, 'usdtbsc'), BadRequestException);
  await assert.rejects(() => svc.createDeposit(USER, 5_000, 'dogecash'), BadRequestException);
});

// --- Renewal -----------------------------------------------------------------

function renewal(repo: InMemoryBillingRepository, intervalMs = '0'): RenewalService {
  const config = { get: () => intervalMs } as unknown as ConfigService;
  return new RenewalService(repo, config);
}

/** Move a subscription's period end into the past so a sweep considers it due. */
async function expire(repo: InMemoryBillingRepository, daysAgo: number): Promise<void> {
  const sub = await repo.getSubscription(TEAM);
  assert.ok(sub);
  const past = new Date(Date.now() - daysAgo * 24 * 3600 * 1000);
  await repo.activateSubscription({
    teamId: TEAM,
    tier: sub.tier as 'pro',
    profileLimit: sub.profileLimit,
    priceCents: sub.priceCents,
    currentPeriodEnd: past,
  });
}

test('a due subscription renews by debiting Credit again', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 25_000);
  await svc.purchasePlan(USER, 'pro'); // -10_000 → 15_000
  await expire(repo, 1);

  const result = await renewal(repo).sweep();

  assert.equal(result.renewed, 1);
  assert.equal(await repo.getBalanceCents(TEAM), 5_000, 'a second month was charged');
  assert.equal((await repo.getSubscription(TEAM))?.status, 'active');
});

test('a renewal with insufficient Credit lapses to past_due without charging', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'pro'); // balance now 0
  await expire(repo, 1);

  const result = await renewal(repo).sweep();

  assert.equal(result.lapsed, 1);
  assert.equal(await repo.getBalanceCents(TEAM), 0);
  const sub = await repo.getSubscription(TEAM);
  assert.equal(sub?.status, 'past_due');
  assert.equal(sub?.lastFailureCode, 'insufficient_credit');
});

test('a lapsed subscription recovers on the next sweep once Credit arrives', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'pro');
  await expire(repo, 1);
  await renewal(repo).sweep(); // lapses

  await fund(repo, 10_000); // user deposits

  const result = await renewal(repo).sweep();

  assert.equal(result.renewed, 1, 'past_due rows must stay eligible');
  assert.equal((await repo.getSubscription(TEAM))?.status, 'active');
  assert.equal(await repo.getBalanceCents(TEAM), 0);
});

test('a long lapse is not billed retroactively', async () => {
  // The catch-up trap: anchoring the new period to the OLD period end leaves it still in the past
  // after a long lapse, so every subsequent sweep charges another month. A team returning after
  // four months would have a fresh deposit consumed instantly by back-charges for service they
  // never received.
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'pro');
  await expire(repo, 120); // four months in the past
  await fund(repo, 50_000);

  const svcUnderTest = renewal(repo);
  const first = await svcUnderTest.sweep();
  const second = await svcUnderTest.sweep();

  assert.equal(first.renewed, 1);
  assert.equal(second.renewed, 0, 'the second sweep must find nothing due');
  assert.equal(await repo.getBalanceCents(TEAM), 40_000, 'charged for one month, not four');

  const end = new Date((await repo.getSubscription(TEAM))!.currentPeriodEnd!);
  assert.ok(end.getTime() > Date.now(), 'the new period must be in the future');
});

test('auto-renew off means the sweep leaves it alone', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'pro');
  await svc.setAutoRenew(USER, false);
  await expire(repo, 1);
  // activateSubscription resets autoRenew, so turn it back off after re-anchoring the period.
  await repo.setAutoRenew(TEAM, false);

  const result = await renewal(repo).sweep();

  assert.equal(result.examined, 0);
  assert.equal(await repo.getBalanceCents(TEAM), 20_000, 'no charge');
});

test('renewal charges the snapshotted price, not the current catalog price', async () => {
  const { repo } = makeService();
  await fund(repo, 30_000);
  // A team on a grandfathered price: Pro is $100 today, they pay $70.
  await repo.activateSubscription({
    teamId: TEAM,
    tier: 'pro',
    profileLimit: planByTier('pro').profileLimit,
    priceCents: 7_000,
    currentPeriodEnd: new Date(Date.now() - 1000),
  });

  await renewal(repo).sweep();

  assert.equal(await repo.getBalanceCents(TEAM), 23_000, 'charged 7_000, not the catalog 10_000');
});
