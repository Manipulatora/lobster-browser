import assert from 'node:assert/strict';
import { test } from 'node:test';

import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  classifyPlanChange,
  entitledProfileLimit,
  FREE_PLAN_PROFILE_LIMIT,
  PLAN_CATALOG,
  planByTier,
  planChangeAllowed,
  yearlyPriceCents,
  type BillingPeriod,
  type PaidPlanTier,
  type PlanTier,
} from '@lobster/shared-types';

import type { UsersRepository } from '../auth/users.repository';
import type { MailService } from '../mail/mail.service';
import type { TeamsRepository } from '../teams/teams.repository';
import { subtractPeriod } from './billing-period';
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
    listMembers: async (teamId: string) =>
      teamId === TEAM ? [{ teamId, userId: USER, role: 'admin' as const, createdAt: '' }] : [],
  } as unknown as TeamsRepository;
}

function usersStub(): UsersRepository {
  return {
    findById: async (id: string) =>
      id === USER ? { id, email: 'payer@gmail.com', passwordHash: '', createdAt: '' } : null,
  } as unknown as UsersRepository;
}

/** Records the receipts the service asked for, so "was the user told" is assertable. */
interface MailStub extends MailService {
  receipts: Array<{ to: string; amount: string; balance: string }>;
}

function mailStub(): MailStub {
  const receipts: MailStub['receipts'] = [];
  return {
    receipts,
    isConfigured: () => true,
    sendDepositReceipt: async (to: string, amount: string, balance: string) => {
      receipts.push({ to, amount, balance });
      return true;
    },
  } as unknown as MailStub;
}

function paymentsStub(paymentTag?: string): PaymentProvider {
  let n = 0;
  return {
    name: 'stub',
    isConfigured: () => true,
    supportsCurrency: () => true,
    createDeposit: async (): Promise<CreatedDeposit> => {
      n += 1;
      return {
        providerPaymentId: `pay-${n}`,
        address: '0xabc',
        // Absent unless a test asks for one — the ordinary chain has no tag, and a stub that
        // always carried one would let a plain `paymentTag: 'x'` pass for threading it through.
        paymentTag,
        amountCrypto: '10.0',
        asset: 'USDT',
        chain: 'usdtbsc',
      };
    },
    verifyWebhook: () => null,
    fetchPayment: async () => null,
  };
}

function makeService(paymentTag?: string): {
  svc: BillingService;
  repo: InMemoryBillingRepository;
  mail: MailStub;
} {
  const repo = new InMemoryBillingRepository();
  const mail = mailStub();
  const svc = new BillingService(repo, teamsStub(), paymentsStub(paymentTag), usersStub(), mail);
  return { svc, repo, mail };
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

test('a year costs twelve months less the advertised twenty per cent', () => {
  // The pricing page prints these figures from its own copy of the numbers, so they are a contract
  // rather than an implementation detail: a rounding change here is a wrong price on the storefront.
  assert.deepEqual(
    PLAN_CATALOG.map((p) => [p.tier, yearlyPriceCents(p)]),
    [
      ['light', 9_600],
      ['plus', 57_600],
      ['pro', 96_000],
      ['max', 192_000],
    ],
  );
});

test('the plan-change policy, every case', () => {
  // The whole policy in one table, because it is a product decision rather than an implementation
  // detail: three of these are charged and three are refused, and which is which is what the
  // storefront's buttons, the confirmation dialog and the purchase endpoint all resolve through.
  const live = (tier: PlanTier, period: BillingPeriod) => ({ tier, period, live: true });
  const target = (tier: PaidPlanTier, period: BillingPeriod) => ({ tier, period });

  // Nothing live: every package is a plain purchase, including one smaller than the lapsed row.
  assert.equal(
    classifyPlanChange({ tier: 'free', period: 'monthly', live: false }, target('pro', 'monthly')),
    'new',
  );
  assert.equal(
    classifyPlanChange({ tier: 'max', period: 'monthly', live: false }, target('light', 'monthly')),
    'new',
  );

  // Live, and moving up — the two that are charged.
  assert.equal(classifyPlanChange(live('light', 'monthly'), target('pro', 'monthly')), 'upgrade');
  assert.equal(classifyPlanChange(live('light', 'yearly'), target('pro', 'yearly')), 'upgrade');
  assert.equal(classifyPlanChange(live('pro', 'monthly'), target('pro', 'yearly')), 'extend');

  // Live, and not moving up — the three that are refused.
  assert.equal(classifyPlanChange(live('pro', 'monthly'), target('pro', 'monthly')), 'same');
  assert.equal(classifyPlanChange(live('pro', 'yearly'), target('pro', 'yearly')), 'same');
  assert.equal(classifyPlanChange(live('max', 'monthly'), target('light', 'monthly')), 'downgrade');
  assert.equal(classifyPlanChange(live('max', 'yearly'), target('light', 'yearly')), 'downgrade');
  // A bigger package on a shorter term is still a shortening: the year is what was paid for.
  assert.equal(classifyPlanChange(live('light', 'yearly'), target('max', 'monthly')), 'shorten');
  assert.equal(classifyPlanChange(live('pro', 'yearly'), target('pro', 'monthly')), 'shorten');

  assert.deepEqual(
    (['new', 'upgrade', 'extend', 'same', 'downgrade', 'shorten'] as const).map(planChangeAllowed),
    [true, true, true, false, false, false],
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
  await svc.purchasePlan(USER, 'light'); // -1_000 → 29_000, one month ahead

  // Exactly halfway through a 30-day period: half of Light's $10 is unused.
  await repo.activateSubscription({
    teamId: TEAM,
    tier: 'light',
    profileLimit: 10,
    priceCents: 1_000,
    billingPeriod: 'monthly',
    billingAnchorDay: 1,
    currentPeriodStart: new Date(Date.now() - 15 * 24 * 3600 * 1000),
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

test('a downgrade is refused while the bigger package is still paid for', async () => {
  // THE POLICY, and the reason it is a refusal rather than a prorated refund: applying it would
  // hand back most of a period as Credit AND withdraw 990 profiles the team is using, mid-month.
  // There is exactly one way to spend less — auto-renew off, then buy the smaller package when the
  // current one runs out — which is also the only way to reach the free tier.
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'max'); // -20_000 → 10_000, a live month of Max

  await assert.rejects(() => svc.purchasePlan(USER, 'light'), ConflictException);

  assert.equal(await repo.getBalanceCents(TEAM), 10_000, 'a refused change moves no Credit');
  assert.equal((await repo.getSubscription(TEAM))?.tier, 'max', 'and leaves the package alone');
});

test('leaving a prepaid year for a monthly term is refused, even for a bigger package', async (t) => {
  // Tier-wise this is an upgrade; term-wise it abandons eleven months already paid for and would
  // return them as Credit. The yearly term is the one that has to be answered for, so Max YEARLY
  // is the move that is open — and it is.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-06-05T10:00:00.000Z') });
  const { svc, repo } = makeService();
  const year = yearlyPriceCents(planByTier('plus'));
  await fund(repo, 400_000);
  await svc.purchasePlan(USER, 'plus', 'yearly');
  const afterPlus = await repo.getBalanceCents(TEAM);

  await assert.rejects(() => svc.purchasePlan(USER, 'max', 'monthly'), ConflictException);
  assert.equal(await repo.getBalanceCents(TEAM), afterPlus, 'nothing was charged');

  const max = await svc.purchasePlan(USER, 'max', 'yearly');
  assert.equal(max.tier, 'max');
  assert.equal(max.billingPeriod, 'yearly');
  // The whole Plus year is unused to the cent, so Max costs its year less that year.
  assert.equal(
    await repo.getBalanceCents(TEAM),
    afterPlus - (yearlyPriceCents(planByTier('max')) - year),
  );
});

test('the smaller package can be bought once the period it replaces has run out', async () => {
  // The other half of the downgrade policy: refusing mid-period would be a dead end if the wait
  // did not actually open the door. An elapsed period owes nothing back, so this is a plain
  // purchase at the list price.
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'max'); // -20_000 → 10_000
  await expire(repo, 1);

  const light = await svc.purchasePlan(USER, 'light');

  assert.equal(light.tier, 'light');
  assert.equal(light.profileLimit, 10);
  assert.equal(await repo.getBalanceCents(TEAM), 9_000, 'charged Light in full, nothing credited');
});

test('an upgrade the balance cannot cover is refused without charging or changing the package', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'light'); // -1_000 → 9_000, a live month of Light

  // Max is $200; a whole unused month of Light is worth $10 at most, so $9,000 is far short.
  await assert.rejects(() => svc.purchasePlan(USER, 'max'), BadRequestException);

  assert.equal(await repo.getBalanceCents(TEAM), 9_000, 'no partial charge');
  const sub = await repo.getSubscription(TEAM);
  assert.equal(sub?.tier, 'light', 'the package they paid for is untouched');
  assert.equal(sub?.profileLimit, 10);
});

test('a double-submitted upgrade is charged once, not twice', async (t) => {
  // The double-click, and the reason the debit and the period write are one transaction. Both
  // requests read the same live Light period, both price the same upgrade, and both find the
  // balance sufficient — so nothing in the service alone can tell them apart.
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-04-10T09:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'light'); // -1_000 → 29_000

  const results = await Promise.allSettled([
    svc.purchasePlan(USER, 'pro'),
    svc.purchasePlan(USER, 'pro'),
  ]);

  assert.equal(
    results.filter((r) => r.status === 'fulfilled').length,
    1,
    'exactly one upgrade may be applied',
  );
  // 29_000 less Pro's $100, itself less the whole unused month of Light the upgrade credits back.
  assert.equal(await repo.getBalanceCents(TEAM), 20_000, 'one Pro charge, not two');
  const purchases = (await repo.listTransactions(TEAM, 100)).filter((tx) => tx.kind === 'purchase');
  assert.equal(purchases.length, 2, 'the Light purchase and one Pro upgrade');
});

test('a quote states the figure the purchase then charges, and the balance it leaves', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-31T12:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'light'); // -1_000 → 29_000, runs to 2026-02-28

  t.mock.timers.tick(10 * 24 * 3600 * 1000); // 2026-02-10T12:00Z

  const quote = await svc.quotePlanChange(USER, 'pro');

  assert.equal(quote.kind, 'upgrade');
  assert.equal(quote.allowed, true);
  assert.equal(quote.priceCents, 10_000);
  assert.equal(quote.unusedCreditCents, 642, '18 of Light’s 28 days are unused');
  assert.equal(quote.dueCents, 10_000 - 642);
  assert.equal(quote.balanceCents, 29_000);
  assert.equal(quote.balanceAfterCents, 29_000 - (10_000 - 642));
  assert.equal(quote.shortfallCents, 0);
  assert.equal(quote.currentTier, 'light');
  assert.equal(quote.currentPeriodEnd, '2026-02-28T12:00:00.000Z');
  assert.equal(quote.nextBillingAt, '2026-03-10T12:00:00.000Z');

  await svc.purchasePlan(USER, 'pro');
  assert.equal(
    await repo.getBalanceCents(TEAM),
    quote.balanceAfterCents,
    'the quote is the charge',
  );
});

test('a quote for a refused change explains it instead of pricing a proration', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'max');

  const down = await svc.quotePlanChange(USER, 'light');
  assert.equal(down.kind, 'downgrade');
  assert.equal(down.allowed, false);
  assert.equal(
    down.unusedCreditCents,
    0,
    'no credit is quoted against a change that cannot happen',
  );
  assert.equal(down.dueCents, 1_000, 'what it will cost when the current package ends');

  const same = await svc.quotePlanChange(USER, 'max');
  assert.equal(same.kind, 'same');
  assert.equal(same.allowed, false);

  const extend = await svc.quotePlanChange(USER, 'max', 'yearly');
  assert.equal(extend.kind, 'extend');
  assert.equal(extend.allowed, true);
});

test('a quote tells an empty wallet how much more Credit it needs', async () => {
  const { svc, repo } = makeService();
  await fund(repo, 2_500);

  const quote = await svc.quotePlanChange(USER, 'plus');

  assert.equal(quote.kind, 'new');
  assert.equal(quote.allowed, true, 'affording it is a separate question from being allowed it');
  assert.equal(quote.dueCents, 6_000);
  assert.equal(quote.shortfallCents, 3_500);
  assert.equal(quote.balanceAfterCents, -3_500);
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

  await assert.rejects(
    () => svc.purchasePlan(USER, 'pro', 'monthly', 'someone-elses-team'),
    ForbiddenException,
  );
});

// --- Deposits ----------------------------------------------------------------

test('a memo chain hands the destination tag to the user and keeps it on the row', async () => {
  // The tag is what identifies the depositor: those chains share ONE deposit address across every
  // payment, so a transfer that arrives without it credits nobody and cannot be recovered. It has
  // to reach the page the user pays from, and it has to survive on the row a dispute is settled
  // against — losing it at either end loses the money.
  const { svc, repo } = makeService('648105598');
  const instruction = await svc.createDeposit(USER, 5_000, 'usdtbsc');

  assert.equal(instruction.paymentTag, '648105598');
  assert.equal((await repo.listDeposits(TEAM, 10))[0].paymentTag, '648105598');
});

test('a chain without a tag carries none, so the page has nothing to render', async () => {
  const { svc, repo } = makeService();
  const instruction = await svc.createDeposit(USER, 5_000, 'usdtbsc');

  assert.equal(instruction.paymentTag, undefined);
  assert.equal((await repo.listDeposits(TEAM, 10))[0].paymentTag, undefined);
});

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

test('a refund after settlement takes the Credit back with it', async () => {
  const { svc, repo } = makeService();
  await svc.createDeposit(USER, 5_000, 'usdtbsc');

  await svc.applyWebhook({
    providerPaymentId: 'pay-1',
    status: 'confirmed',
    creditCents: 5_000,
    raw: {},
  });
  assert.equal(await repo.getBalanceCents(TEAM), 5_000);

  // NOWPayments maps both `refunded` and `failed` onto this status. The money went back to the
  // user; keeping the Credit would be paying for the same deposit twice.
  const refund = { providerPaymentId: 'pay-1', status: 'failed' as const, raw: {} };
  assert.equal(await svc.applyWebhook(refund), false);
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'the credit is clawed back');

  // Processors redeliver. The second one must not debit again.
  await svc.applyWebhook(refund);
  await svc.applyWebhook(refund);
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'reversal is exactly-once');

  const ledger = await repo.listTransactions(TEAM, 10);
  const reversals = ledger.filter((t) => t.metadata?.reason === 'deposit_reversed');
  assert.equal(reversals.length, 1, 'exactly one reversing ledger row');
  assert.equal(reversals[0]?.amountCents, -5_000);
});

test('a refund of Credit that was already spent claws back what it can, and no more', async () => {
  const { svc, repo } = makeService();
  await svc.createDeposit(USER, 5_000, 'usdtbsc');
  await svc.applyWebhook({
    providerPaymentId: 'pay-1',
    status: 'confirmed',
    creditCents: 5_000,
    raw: {},
  });
  // The user buys Light for $10 before the refund lands.
  await svc.purchasePlan(USER, 'light');
  assert.equal(await repo.getBalanceCents(TEAM), 4_000);

  await svc.applyWebhook({ providerPaymentId: 'pay-1', status: 'failed', raw: {} });

  // A negative wallet is a debt with no way to collect it; the shortfall is logged for a human
  // instead of invented into the balance.
  assert.equal(await repo.getBalanceCents(TEAM), 0);
});

test('a failed deposit that never credited is only a status change', async () => {
  const { svc, repo } = makeService();
  await svc.createDeposit(USER, 5_000, 'usdtbsc');
  await fund(repo, 2_000);

  assert.equal(
    await svc.applyWebhook({ providerPaymentId: 'pay-1', status: 'failed', raw: {} }),
    false,
  );

  assert.equal(await repo.getBalanceCents(TEAM), 2_000, 'unrelated Credit is untouched');
  const deposit = await repo.findDepositByProviderId('stub:pay-1');
  assert.equal(deposit?.status, 'failed');
});

test('a settled deposit sends the payer a receipt naming the amount and the new balance', async () => {
  const { svc, mail } = makeService();
  await svc.createDeposit(USER, 5_000, 'usdtbsc');

  await svc.applyWebhook({
    providerPaymentId: 'pay-1',
    status: 'confirmed',
    creditCents: 5_000,
    raw: {},
  });

  assert.deepEqual(mail.receipts, [{ to: 'payer@gmail.com', amount: '$50.00', balance: '$50.00' }]);

  // A redelivery credits nothing, so it must not send a second receipt either.
  await svc.applyWebhook({
    providerPaymentId: 'pay-1',
    status: 'confirmed',
    creditCents: 5_000,
    raw: {},
  });
  assert.equal(mail.receipts.length, 1);
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
  const period = sub.billingPeriod ?? 'monthly';
  await repo.activateSubscription({
    teamId: TEAM,
    tier: sub.tier as 'pro',
    profileLimit: sub.profileLimit,
    priceCents: sub.priceCents,
    billingPeriod: period,
    // The team's billing day is unchanged by being moved into the past — only the period is.
    billingAnchorDay: sub.billingAnchorDay ?? past.getUTCDate(),
    currentPeriodStart: subtractPeriod(past, period),
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
  const ended = new Date(Date.now() - 1000);
  await repo.activateSubscription({
    teamId: TEAM,
    tier: 'pro',
    profileLimit: planByTier('pro').profileLimit,
    priceCents: 7_000,
    billingPeriod: 'monthly',
    billingAnchorDay: ended.getUTCDate(),
    currentPeriodStart: subtractPeriod(ended, 'monthly'),
    currentPeriodEnd: ended,
  });

  await renewal(repo).sweep();

  assert.equal(await repo.getBalanceCents(TEAM), 23_000, 'charged 7_000, not the catalog 10_000');
});

// --- Calendar billing --------------------------------------------------------
//
// The clock is frozen for these, and every date is written out in full. A billing day that walks is
// invisible in a test that computes its expectation the same way the code does.

test('a purchase at 23:00 UTC bills on the calendar day it charged, not the next one', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-15T23:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 10_000);

  const sub = await svc.purchasePlan(USER, 'pro');

  assert.equal(sub.billingAnchorDay, 15, 'the day the charge landed, read in UTC');
  assert.equal(sub.currentPeriodStart, '2026-03-15T23:00:00.000Z');
  assert.equal(sub.currentPeriodEnd, '2026-04-15T23:00:00.000Z');
});

test('a January 31st package bills on February 28th and is back on the 31st in March', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-31T12:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 30_000); // exactly three months of Pro

  const bought = await svc.purchasePlan(USER, 'pro');
  assert.equal(bought.currentPeriodEnd, '2026-02-28T12:00:00.000Z', 'February has no 31st');

  const sweeps = renewal(repo);
  assert.equal((await sweeps.sweep(new Date('2026-02-28T12:00:00.000Z'))).renewed, 1);
  assert.equal(
    (await repo.getSubscription(TEAM))?.currentPeriodEnd,
    '2026-03-31T12:00:00.000Z',
    'the anchor is kept, so the billing day comes back',
  );

  assert.equal((await sweeps.sweep(new Date('2026-03-31T12:00:00.000Z'))).renewed, 1);
  assert.equal((await repo.getSubscription(TEAM))?.currentPeriodEnd, '2026-04-30T12:00:00.000Z');
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'three charges in three months, not four');
});

test('an upgrade re-anchors to the day it was paid for, crediting the unused time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-31T12:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 30_000);
  await svc.purchasePlan(USER, 'light'); // -1_000; runs to 2026-02-28

  t.mock.timers.tick(10 * 24 * 3600 * 1000); // 2026-02-10T12:00Z

  const pro = await svc.purchasePlan(USER, 'pro');

  assert.equal(pro.billingAnchorDay, 10, 'the billing day follows the payment');
  assert.equal(pro.currentPeriodStart, '2026-02-10T12:00:00.000Z');
  assert.equal(pro.currentPeriodEnd, '2026-03-10T12:00:00.000Z');
  // Light ran 28 days from January 31st and 18 were unused: floor(1000 × 18/28) = 642. Prorating
  // against an assumed 30 days would have credited 600 for the same fortnight and a half.
  assert.equal(await repo.getBalanceCents(TEAM), 30_000 - 1_000 - (10_000 - 642));
});

test('a lapse recovered on day 29 is charged once, not twice inside 48 hours', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2025-12-01T00:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'pro'); // balance 0, runs to 2026-01-01

  const sweeps = renewal(repo);
  assert.equal((await sweeps.sweep(new Date('2026-01-01T00:00:00.000Z'))).lapsed, 1);

  await fund(repo, 10_000); // the deposit lands on the 29th
  assert.equal((await sweeps.sweep(new Date('2026-01-29T09:00:00.000Z'))).renewed, 1);

  const sub = await repo.getSubscription(TEAM);
  assert.equal(
    sub?.currentPeriodStart,
    '2026-01-29T09:00:00.000Z',
    'the 28 days they were locked out of are not invoiced',
  );
  assert.equal(
    sub?.currentPeriodEnd,
    '2026-03-01T09:00:00.000Z',
    'a whole month, still on the 1st',
  );

  // Under the 30-day clock this sweep charged a second full month, two days after the first.
  const twoDaysLater = await sweeps.sweep(new Date('2026-01-31T12:00:00.000Z'));
  assert.equal(twoDaysLater.examined, 0, 'nothing is due yet');
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'exactly one renewal was charged');
});

test('a yearly package charges the discounted year and bills twelve months later', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-03-15T23:00:00.000Z') });
  const { svc, repo } = makeService();
  const year = yearlyPriceCents(planByTier('pro'));
  await fund(repo, year * 2);

  const sub = await svc.purchasePlan(USER, 'pro', 'yearly');

  assert.equal(sub.priceCents, year, 'the yearly price is snapshotted, not the monthly one');
  assert.equal(sub.billingPeriod, 'yearly');
  assert.equal(sub.currentPeriodEnd, '2027-03-15T23:00:00.000Z');
  assert.equal(await repo.getBalanceCents(TEAM), year);

  assert.equal((await renewal(repo).sweep(new Date('2027-03-15T23:00:00.000Z'))).renewed, 1);
  assert.equal(await repo.getBalanceCents(TEAM), 0, 'a year renews for a year, not for a month');
  assert.equal((await repo.getSubscription(TEAM))?.currentPeriodEnd, '2028-03-15T23:00:00.000Z');
});

test('switching an active package to yearly is a purchase, not a duplicate', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-01-15T00:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 200_000);
  await svc.purchasePlan(USER, 'pro');

  await assert.rejects(() => svc.purchasePlan(USER, 'pro'), ConflictException);

  const yearly = await svc.purchasePlan(USER, 'pro', 'yearly');
  assert.equal(yearly.billingPeriod, 'yearly');
  assert.equal(yearly.priceCents, yearlyPriceCents(planByTier('pro')));
  assert.equal(yearly.currentPeriodEnd, '2027-01-15T00:00:00.000Z');
});

test('the overview shows the instant the sweep will charge on, and nothing when it will not', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-05-31T08:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'pro');

  const overview = await svc.getOverview(USER);
  assert.equal(overview.nextBillingAt, '2026-06-30T08:00:00.000Z', 'June has no 31st');
  assert.equal(
    overview.nextBillingAt,
    overview.subscription?.currentPeriodEnd,
    'the date shown is the one the renewal job charges on',
  );

  await svc.setAutoRenew(USER, false);
  assert.equal((await svc.getOverview(USER)).nextBillingAt, null, 'nothing more will be charged');
});

test('the overview reports the allowance in force, not the one that was bought', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-05-01T00:00:00.000Z') });
  const { svc, repo } = makeService();
  await fund(repo, 10_000);
  await svc.purchasePlan(USER, 'pro');
  assert.equal((await svc.getOverview(USER)).entitledProfileLimit, 200);

  // Auto-renew off and the period gone. The row still says Pro/200 — nothing renewed it, and
  // nothing marked it past_due either, because a subscription with auto-renew off is never swept.
  await svc.setAutoRenew(USER, false);
  t.mock.timers.tick(40 * 24 * 3600 * 1000);

  const overview = await svc.getOverview(USER);
  assert.equal(overview.subscription?.profileLimit, 200, 'the purchase is still on the row');
  assert.equal(overview.entitledProfileLimit, FREE_PLAN_PROFILE_LIMIT, 'and is no longer honoured');
});

test('an elapsed period stops entitling the profile limit it paid for', () => {
  const now = new Date('2026-06-01T00:00:00.000Z');
  const live = {
    status: 'active' as const,
    profileLimit: 1_000,
    currentPeriodEnd: '2026-07-01T00:00:00.000Z',
  };

  assert.equal(entitledProfileLimit(live, now), 1_000);
  assert.equal(
    entitledProfileLimit({ ...live, currentPeriodEnd: '2026-05-01T00:00:00.000Z' }, now),
    FREE_PLAN_PROFILE_LIMIT,
    'a period that ended a month ago entitles nothing',
  );
  assert.equal(
    entitledProfileLimit({ ...live, status: 'past_due' }, now),
    FREE_PLAN_PROFILE_LIMIT,
    'a failed renewal withdraws the allowance the desktop already stopped showing',
  );
  assert.equal(
    entitledProfileLimit({ ...live, status: 'trialing' }, now),
    1_000,
    'a trial is a live period, not a lapse',
  );
  assert.equal(entitledProfileLimit(null, now), FREE_PLAN_PROFILE_LIMIT);
});
