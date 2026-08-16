import { Injectable } from '@nestjs/common';
import type {
  CreditTransaction,
  CreditTxKind,
  Deposit,
  DepositStatus,
  PaidPlanTier,
  Subscription,
} from '@lobster/shared-types';

import type { PrismaService } from '../prisma/prisma.service';
import type { BillingRepository } from './billing.repository';

/**
 * Thrown inside `renewSubscription`'s transaction to abort it when Credit is short.
 *
 * Prisma only rolls an interactive transaction back if the callback REJECTS, so signalling this
 * with a return value would commit the period extension without the charge — a free month. A
 * private sentinel class (rather than a bare Error) lets the catch distinguish this deliberate
 * unwind from a genuine database fault, which must still propagate.
 */
class InsufficientCreditRollback extends Error {}

/**
 * Postgres persistence for Credit, deposits and subscriptions.
 *
 * Every method that moves money runs inside `$transaction`, and the ones that can race do their
 * checking inside the SQL predicate rather than in JavaScript. See {@link move} for the reasoning
 * — it is the load-bearing part of this file.
 */
@Injectable()
export class PrismaBillingRepository implements BillingRepository {
  constructor(private readonly prisma: PrismaService) {}

  // --- Wallet ---------------------------------------------------------------

  async getBalanceCents(teamId: string): Promise<number> {
    // Upsert-on-read: teams created before wallets existed get one lazily, so there is no backfill
    // migration to run and no null-wallet case for callers to handle.
    const wallet = await this.prisma.wallet.upsert({
      where: { teamId },
      create: { teamId },
      update: {},
    });
    return wallet.balanceCents;
  }

  async move(entry: {
    teamId: string;
    kind: CreditTxKind;
    amountCents: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditTransaction | null> {
    const { teamId, kind, amountCents, description, metadata } = entry;

    return this.prisma.$transaction(async (tx) => {
      await tx.wallet.upsert({ where: { teamId }, create: { teamId }, update: {} });

      // THE RACE, AND WHY THIS IS AN updateMany WITH A PREDICATE.
      //
      // The obvious implementation reads the balance, compares it in JS, then writes the new
      // value. Two concurrent $60 purchases against a $100 balance would both read 100, both
      // conclude "affordable", and both write 40 — two packages sold for one package's Credit.
      // Repeatable-read does not save us either; it turns the second write into a serialisation
      // error only under SERIALIZABLE, which this connection is not using.
      //
      // Pushing the sufficiency check into the WHERE clause makes the check and the decrement a
      // single atomic UPDATE. Postgres takes a row lock for the duration, so the second
      // transaction re-evaluates `balanceCents >= 60` against the ALREADY-DECREMENTED row, matches
      // nothing, and reports count 0. The guard is only applied to debits: a credit can never
      // overdraw, and gating it on `gte` would be nonsense for a negative threshold.
      const guard = amountCents < 0 ? { balanceCents: { gte: -amountCents } } : {};
      const res = await tx.wallet.updateMany({
        where: { teamId, ...guard },
        data: { balanceCents: { increment: amountCents } },
      });
      if (res.count === 0) return null; // insufficient Credit — nothing was written

      // Re-read INSIDE the transaction: this is the balance the update actually produced, which is
      // what `balanceAfterCents` has to record for the statement to reconcile.
      const wallet = await tx.wallet.findUniqueOrThrow({ where: { teamId } });

      const row = await tx.creditTransaction.create({
        data: {
          teamId,
          kind,
          amountCents,
          balanceAfterCents: wallet.balanceCents,
          description,
          metadata: (metadata ?? {}) as never,
        },
      });
      return toTransaction(row);
    });
  }

  async listTransactions(teamId: string, limit: number): Promise<CreditTransaction[]> {
    const rows = await this.prisma.creditTransaction.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toTransaction);
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
    const row = await this.prisma.deposit.create({
      data: {
        teamId: deposit.teamId,
        provider: deposit.provider,
        providerPaymentId: deposit.providerPaymentId,
        chain: deposit.chain,
        asset: deposit.asset,
        address: deposit.address,
        amountCrypto: deposit.amountCrypto,
      },
    });
    return toDeposit(row);
  }

  async findDepositByProviderId(providerPaymentId: string): Promise<Deposit | null> {
    const row = await this.prisma.deposit.findUnique({ where: { providerPaymentId } });
    return row ? toDeposit(row) : null;
  }

  async listDeposits(teamId: string, limit: number): Promise<Deposit[]> {
    const rows = await this.prisma.deposit.findMany({
      where: { teamId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
    return rows.map(toDeposit);
  }

  async updateDepositStatus(
    providerPaymentId: string,
    status: DepositStatus,
    patch: { txHash?: string; amountCrypto?: string; providerPayload?: unknown },
  ): Promise<void> {
    // updateMany, not update: an IPN for a payment we have no record of must be a no-op, not a
    // P2025 throw that makes the processor retry a callback that can never succeed.
    await this.prisma.deposit.updateMany({
      where: { providerPaymentId },
      data: {
        status,
        txHash: patch.txHash,
        amountCrypto: patch.amountCrypto,
        providerPayload: (patch.providerPayload ?? {}) as never,
      },
    });
  }

  async creditDeposit(
    providerPaymentId: string,
    args: {
      creditedCents: number;
      txHash?: string;
      amountCrypto?: string;
      providerPayload?: unknown;
    },
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const deposit = await tx.deposit.findUnique({ where: { providerPaymentId } });
      if (!deposit) return false;

      // EXACTLY-ONCE, enforced by the UPDATE predicate rather than by the read above.
      //
      // The read is advisory: between it and the write, a concurrently-delivered duplicate IPN
      // could credit the same deposit. `creditedAt: null` in the WHERE closes that window — the
      // row is locked for the update, so exactly one of the racing transactions sees a null
      // `creditedAt` and matches. The loser gets count 0 and returns false, which the caller
      // reports to the processor as a successful no-op.
      const claimed = await tx.deposit.updateMany({
        where: { providerPaymentId, creditedAt: null },
        data: {
          status: 'confirmed',
          creditedCents: args.creditedCents,
          creditedAt: new Date(),
          txHash: args.txHash,
          amountCrypto: args.amountCrypto,
          providerPayload: (args.providerPayload ?? {}) as never,
        },
      });
      if (claimed.count === 0) return false; // already credited by an earlier delivery

      await tx.wallet.upsert({
        where: { teamId: deposit.teamId },
        create: { teamId: deposit.teamId },
        update: {},
      });
      const wallet = await tx.wallet.update({
        where: { teamId: deposit.teamId },
        data: { balanceCents: { increment: args.creditedCents } },
      });
      await tx.creditTransaction.create({
        data: {
          teamId: deposit.teamId,
          kind: 'deposit',
          amountCents: args.creditedCents,
          balanceAfterCents: wallet.balanceCents,
          description: `Deposit — ${deposit.asset} on ${deposit.chain}`,
          metadata: { depositId: deposit.id, providerPaymentId, txHash: args.txHash ?? null } as never,
        },
      });
      return true;
    });
  }

  // --- Subscription ---------------------------------------------------------

  async getSubscription(teamId: string): Promise<Subscription | null> {
    const row = await this.prisma.subscription.findUnique({ where: { teamId } });
    return row ? toSubscription(row) : null;
  }

  async activateSubscription(args: {
    teamId: string;
    tier: PaidPlanTier;
    profileLimit: number;
    priceCents: number;
    currentPeriodEnd: Date;
  }): Promise<Subscription> {
    const data = {
      tier: args.tier,
      profileLimit: args.profileLimit,
      priceCents: args.priceCents,
      currentPeriodEnd: args.currentPeriodEnd,
      status: 'active' as const,
      autoRenew: true,
      lastRenewalAt: new Date(),
      // Clear any prior lapse reason, so a team that recovers from past_due stops being told it
      // is short on Credit.
      lastFailureCode: null,
    };
    const row = await this.prisma.subscription.upsert({
      where: { teamId: args.teamId },
      create: { teamId: args.teamId, ...data },
      update: data,
    });
    return toSubscription(row);
  }

  async setAutoRenew(teamId: string, autoRenew: boolean): Promise<Subscription> {
    const row = await this.prisma.subscription.update({
      where: { teamId },
      data: { autoRenew },
    });
    return toSubscription(row);
  }

  async renewSubscription(args: {
    teamId: string;
    expectedPeriodEnd: string;
    priceCents: number;
    newPeriodEnd: Date;
    description: string;
  }): Promise<'renewed' | 'insufficient_credit' | 'not_due'> {
    return this.prisma.$transaction(async (tx) => {
      // 1. CLAIM. Compare-and-swap on the period end. Exactly one concurrent attempt can match a
      //    given `expectedPeriodEnd`, because the first one to commit changes it.
      const claimed = await tx.subscription.updateMany({
        where: { teamId: args.teamId, currentPeriodEnd: new Date(args.expectedPeriodEnd) },
        data: {
          currentPeriodEnd: args.newPeriodEnd,
          status: 'active',
          lastRenewalAt: new Date(),
          lastFailureCode: null,
        },
      });
      if (claimed.count === 0) return 'not_due' as const;

      // 2. CHARGE, same transaction. If this returns 0 rows the balance is short, and throwing
      //    below rolls the claim back — the period is NOT extended and no Credit moves.
      await tx.wallet.upsert({
        where: { teamId: args.teamId },
        create: { teamId: args.teamId },
        update: {},
      });
      const debited = await tx.wallet.updateMany({
        where: { teamId: args.teamId, balanceCents: { gte: args.priceCents } },
        data: { balanceCents: { decrement: args.priceCents } },
      });
      if (debited.count === 0) throw new InsufficientCreditRollback();

      const wallet = await tx.wallet.findUniqueOrThrow({ where: { teamId: args.teamId } });
      await tx.creditTransaction.create({
        data: {
          teamId: args.teamId,
          kind: 'renewal',
          amountCents: -args.priceCents,
          balanceAfterCents: wallet.balanceCents,
          description: args.description,
          metadata: { periodEnd: args.newPeriodEnd.toISOString() } as never,
        },
      });
      return 'renewed' as const;
    }).catch((err: unknown) => {
      // The sentinel is control flow, not a fault: it is how "insufficient Credit" unwinds the
      // claim. Anything else is a real error and must not be swallowed into a billing outcome.
      if (err instanceof InsufficientCreditRollback) return 'insufficient_credit' as const;
      throw err;
    });
  }

  async markPastDue(teamId: string, failureCode: string): Promise<void> {
    await this.prisma.subscription.updateMany({
      where: { teamId },
      data: { status: 'past_due', lastFailureCode: failureCode },
    });
  }

  async findDueForRenewal(now: Date, limit: number): Promise<Subscription[]> {
    const rows = await this.prisma.subscription.findMany({
      where: {
        autoRenew: true,
        currentPeriodEnd: { lte: now },
        // past_due is included on purpose: a team that lapsed for want of Credit should renew by
        // itself once a deposit lands, without needing a support action or a fresh purchase.
        status: { in: ['active', 'past_due'] },
        tier: { not: 'free' },
      },
      orderBy: { currentPeriodEnd: 'asc' },
      take: limit,
    });
    return rows.map(toSubscription);
  }
}

// --- Row → wire-type mappers -------------------------------------------------
//
// Prisma returns Date and Decimal objects; the wire types are JSON-safe strings. Converting here
// keeps every caller from having to remember which is which.

/* eslint-disable @typescript-eslint/no-explicit-any */

function toTransaction(row: any): CreditTransaction {
  return {
    id: row.id,
    teamId: row.teamId,
    kind: row.kind,
    amountCents: row.amountCents,
    balanceAfterCents: row.balanceAfterCents,
    description: row.description,
    metadata: row.metadata ?? {},
    createdAt: row.createdAt.toISOString(),
  };
}

function toDeposit(row: any): Deposit {
  return {
    id: row.id,
    teamId: row.teamId,
    provider: row.provider,
    status: row.status,
    chain: row.chain,
    asset: row.asset,
    // Decimal → string, never Number: a wei-precision value loses its low digits as a float.
    amountCrypto: row.amountCrypto ? row.amountCrypto.toString() : undefined,
    address: row.address ?? undefined,
    txHash: row.txHash ?? undefined,
    creditedCents: row.creditedCents ?? undefined,
    createdAt: row.createdAt.toISOString(),
  };
}

function toSubscription(row: any): Subscription {
  return {
    teamId: row.teamId,
    tier: row.tier,
    profileLimit: row.profileLimit,
    priceCents: row.priceCents,
    status: row.status,
    currentPeriodEnd: row.currentPeriodEnd ? row.currentPeriodEnd.toISOString() : undefined,
    autoRenew: row.autoRenew,
    lastFailureCode: row.lastFailureCode ?? undefined,
  };
}
