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

/**
 * A deposit row as STORED, which is more than the wire type carries.
 *
 * `amountCents` (what the user asked for), `creditedAt` and `reversedAt` are settlement bookkeeping:
 * the client has no use for them, but crediting, reconciling and clawing back all turn on them.
 */
export interface StoredDeposit extends Deposit {
  /** The processor's own id, namespaced by provider. Never sent to a client. */
  providerPaymentId: string;
  /** What the user asked to deposit when the address was issued. Absent on rows that predate it. */
  amountCents?: number;
  creditedAt?: string;
  reversedAt?: string;
}

/**
 * Outcome of {@link BillingRepository.reverseDeposit}.
 *
 * `unrecoveredCents` is the part of a refunded deposit the wallet could not give back because it
 * had already been spent. It is reported rather than forced through: a negative balance is a debt
 * the product has no concept of, so the shortfall is surfaced for a human instead of invented.
 */
export interface DepositReversal {
  /** True when THIS call reversed a credit that was still standing. */
  reversed: boolean;
  clawedBackCents: number;
  unrecoveredCents: number;
}

/**
 * Outcome of {@link BillingRepository.changePlan}.
 *
 * `superseded` is not an error condition of the database — it is the ordinary answer to a
 * double-submitted purchase, and it is reported rather than retried: the second attempt was priced
 * against a period that no longer exists, so charging it would bill the team twice for one change.
 */
export type PlanChangeOutcome =
  | { status: 'changed'; subscription: Subscription }
  | { status: 'insufficient_credit' }
  | { status: 'superseded' };

/**
 * One metered Lobee call, as written to the usage audit.
 *
 * WHY EVERY FIELD IS HERE. A charge on a statement reads "Lobee — 3¢" and nothing else. When a
 * team asks what those three cents were, this row is the only answer available: which model ran,
 * whose session it was, which profile it ran in, how the tokens split, and what the split priced
 * at BEFORE the sub-cent accrual turned it into whole cents. `costMicros` and `chargedCents`
 * deliberately disagree on most rows — that difference IS the accrual, and hiding it would make
 * the audit unable to explain the very rounding it exists to justify.
 */
export interface AgentUsageEntry {
  teamId: string;
  /** The member whose session spent this. Absent for a run started by a system job. */
  userId?: string;
  /** The browser profile the run drove, when it ran in one. */
  profileId?: string;
  /** The Lobee run this call belonged to, so a whole run can be totalled. */
  sessionId?: string;
  model: string;
  /** Total prompt tokens; `cachedIn` is a subset, exactly as the provider reports it. */
  tokensIn: number;
  tokensOut: number;
  cachedIn: number;
  /** What the call cost in micro-USD, margin included. */
  costMicros: number;
  /** Whole cents this call actually flushed to the wallet — usually 0, occasionally 1 or more. */
  chargedCents: number;
}

export interface AgentUsageRow extends AgentUsageEntry {
  id: string;
  createdAt: string;
}

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

  // --- Agent metering -------------------------------------------------------

  /**
   * Add micro-USD of agent spend to the team's un-flushed accrual and return the NEW total.
   *
   * Increment-and-return in one call for the same reason `move` is one call: a read followed by a
   * write loses one of two concurrent agent calls, and the lost one is spend nobody is charged for.
   */
  accrueAgentMicros(teamId: string, micros: number): Promise<number>;

  /**
   * Take `micros` back out of the accrual so they can be charged as whole cents.
   *
   * Refuses (returns false) when the accrual is smaller than the claim, which is what makes two
   * concurrent flushes safe: both compute the same cent to charge, exactly one claims it.
   */
  claimAgentMicros(teamId: string, micros: number): Promise<boolean>;

  /** Micro-USD accrued and not yet charged — sub-cent change plus anything the balance could not cover. */
  getAgentAccruedMicros(teamId: string): Promise<number>;

  /** Append one per-call usage row. Append-only, like the ledger it explains. */
  recordAgentUsage(entry: AgentUsageEntry): Promise<void>;

  /** Newest-first usage page, for explaining a charge to the team that disputes it. */
  listAgentUsage(teamId: string, limit: number): Promise<AgentUsageRow[]>;

  // --- Deposits -------------------------------------------------------------

  createDeposit(deposit: {
    teamId: string;
    provider: string;
    providerPaymentId: string;
    /** What the user asked for, in USD cents — the figure the settled amount is reconciled against. */
    amountCents: number;
    chain: string;
    asset: string;
    address?: string;
    /**
     * The memo / destination tag issued with the address, on the chains that use one.
     *
     * Persisted rather than only shown, because it is what identifies the depositor: those chains
     * share one deposit address across every payment and separate them by this tag alone, so when
     * a transfer goes missing this is the value the sender's transaction has to be checked against.
     */
    paymentTag?: string;
    amountCrypto?: string;
  }): Promise<Deposit>;

  findDepositByProviderId(providerPaymentId: string): Promise<StoredDeposit | null>;

  listDeposits(teamId: string, limit: number): Promise<Deposit[]>;

  /**
   * Deposits that have not reached a terminal state, for the reconciliation sweep.
   *
   * Bounded at BOTH ends on purpose. `createdBefore` skips payments too young to have settled, so
   * the sweep does not poll the processor about every address the moment it is issued;
   * `createdAfter` stops it re-asking forever about addresses nobody ever sent to, which is the
   * normal fate of an abandoned deposit page.
   */
  findUnsettledDeposits(args: {
    createdBefore: Date;
    createdAfter: Date;
    limit: number;
  }): Promise<StoredDeposit[]>;

  /**
   * Write off ONE open deposit at the user's request — the server half of the payment page's
   * Cancel button.
   *
   * WHY THIS EXISTS. Cancelling used to clear only the client's signals, so the row stayed
   * `pending` forever and the billing page re-surfaced its address on every visit — an abandoned
   * payment that looked auto-generated. Cancel has to be a fact the server knows, or the server
   * keeps repeating the thing the user dismissed.
   *
   * NEVER TOUCHES MONEY, by predicate rather than by promise: the guard matches only
   * `status: 'pending'` with `creditedAt: null`, and is scoped to `teamId` so one team cannot
   * expire another's rows by guessing ids. A deposit that confirmed (or even started confirming)
   * between the click and this call matches nothing and keeps its state — and if funds land on
   * the address AFTER a cancel, `creditDeposit` still credits them, because its claim is on
   * `creditedAt: null`, not on the status this writes.
   *
   * @returns true when THIS call flipped the row; false for anything else — unknown id, another
   *          team's deposit, or a row no longer pending. All are the same harmless no-op.
   */
  cancelDeposit(teamId: string, depositId: string): Promise<boolean>;

  /**
   * Write off every pending, uncredited deposit older than `createdBefore`, across all teams —
   * the housekeeping half of the same cleanup.
   *
   * The normal fate of a deposit address is that nobody ever sends to it, and nothing in the
   * request path had a reason to close such a row — so they accumulated as `pending` forever, and
   * the newest one was what the billing page kept re-surfacing. Same money-safety shape as
   * {@link cancelDeposit}: `creditedAt: null` in the predicate, and a late payment still credits
   * because `creditDeposit` claims on `creditedAt`, never on status.
   *
   * @returns how many rows this sweep expired, for the caller's log line.
   */
  expireStaleDeposits(createdBefore: Date): Promise<number>;

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
    args: {
      creditedCents: number;
      txHash?: string;
      amountCrypto?: string;
      providerPayload?: unknown;
    },
  ): Promise<boolean>;

  /**
   * Record a terminal failure AND take back the Credit it had already minted, if any.
   *
   * WHY THIS IS NOT `updateDepositStatus`. A processor can refund or charge back a payment it has
   * already settled, and that callback arrives as an ordinary terminal status. Writing only the
   * status would leave the user holding both the returned crypto and the Credit — the merchant pays
   * for the deposit twice. The debit therefore has to happen in the SAME transaction as the status
   * write, or a crash between them loses one half of the reversal.
   *
   * EXACTLY-ONCE in the other direction, guarded exactly as `creditDeposit` is: the claim matches
   * only a deposit that WAS credited and has NOT been reversed, so a redelivered refund callback
   * debits nothing the second time. A deposit that never minted Credit is a plain status write.
   *
   * The debit is clamped at the current balance — see {@link DepositReversal.unrecoveredCents}.
   */
  reverseDeposit(
    providerPaymentId: string,
    status: DepositStatus,
    patch: { txHash?: string; amountCrypto?: string; providerPayload?: unknown },
  ): Promise<DepositReversal>;

  // --- Subscription ---------------------------------------------------------

  getSubscription(teamId: string): Promise<Subscription | null>;

  /**
   * Activate or replace a team's package. Called after the purchase debit has succeeded.
   *
   * The whole period is written together — start, end, anchor and cadence — because they only mean
   * anything as a set: an end without the anchor it was clamped from is a billing day that walks,
   * and an end without a start is a period nothing can be prorated against.
   */
  activateSubscription(args: {
    teamId: string;
    tier: PaidPlanTier;
    profileLimit: number;
    priceCents: number;
    billingPeriod: BillingPeriod;
    /** Day of the month every period after this one ends on, 1-31. */
    billingAnchorDay: number;
    currentPeriodStart: Date;
    currentPeriodEnd: Date;
  }): Promise<Subscription>;

  /**
   * Buy or change a package: debit the net cost and write the new period, atomically.
   *
   * WHY THIS IS ONE CALL AND NOT "debit, then activate". Purchases arrive from a browser, and a
   * browser double-submits — a second click, a retried request, two tabs. Two attempts that both
   * read the same subscription both price the same upgrade and both find the balance sufficient,
   * so the service-level "are you already on this package" check passes twice and the team is
   * charged twice for one plan change. `move` cannot prevent it: both debits are individually
   * legitimate against a healthy balance.
   *
   * The fix is the one {@link renewSubscription} uses — a compare-and-swap on the subscription
   * performed in the SAME transaction as the debit. Whichever attempt commits first moves the
   * period, so the other's CAS matches nothing and it reports `superseded` without charging. A
   * crash between the two rolls both back, leaving the team neither charged nor moved.
   *
   * @param expected the package this change was priced against, or null when the team had no
   *                 subscription row at all — which is why it is a nullable object rather than a
   *                 bare date: "no row yet" must CREATE, and a row whose period end happens to be
   *                 null must not. All three fields are compared, not just the date: an upgrade
   *                 bought at the same instant of the month as the package it replaces produces
   *                 the same period end, and a date-only guard would let a duplicate through.
   * @param dueCents what to debit. Positive: an allowed change always costs more than the credit
   *                 it reclaims, so a purchase is never a net refund.
   */
  changePlan(args: {
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
  }): Promise<PlanChangeOutcome>;

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
    newPeriodStart: Date;
    newPeriodEnd: Date;
    description: string;
  }): Promise<'renewed' | 'insufficient_credit' | 'not_due'>;

  /** Flag a subscription as lapsed after a failed renewal attempt. */
  markPastDue(teamId: string, failureCode: string): Promise<void>;

  /** Subscriptions whose period has ended and are eligible for an auto-renew attempt. */
  findDueForRenewal(now: Date, limit: number): Promise<Subscription[]>;

  /**
   * Subscriptions whose paid window has closed and which will NEVER be renewed, because auto-renew
   * is off. The complement of {@link findDueForRenewal}, and the half of the lifecycle that was
   * missing: with only the renewal query, such a row kept `status='active'` at its paid tier
   * forever with a period end in the past.
   */
  findDueForExpiry(now: Date, limit: number): Promise<Subscription[]>;

  /**
   * Move a lapsed subscription to `canceled` / `free`, compare-and-swapped on the period end so two
   * sweeps cannot both act on one row.
   *
   * @returns `expired` when this call performed the transition, `not_due` when another already did.
   */
  expireSubscription(args: {
    teamId: string;
    expectedPeriodEnd: string;
  }): Promise<'expired' | 'not_due'>;
}

/** Nest DI token for the active `BillingRepository`. */
export const BILLING_REPOSITORY = Symbol('BillingRepository');
