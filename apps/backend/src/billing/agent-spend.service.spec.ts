import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { ConfigService } from '@nestjs/config';

import { AFFORDABILITY_WINDOW_MS, AgentSpendService } from './agent-spend.service';
import { MICROS_PER_CENT } from './agent-pricing';
import { InMemoryBillingRepository } from './in-memory-billing.repository';

const TEAM = 'team-1';
const USER = 'user-1';
const OPUS = 'anthropic/claude-opus-4.8';

/** A call small enough that its whole cost is sub-cent: 4,500 µ$, or 0.45 of a cent. */
const TINY = { model: OPUS, tokensIn: 100, tokensOut: 100, cachedIn: 0 } as const;

function makeService(env: Record<string, string | undefined> = {}): {
  service: AgentSpendService;
  repo: InMemoryBillingRepository;
} {
  const repo = new InMemoryBillingRepository();
  const config = { get: (key: string) => env[key] } as unknown as ConfigService;
  return { service: new AgentSpendService(repo, config), repo };
}

async function fund(repo: InMemoryBillingRepository, cents: number): Promise<void> {
  await repo.move({ teamId: TEAM, kind: 'deposit', amountCents: cents, description: 'test' });
}

test('a sub-cent call charges nothing and carries its cost forward', async () => {
  const { service, repo } = makeService();
  await fund(repo, 500);

  const result = await service.charge({ teamId: TEAM, userId: USER, ...TINY });

  assert.equal(result.priced, true);
  assert.equal(result.costMicros, 4_500);
  assert.equal(result.chargedCents, 0);
  assert.equal(result.pendingMicros, 4_500);
  assert.equal(await repo.getBalanceCents(TEAM), 500);
});

test('repeated tiny calls charge exactly one cent, and never zero forever', async () => {
  const { service, repo } = makeService();
  await fund(repo, 500);

  // Three 0.45-cent calls are 1.35 cents: one whole cent is owed and 0.35 of one is not.
  const first = await service.charge({ teamId: TEAM, userId: USER, ...TINY });
  const second = await service.charge({ teamId: TEAM, userId: USER, ...TINY });
  const third = await service.charge({ teamId: TEAM, userId: USER, ...TINY });

  assert.equal(first.chargedCents, 0);
  assert.equal(second.chargedCents, 0);
  assert.equal(third.chargedCents, 1);
  assert.equal(third.pendingMicros, 3_500);
  assert.equal(await repo.getBalanceCents(TEAM), 499);

  // And it keeps happening — the remainder is a running total, not a per-call reset.
  for (let i = 0; i < 3; i += 1) await service.charge({ teamId: TEAM, userId: USER, ...TINY });
  assert.equal(await repo.getBalanceCents(TEAM), 498);
  assert.equal(await repo.getAgentAccruedMicros(TEAM), 7_000);
});

test('a thousand tiny calls charge the sum of their costs, not a cent apiece', async () => {
  const { service, repo } = makeService();
  await fund(repo, 10_000);

  for (let i = 0; i < 1_000; i += 1) await service.charge({ teamId: TEAM, ...TINY });

  // 1,000 x 4,500 µ$ = 4,500,000 µ$ = 450 cents exactly. Rounding each call up to a cent would
  // have taken 1,000.
  assert.equal(await repo.getBalanceCents(TEAM), 10_000 - 450);
  assert.equal(await repo.getAgentAccruedMicros(TEAM), 0);
});

test('the charge lands on the ledger as agent_usage, never as an adjustment', async () => {
  const { service, repo } = makeService();
  await fund(repo, 500);

  for (let i = 0; i < 3; i += 1) await service.charge({ teamId: TEAM, ...TINY });

  const [latest] = await repo.listTransactions(TEAM, 1);
  assert.equal(latest.kind, 'agent_usage');
  assert.equal(latest.amountCents, -1);
  assert.equal(latest.balanceAfterCents, 499);
});

test('every call writes a usage row that explains it, charged or not', async () => {
  const { service, repo } = makeService();
  await fund(repo, 500);

  await service.charge({
    teamId: TEAM,
    userId: USER,
    profileId: 'profile-9',
    sessionId: 'run-7',
    model: OPUS,
    tokensIn: 1_000,
    tokensOut: 500,
    cachedIn: 400,
  });

  const [row] = await service.listUsage(TEAM);
  assert.equal(row.userId, USER);
  assert.equal(row.profileId, 'profile-9');
  assert.equal(row.sessionId, 'run-7');
  assert.equal(row.model, OPUS);
  assert.equal(row.tokensIn, 1_000);
  assert.equal(row.tokensOut, 500);
  assert.equal(row.cachedIn, 400);
  // 600 fresh + 400 cached + 500 output = 15,700 µ$ raw, 23,550 with margin.
  assert.equal(row.costMicros, 23_550);
  assert.equal(row.chargedCents, 2);
});

test('a model with no known price charges nothing and is logged as unpriced', async () => {
  const { service, repo } = makeService();
  await fund(repo, 500);

  const result = await service.charge({
    teamId: TEAM,
    model: 'nobody/invented-this',
    tokensIn: 100_000,
    tokensOut: 100_000,
    cachedIn: 0,
  });

  assert.equal(result.priced, false);
  assert.equal(result.chargedCents, 0);
  assert.equal(await repo.getBalanceCents(TEAM), 500);
  // The call still appears in the audit — the tokens were spent even though we could not price them.
  assert.equal((await service.listUsage(TEAM)).length, 1);
});

test('the reserve check refuses a call the balance cannot cover', async () => {
  const { service, repo } = makeService();
  await fund(repo, 2);

  const cheap = await service.canAfford(TEAM, 1 * MICROS_PER_CENT);
  assert.equal(cheap.ok, true);
  assert.equal(cheap.balanceCents, 2);
  assert.equal(cheap.requiredCents, 1);

  const dear = await service.canAfford(TEAM, 50 * MICROS_PER_CENT);
  assert.equal(dear.ok, false);
  assert.equal(dear.requiredCents, 50);
});

test('the reserve check counts spend already accrued but not yet charged', async () => {
  const { service, repo } = makeService();
  await fund(repo, 1);

  await service.charge({ teamId: TEAM, ...TINY }); // 4,500 µ$ accrued, nothing charged yet
  // Half a cent of estimate plus 0.45 of a cent already owed rounds up to one whole cent.
  const check = await service.canAfford(TEAM, 5_000);
  assert.equal(check.requiredCents, 1);
  assert.equal(check.ok, true);

  const overCheck = await service.canAfford(TEAM, 6_000);
  assert.equal(overCheck.requiredCents, 2);
  assert.equal(overCheck.ok, false);
});

test('a short balance is charged what it can cover and still owes the rest', async () => {
  const { service, repo } = makeService();
  await fund(repo, 1);

  const result = await service.charge({
    teamId: TEAM,
    model: OPUS,
    tokensIn: 10_000,
    tokensOut: 10_000,
    cachedIn: 0,
  });

  // 45 cents of spend against a 1 cent balance.
  assert.equal(result.costMicros, 450_000);
  assert.equal(result.chargedCents, 1);
  assert.equal(result.unpaidCents, 44);
  assert.equal(await repo.getBalanceCents(TEAM), 0);
  // The unpayable part stays accrued — a later deposit settles it rather than writing it off.
  assert.equal(await repo.getAgentAccruedMicros(TEAM), 440_000);
});

test('an empty balance charges nothing and loses nothing', async () => {
  const { service, repo } = makeService();

  const result = await service.charge({
    teamId: TEAM,
    ...TINY,
    tokensIn: 10_000,
    tokensOut: 10_000,
  });
  assert.equal(result.chargedCents, 0);
  assert.equal(result.unpaidCents, 45);
  assert.equal(await repo.getAgentAccruedMicros(TEAM), 450_000);

  await fund(repo, 100);
  const next = await service.charge({ teamId: TEAM, ...TINY });
  assert.equal(next.chargedCents, 45);
  assert.equal(await repo.getBalanceCents(TEAM), 55);
});

test('the margin is read from the environment', async () => {
  const { service } = makeService({ LOBSTER_AGENT_MARGIN: '2' });
  assert.equal(service.marginMultiplier, 2);
  assert.equal(
    service.estimateMicros({ model: OPUS, tokensIn: 1_000_000, maxTokensOut: 0 }),
    10_000_000,
  );
});

test('an unpriceable model is knowable before the call is made', () => {
  const { service } = makeService();
  assert.equal(service.isPriced(OPUS), true);
  assert.equal(service.isPriced('nobody/invented-this'), false);
  assert.equal(
    service.estimateMicros({ model: 'nobody/invented-this', tokensIn: 1, maxTokensOut: 1 }),
    undefined,
  );
});

/** Counts the wallet reads the meter makes, so a test can prove the pre-flight stopped making them. */
class CountingRepository extends InMemoryBillingRepository {
  walletReads = 0;

  override async getBalanceCents(teamId: string): Promise<number> {
    this.walletReads += 1;
    return super.getBalanceCents(teamId);
  }

  override async getAgentAccruedMicros(teamId: string): Promise<number> {
    this.walletReads += 1;
    return super.getAgentAccruedMicros(teamId);
  }
}

function makeCountingService(): {
  service: AgentSpendService;
  repo: CountingRepository;
  clock: { now: number };
} {
  const repo = new CountingRepository();
  const config = { get: () => undefined } as unknown as ConfigService;
  const service = new AgentSpendService(repo, config);
  const clock = { now: 1_000_000 };
  (service as unknown as { now: () => number }).now = () => clock.now;
  return { service, repo, clock };
}

test('the pre-flight reads the wallet once per window, then follows the charges it makes itself', async () => {
  const { service, repo, clock } = makeCountingService();
  await fund(repo, 500);

  const first = await service.canAfford(TEAM, 6_000);
  assert.equal(first.ok, true);
  assert.equal(first.requiredCents, 1);
  assert.equal(repo.walletReads, 2, 'one balance read and one accrual read');

  await service.canAfford(TEAM, 6_000);
  await service.canAfford(TEAM, 6_000);
  assert.equal(repo.walletReads, 2, 'the window answers the next checks');

  // A charge moves the accrual; the snapshot sees it without a round trip.
  const charged = await service.charge({ teamId: TEAM, userId: USER, ...TINY });
  assert.equal(charged.pendingMicros, 4_500);
  const after = await service.canAfford(TEAM, 6_000);
  // 4,500 accrued + 6,000 estimated = 10,500 µ$ → two whole cents, from the followed snapshot.
  assert.equal(after.requiredCents, 2);
  assert.equal(after.balanceCents, 500);
  assert.equal(repo.walletReads, 2);

  // The window ends; the next check reads again.
  clock.now += AFFORDABILITY_WINDOW_MS;
  await service.canAfford(TEAM, 6_000);
  assert.equal(repo.walletReads, 4);
});

test('a flushed cent is taken off the cached balance', async () => {
  const { service, repo } = makeCountingService();
  await fund(repo, 500);
  await service.canAfford(TEAM, 1_000);

  // Three 0.45-cent calls cross a whole cent on the third, which the flush takes from the wallet.
  for (let i = 0; i < 3; i += 1) await service.charge({ teamId: TEAM, ...TINY });
  const readsAfterCharges = repo.walletReads;

  const check = await service.canAfford(TEAM, 1_000);
  assert.equal(check.balanceCents, 499, 'the cent the flush took is gone from the snapshot');
  // 3,500 µ$ carried + 1,000 estimated = 4,500 µ$ → one cent.
  assert.equal(check.requiredCents, 1);
  assert.equal(repo.walletReads, readsAfterCharges, 'without another read');
  assert.equal(await repo.getBalanceCents(TEAM), 499, 'and the snapshot matches the ledger');
});

test('a refusal is never served from the snapshot, so a top-up is honoured at once', async () => {
  const { service, repo } = makeCountingService();
  await fund(repo, 1);

  const refused = await service.canAfford(TEAM, 20_000);
  assert.equal(refused.ok, false);
  assert.equal(refused.requiredCents, 2);
  assert.equal(repo.walletReads, 2);

  await fund(repo, 100);
  const allowed = await service.canAfford(TEAM, 20_000);
  assert.equal(allowed.ok, true, 'the deposit is seen on the very next check');
  assert.equal(allowed.balanceCents, 101);
  assert.equal(repo.walletReads, 4, 'a refusal evicts the snapshot rather than being cached');
});
