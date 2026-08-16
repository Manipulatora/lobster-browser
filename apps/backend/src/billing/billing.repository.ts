import type {
  CreditTransaction,
  CreditTxKind,
  Deposit,
  DepositStatus,
  PaidPlanTier,
  Subscription,
} from '@lobster/shared-types';

/**
 * Persistence boundary for Credit, deposits and subscriptions.
 *
 * WHY THE METHODS ARE OPERATIONS, NOT ACCESSORS. There is deliberately no `setBalance`, and
 * `getWallet` is read-only. Every method that MOVES Credit is a single atomic operation that
 * writes the ledger row and the balance together.
 *
 * The alternative — exposing a getter and a setter and letting the service do the arithmetic —
 * is a lost-update race. Two concurrent purchases both read $100, both check "enough for a $60
 * package", and both write $40: the team gets two packages for the price of one. That bug cannot
 * be written against this interface, because the balance check and the decrement are the same
 * call. Implementations must make it atomic for real (see `PrismaBillingRepository.debit` for
 * how, and why a conditional UPDATE rather than a read-then-write).
 *
 * Implementations:
 *   - InMemoryBillingRepository — Maps; boots without Postgres, used by tests and local dev.
 *   - PrismaBillingRepository   — production persistence.
 */
export interface BillingRepository {
  // --- Wallet ---------------------------------------------------------------

  /**
   * The team's balance in USD cents. Creates the wallet at zero on first access, so teams that
   * predate the wallet feature need no backfill migration.
   */
  getBalanceCents(teamId: string): Promise<number>;

  /**
   * Move Credit atomically and append the matching ledger row.
   *
   * `amountCents` is SIGNED — positive credits, negative debits. A debit that would take the
   * balance below zero MUST fail and change nothing; the implementation signals that by
   * returning null rather than throwing, so the caller decides whether "not enough Credit" is an
   * error (a manual purchase) or an expected outcome (an auto-renewal that should lapse).
   *
   * @returns the ledger row written, or null if the debit was refused for insufficient Credit.
   */
  move(entry: {
    teamId: string;
    kind: CreditTxKind;
    amountCents: number;
    description: string;
    metadata?: Record<string, unknown>;
  }): Promise<CreditTransaction | null>;

  /** Newest-first ledger page for the account statement. */
  listTransactions(teamId: string, limit: number): Promise<CreditTransaction[]>;

  // --- Deposits -------------------------------------------------------------

  createDeposit(deposit: {
    teamId: string;
    provider: string;
    providerPaymentId: string;
    chain: string;
    asset: string;
    address?: string;
    amountCrypto?: string;
  }): Promise<Deposit>;

  findDepositByProviderId(providerPaymentId: string): Promise<Deposit | null>;

  listDeposits(teamId: string, limit: number): Promise<Deposit[]>;

  /** Record a non-crediting status change (waiting → confirming, or a terminal failure). */
  updateDepositStatus(
    providerPaymentId: string,
    status: DepositStatus,
    patch: { txHash?: string; amountCrypto?: string; providerPayload?: unknown },
  ): Promise<void>;

  /**
   * Credit a confirmed deposit to the wallet — the money-minting path, and the one that has to be
   * exactly-once.
   *
   * Processors retry IPN delivery and deliver out of order, so the same "confirmed" callback
   * arriving three times is normal operation, not an attack. This call must therefore be
   * IDEMPOTENT on `providerPaymentId`: the first invocation writes the ledger row, bumps the
   * balance and stamps `creditedAt`; every later one observes the stamp inside the same
   * transaction and does nothing.
   *
   * @returns true if this call performed the credit, false if it had already happened.
   */
  creditDeposit(
    providerPaymentId: string,
    args: { creditedCents: number; txHash?: string; amountCrypto?: string; providerPayload?: unknown },
  ): Promise<boolean>;

  // --- Subscription ---------------------------------------------------------

  getSubscription(teamId: string): Promise<Subscription | null>;

  /** Activate or replace a team's package. Called after the purchase debit has succeeded. */
  activateSubscription(args: {
    teamId: string;
    tier: PaidPlanTier;
    profileLimit: number;
    priceCents: number;
    currentPeriodEnd: Date;
  }): Promise<Subscription>;

  setAutoRenew(teamId: string, autoRenew: boolean): Promise<Subscription>;

  /**
   * Attempt one monthly renewal: charge Credit and extend the period, atomically.
   *
   * WHY THIS IS ONE CALL AND NOT "debit, then extend". The renewal job runs on every backend
   * instance. Two instances polling the same due subscription would both debit and both extend —
   * the team pays twice for one month. `move` cannot prevent that: both debits are individually
   * legitimate against a sufficient balance.
   *
   * The fix is a compare-and-swap on `expectedPeriodEnd` performed in the SAME transaction as the
   * debit. Whichever instance updates the row first changes the period, so the other's CAS matches
   * nothing and it reports `not_due` without charging. Because the CAS and the debit share a
   * transaction, a crash between them rolls back both — the subscription is neither charged nor
   * extended, and the next sweep retries it cleanly.
   *
   * @param expectedPeriodEnd the `currentPeriodEnd` this attempt was planned against (the CAS
   *                          guard). A stale value means another instance got there first.
   * @returns `renewed` when Credit was debited and the period extended; `insufficient_credit` when
   *          the balance was short (nothing was written — the caller lapses it); `not_due` when
   *          another instance already handled this period.
   */
  renewSubscription(args: {
    teamId: string;
    expectedPeriodEnd: string;
    priceCents: number;
    newPeriodEnd: Date;
    description: string;
  }): Promise<'renewed' | 'insufficient_credit' | 'not_due'>;

  /** Flag a subscription as lapsed after a failed renewal attempt. */
  markPastDue(teamId: string, failureCode: string): Promise<void>;

  /** Subscriptions whose period has ended and are eligible for an auto-renew attempt. */
  findDueForRenewal(now: Date, limit: number): Promise<Subscription[]>;
}

/** Nest DI token for the active `BillingRepository`. */
export const BILLING_REPOSITORY = Symbol('BillingRepository');
