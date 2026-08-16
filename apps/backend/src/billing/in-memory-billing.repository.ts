import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type {
  CreditTransaction,
  CreditTxKind,
  Deposit,
  DepositStatus,
  PaidPlanTier,
  Subscription,
} from '@lobster/shared-types';

import type { BillingRepository } from './billing.repository';

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
  private readonly deposits = new Map<string, Deposit & { creditedAt?: string }>();
  private readonly subscriptions = new Map<string, Subscription>();

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

  // --- Deposits -------------------------------------------------------------

  async createDeposit(deposit: {
    teamId: string;
    provider: string;
    providerPaymentId: string;
    chain: string;
    asset: string;
    address?: string;
    amountCrypto?: string;
  }): Promise<Deposit> {
    const row: Deposit = {
      id: randomUUID(),
      teamId: deposit.teamId,
      provider: deposit.provider,
      status: 'pending',
      chain: deposit.chain,
      asset: deposit.asset,
      address: deposit.address,
      amountCrypto: deposit.amountCrypto,
      createdAt: new Date().toISOString(),
    };
    this.deposits.set(deposit.providerPaymentId, row);
    return row;
  }

  async findDepositByProviderId(providerPaymentId: string): Promise<Deposit | null> {
    return this.deposits.get(providerPaymentId) ?? null;
  }

  async listDeposits(teamId: string, limit: number): Promise<Deposit[]> {
    return [...this.deposits.values()]
      .filter((d) => d.teamId === teamId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
      .slice(0, limit);
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

  // --- Subscription ---------------------------------------------------------

  async getSubscription(teamId: string): Promise<Subscription | null> {
    return this.subscriptions.get(teamId) ?? null;
  }

  async activateSubscription(args: {
    teamId: string;
    tier: PaidPlanTier;
    profileLimit: number;
    priceCents: number;
    currentPeriodEnd: Date;
  }): Promise<Subscription> {
    const row: Subscription = {
      teamId: args.teamId,
      tier: args.tier,
      profileLimit: args.profileLimit,
      priceCents: args.priceCents,
      status: 'active',
      currentPeriodEnd: args.currentPeriodEnd.toISOString(),
      autoRenew: true,
    };
    this.subscriptions.set(args.teamId, row);
    return row;
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
    newPeriodEnd: Date;
    description: string;
  }): Promise<'renewed' | 'insufficient_credit' | 'not_due'> {
    const row = this.subscriptions.get(args.teamId);
    // Same compare-and-swap contract as the Prisma implementation; here it is satisfied for free
    // by the single-threaded event loop, since nothing below awaits before the mutation.
    if (!row || row.currentPeriodEnd !== args.expectedPeriodEnd) return 'not_due';

    const balance = this.balances.get(args.teamId) ?? 0;
    if (balance < args.priceCents) return 'insufficient_credit';

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
