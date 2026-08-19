import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  BillingPeriod,
  CreditTransaction,
  CreditTxKind,
  Deposit,
  DepositStatus,
  PaidPlanTier,
  PlanTier,
  Subscription,
} from '@lobster/shared-types';

import type {
  AgentUsageEntry,
  AgentUsageRow,
  BillingRepository,
  DepositReversal,
  PlanChangeOutcome,
  StoredDeposit,
} from './billing.repository';

/**
 * In-memory Credit store. Active whenever `DATABASE_URL` is unset, so the app and its tests boot
 * without Postgres.
 *
 * ON ATOMICITY. The Prisma implementation goes to some trouble to make check-and-decrement a
 * single locked UPDATE. Here it is free: JavaScript is single-threaded and none of these methods
 * awaits between reading a balance and writing it, so no other request can interleave. That is a
 * property of the code as written, not of the language in general — introducing an `await`
 * between the check and the write in `move` would reintroduce exactly the double-spend the
 * Postgres version guards against.
 */
@Injectable()
export class InMemoryBillingRepository implements BillingRepository {
  private readonly balances = new Map<string, number>();
  private readonly ledger: CreditTransaction[] = [];
  private readonly deposits = new Map<string, StoredDeposit>();
  private readonly subscriptions = new Map<string, Subscription>();
  private readonly agentAccruals = new Map<string, number>();
  private readonly agentUsage: AgentUsageRow[] = [];

  // --- Wallet ---------------------------------------------------------------

  async getBalanceCents(teamId: string): Promise<number> {
    return this.balances.get(teamId) ?? 0;
  }

  async move(entry: {
    teamId: string;
    kind: CreditTxKind;
    amountCents: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditTransaction | null> {
    return this.applyMove(entry);
  }

  /**
   * The body of {@link move}, kept SYNCHRONOUS so callers that must not suspend mid-operation can
   * reuse it. See {@link changePlan}, which depends on there being no await between its
   * compare-and-swap and this debit.
   */
  private applyMove(entry: {
    teamId: string;
    kind: CreditTxKind;
    amountCents: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): CreditTransaction | null {
    const current = this.balances.get(entry.teamId) ?? 0;
    const next = current + entry.amountCents;
    if (next < 0) return null; // insufficient Credit — leave the balance untouched

    this.balances.set(entry.teamId, next);
    const row: CreditTransaction = {
      id: randomUUID(),
      teamId: entry.teamId,
      kind: entry.kind,
      amountCents: entry.amountCents,
      balanceAfterCents: next,
      description: entry.description,
      metadata: entry.metadata ?? {},
      createdAt: new Date().toISOString(),
    };
    this.ledger.push(row);
    return row;
  }

  async listTransactions(teamId: string, limit: number): Promise<CreditTransaction[]> {
    return this.ledger
      .filter((t) => t.teamId === teamId)
      .slice()
      .reverse()
      .slice(0, limit);
  }

  // --- Agent metering -------------------------------------------------------

  async accrueAgentMicros(teamId: string, micros: number): Promise<number> {
    const next = (this.agentAccruals.get(teamId) ?? 0) + micros;
    this.agentAccruals.set(teamId, next);
    return next;
  }

  async claimAgentMicros(teamId: string, micros: number): Promise<boolean> {
    // Same contract as the Prisma conditional UPDATE: an accrual smaller than the claim matches
    // nothing and nothing moves, so two flushes racing for the same cent cannot both take it.
    const current = this.agentAccruals.get(teamId) ?? 0;
    if (current < micros) return false;
    this.agentAccruals.set(teamId, current - micros);
    return true;
  }

  async getAgentAccruedMicros(teamId: string): Promise<number> {
    return this.agentAccruals.get(teamId) ?? 0;
  }

  async recordAgentUsage(entry: AgentUsageEntry): Promise<void> {
    this.agentUsage.push({ ...entry, id: randomUUID(), createdAt: new Date().toISOString() });
  }

  async listAgentUsage(teamId: string, limit: number): Promise<AgentUsageRow[]> {
    return this.agentUsage
      .filter((row) => row.teamId === teamId)
      .slice()
      .reverse()
      .slice(0, limit);
  }

  // --- Deposits -------------------------------------------------------------

  async createDeposit(deposit: {
    teamId: string;
    provider: string;
    providerPaymentId: string;
    amountCents: number;
    chain: string;
    asset: string;
    address?: string;
    amountCrypto?: string;
  }): Promise<Deposit> {
    const row: StoredDeposit = {
      id: randomUUID(),
      teamId: deposit.teamId,
      provider: deposit.provider,
      providerPaymentId: deposit.providerPaymentId,
      status: 'pending',
      amountCents: deposit.amountCents,
      chain: deposit.chain,
      asset: deposit.asset,
      address: deposit.address,
      amountCrypto: deposit.amountCrypto,
      createdAt: new Date().toISOString(),
    };
    this.deposits.set(deposit.providerPaymentId, row);
    return toWireDeposit(row);
  }

  async findDepositByProviderId(providerPaymentId: string): Promise<StoredDeposit | null> {
    return this.deposits.get(providerPaymentId) ?? null;
  }

  async listDeposits(teamId: string, limit: number): Promise<Deposit[]> {
    return [...this.deposits.values()]
      .filter((d) => d.teamId === teamId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit)
      .map(toWireDeposit);
  }

  async findUnsettledDeposits(args: {
    createdBefore: Date;
    createdAfter: Date;
    limit: number;
  }): Promise<StoredDeposit[]> {
    const before = args.createdBefore.toISOString();
    const after = args.createdAfter.toISOString();
    return [...this.deposits.values()]
      .filter((d) => d.status === 'pending' || d.status === 'confirming')
      .filter((d) => d.createdAt < before && d.createdAt > after)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, args.limit);
  }

  async updateDepositStatus(
    providerPaymentId: string,
    status: DepositStatus,
    patch: { txHash?: string; amountCrypto?: string },
  ): Promise<void> {
    const row = this.deposits.get(providerPaymentId);
    if (!row) return; // unknown payment — a no-op, matching the Prisma behaviour
    row.status = status;
    if (patch.txHash) row.txHash = patch.txHash;
    if (patch.amountCrypto) row.amountCrypto = patch.amountCrypto;
  }

  async creditDeposit(
    providerPaymentId: string,
    args: { creditedCents: number; txHash?: string; amountCrypto?: string },
  ): Promise<boolean> {
    const row = this.deposits.get(providerPaymentId);
    if (!row) return false;
    if (row.creditedAt) return false; // already credited by an earlier delivery

    row.creditedAt = new Date().toISOString();
    row.status = 'confirmed';
    row.creditedCents = args.creditedCents;
    if (args.txHash) row.txHash = args.txHash;
    if (args.amountCrypto) row.amountCrypto = args.amountCrypto;

    await this.move({
      teamId: row.teamId,
      kind: 'deposit',
      amountCents: args.creditedCents,
      description: `Deposit — ${row.asset} on ${row.chain}`,
      metadata: { depositId: row.id, providerPaymentId, txHash: args.txHash ?? null },
    });
    return true;
  }

  async reverseDeposit(
    providerPaymentId: string,
    status: DepositStatus,
    patch: { txHash?: string; amountCrypto?: string },
  ): Promise<DepositReversal> {
    const row = this.deposits.get(providerPaymentId);
    if (!row) return { reversed: false, clawedBackCents: 0, unrecoveredCents: 0 };

    row.status = status;
    if (patch.txHash) row.txHash = patch.txHash;
    if (patch.amountCrypto) row.amountCrypto = patch.amountCrypto;

    // Same guard as the Prisma implementation: nothing was minted, or it has already been given
    // back, so there is nothing to take.
    if (!row.creditedAt || row.reversedAt) {
      return { reversed: false, clawedBackCents: 0, unrecoveredCents: 0 };
    }
    row.reversedAt = new Date().toISOString();

    const owed = row.creditedCents ?? 0;
    if (owed <= 0) return { reversed: true, clawedBackCents: 0, unrecoveredCents: 0 };

    const balance = this.balances.get(row.teamId) ?? 0;
    const clawedBackCents = Math.min(owed, Math.max(balance, 0));
    const unrecoveredCents = owed - clawedBackCents;
    if (clawedBackCents === 0) return { reversed: true, clawedBackCents: 0, unrecoveredCents };

    await this.move({
      teamId: row.teamId,
      kind: 'adjustment',
      amountCents: -clawedBackCents,
      description: `Deposit reversed — ${row.asset} on ${row.chain}`,
      metadata: {
        reason: 'deposit_reversed',
        depositId: row.id,
        providerPaymentId,
        creditedCents: owed,
        unrecoveredCents,
      },
    });
    return { reversed: true, clawedBackCents, unrecoveredCents };
  }

  // --- Subscription ---------------------------------------------------------

  async getSubscription(teamId: string): Promise<Subscription | null> {
    return this.subscriptions.get(teamId) ?? null;
  }

  async activateSubscription(args: {
    teamId: string;
    tier: PaidPlanTier;
    profileLimit: number;
    priceCents: number;
    billingPeriod: BillingPeriod;
    billingAnchorDay: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
  }): Promise<Subscription> {
    return this.writeSubscription(args);
  }

  /** Synchronous body of {@link activateSubscription}, for the same reason {@link applyMove} is. */
  private writeSubscription(args: {
    teamId: string;
    tier: PaidPlanTier;
    profileLimit: number;
    priceCents: number;
    billingPeriod: BillingPeriod;
    billingAnchorDay: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
  }): Subscription {
    const row: Subscription = {
      teamId: args.teamId,
      tier: args.tier,
      profileLimit: args.profileLimit,
      priceCents: args.priceCents,
      status: 'active',
      currentPeriodStart: args.currentPeriodStart.toISOString(),
      currentPeriodEnd: args.currentPeriodEnd.toISOString(),
      billingAnchorDay: args.billingAnchorDay,
      billingPeriod: args.billingPeriod,
      autoRenew: true,
    };
    this.subscriptions.set(args.teamId, row);
    return row;
  }

  async changePlan(args: {
    teamId: string;
    expected: {
      tier: PlanTier;
      billingPeriod: BillingPeriod;
      currentPeriodEnd: string | null;
    } | null;
    dueCents: number;
    description: string;
    metadata: Record<string, unknown>;
    tier: PaidPlanTier;
    profileLimit: number;
    priceCents: number;
    billingPeriod: BillingPeriod;
    billingAnchorDay: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
  }): Promise<PlanChangeOutcome> {
    const existing = this.subscriptions.get(args.teamId) ?? null;

    // The same compare-and-swap contract the Prisma implementation enforces with a transaction:
    // a row that appeared, vanished or moved on since the change was priced means another attempt
    // committed first, and this one must not charge.
    if (!args.expected !== !existing) return { status: 'superseded' };
    if (
      existing &&
      args.expected &&
      (existing.tier !== args.expected.tier ||
        (existing.billingPeriod ?? 'monthly') !== args.expected.billingPeriod ||
        (existing.currentPeriodEnd ?? null) !== args.expected.currentPeriodEnd)
    ) {
      return { status: 'superseded' };
    }

    // NOTHING BELOW AWAITS, which is what makes the claim, the debit and the ledger row one
    // indivisible step here — see the note on this class. Both helpers are the synchronous bodies
    // of their public counterparts precisely so this stays true.
    const charge = this.applyMove({
      teamId: args.teamId,
      kind: 'purchase',
      amountCents: -args.dueCents,
      description: args.description,
      metadata: args.metadata,
    });
    if (!charge) return { status: 'insufficient_credit' };

    return { status: 'changed', subscription: this.writeSubscription(args) };
  }

  async setAutoRenew(teamId: string, autoRenew: boolean): Promise<Subscription> {
    const row = this.subscriptions.get(teamId);
    if (!row) throw new Error('no subscription');
    row.autoRenew = autoRenew;
    return row;
  }

  async renewSubscription(args: {
    teamId: string;
    expectedPeriodEnd: string;
    priceCents: number;
    newPeriodStart: Date;
    newPeriodEnd: Date;
    description: string;
  }): Promise<'renewed' | 'insufficient_credit' | 'not_due'> {
    const row = this.subscriptions.get(args.teamId);
    // Same compare-and-swap contract as the Prisma implementation; here it is satisfied for free
    // by the single-threaded event loop, since nothing below awaits before the mutation.
    if (!row || row.currentPeriodEnd !== args.expectedPeriodEnd) return 'not_due';

    const balance = this.balances.get(args.teamId) ?? 0;
    if (balance < args.priceCents) return 'insufficient_credit';

    row.currentPeriodStart = args.newPeriodStart.toISOString();
    row.currentPeriodEnd = args.newPeriodEnd.toISOString();
    row.status = 'active';
    row.lastFailureCode = undefined;
    await this.move({
      teamId: args.teamId,
      kind: 'renewal',
      amountCents: -args.priceCents,
      description: args.description,
      metadata: { periodEnd: row.currentPeriodEnd },
    });
    return 'renewed';
  }

  async markPastDue(teamId: string, failureCode: string): Promise<void> {
    const row = this.subscriptions.get(teamId);
    if (!row) return;
    row.status = 'past_due';
    row.lastFailureCode = failureCode;
  }

  async findDueForRenewal(now: Date, limit: number): Promise<Subscription[]> {
    const iso = now.toISOString();
    return [...this.subscriptions.values()]
      .filter(
        (s) =>
          s.autoRenew &&
          s.tier !== 'free' &&
          (s.status === 'active' || s.status === 'past_due') &&
          s.currentPeriodEnd !== undefined &&
          s.currentPeriodEnd <= iso,
      )
      .sort((a, b) => (a.currentPeriodEnd ?? '').localeCompare(b.currentPeriodEnd ?? ''))
      .slice(0, limit);
  }
}

/**
 * Drop the settlement bookkeeping a client has no business seeing.
 *
 * The Prisma repository gets this for free — it maps rows to the wire type explicitly — while this
 * one hands back the object it stores, so the projection has to be deliberate.
 */
function toWireDeposit(row: StoredDeposit): Deposit {
  const {
    providerPaymentId: _providerPaymentId,
    amountCents: _amountCents,
    creditedAt: _creditedAt,
    reversedAt: _reversedAt,
    ...deposit
  } = row;
  return deposit;
}
