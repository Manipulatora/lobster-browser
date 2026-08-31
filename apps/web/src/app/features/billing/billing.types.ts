/**
 * Wire types for the billing API.
 *
 * Mirrors `@lobster/shared-types`, restated here rather than imported: that package is not in this
 * app's dependency graph and carries Node-oriented types that have no business in a browser
 * bundle. The shapes are small and the backend has tests pinning the values, so the duplication is
 * cheap and visible.
 *
 * MONEY IS ALWAYS INTEGER CENTS. `1000` is $10.00. Nothing here is a dollar float.
 */

export type PlanTier = 'free' | 'light' | 'plus' | 'pro' | 'max';
export type PaidPlanTier = Exclude<PlanTier, 'free'>;

export interface PlanDefinition {
  tier: PaidPlanTier;
  name: string;
  priceCents: number;
  profileLimit: number;
}

/** How a package is paid for: every month, or twelve months up front at a discount. */
export type BillingPeriod = 'monthly' | 'yearly';

export interface Subscription {
  teamId: string;
  tier: PlanTier;
  profileLimit: number;
  priceCents: number;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  currentPeriodStart?: string;
  currentPeriodEnd?: string;
  /** Day of the month the package bills on, 1-31. */
  billingAnchorDay?: number;
  billingPeriod?: BillingPeriod;
  autoRenew: boolean;
  lastFailureCode?: string;
}

export interface DepositChainOption {
  code: string;
  chain: string;
  asset: string;
  /** What the USER's wallet pays to broadcast — not our fee and not the processor's. */
  networkFeeUsd: number;
  recommended: boolean;
  /** Asset icon slug under /coins/<icon>.svg — the coin itself. */
  icon: string;
  /**
   * Network icon slug, drawn as a badge on the asset icon. Undefined when the asset IS the chain.
   * Sending a token on the wrong chain loses it, so the badge is load-bearing, not decoration.
   */
  networkIcon?: string;
  /** True for a fiat-pegged token; the picker groups on this. */
  stable: boolean;
}

export interface BillingOverview {
  balanceCents: number;
  subscription: Subscription | null;
  plans: PlanDefinition[];
  chains: DepositChainOption[];
  freePlanProfileLimit: number;
  /** Whether the processor is usable right now; false means deposits cannot be started. */
  depositsAvailable: boolean;
  /**
   * The smallest deposit the API accepts, in USD cents — the server's `MIN_DEPOSIT_CENTS`,
   * forwarded so the amount field can refuse a below-minimum entry as it is typed AND name the
   * real floor, instead of hard-coding a figure that drifts the day the server's moves.
   */
  minDepositCents: number;
  /**
   * When Credit is next debited for the package, or null when nothing is due.
   *
   * The server's own figure, never recomputed here: a date this page worked out from a period
   * length is a date that can disagree with the charge, and the user finds out which was right
   * only afterwards.
   */
  nextBillingAt: string | null;
  /** The profile allowance actually in force — a lapsed or elapsed package entitles the free one. */
  entitledProfileLimit: number;
}

/**
 * What buying a package would mean for a team that already has one.
 *
 * `new`, `upgrade` and `extend` are charged; `same`, `downgrade` and `shorten` are refused. The
 * server decides which one applies — this is only the vocabulary the dialog labels it with.
 */
export type PlanChangeKind = 'new' | 'upgrade' | 'extend' | 'same' | 'downgrade' | 'shorten';

/**
 * Everything the confirmation dialog states, priced by the server.
 *
 * PRORATION CANNOT BE COMPUTED HERE. An upgrade credits the unused remainder of the live period,
 * which depends on the real period bounds and on the server's clock; a dialog that worked it out
 * locally would quote one amount and the purchase would take another. Every figure below is the
 * one the charge will use.
 */
export interface PlanChangeQuote {
  tier: PaidPlanTier;
  period: BillingPeriod;
  kind: PlanChangeKind;
  /** False for the three refused kinds — a different next step, not a failure. */
  allowed: boolean;
  priceCents: number;
  /** Credit for the unused remainder of the current period; 0 when there is none. */
  unusedCreditCents: number;
  /** What is actually debited. */
  dueCents: number;
  balanceCents: number;
  /** What the balance becomes. Negative exactly when the balance cannot cover it. */
  balanceAfterCents: number;
  /** How much more Credit is needed; 0 when the balance covers it. */
  shortfallCents: number;
  currentTier: PlanTier;
  currentPeriod: BillingPeriod | null;
  /** When the current package runs out — what a refused change has to wait for. */
  currentPeriodEnd: string | null;
  /** When the next renewal would charge, if this purchase went through now. */
  nextBillingAt: string;
}

export type CreditTxKind =
  'deposit' | 'purchase' | 'renewal' | 'refund' | 'adjustment' | 'agent_usage';

export interface CreditTransaction {
  id: string;
  kind: CreditTxKind;
  /** Signed: deposits and refunds positive, purchases and renewals negative. */
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  createdAt: string;
}

export interface DepositInstruction {
  depositId: string;
  address: string;
  /**
   * The memo / destination tag that must be sent WITH the transfer, on the chains that use one.
   *
   * The second half of the destination, not a detail: XRP, Stellar and Cosmos-style chains issue
   * one shared deposit address for every payment the processor takes and identify the depositor by
   * this tag alone, so a transfer that lands without it credits nobody and cannot be recovered.
   * Absent — never an empty string — on chains that issue a real per-payment address, and the page
   * must then render nothing tag-shaped at all.
   */
  paymentTag?: string;
  amountCrypto: string;
  asset: string;
  chain: string;
  amountCents: number;
  hostedUrl?: string;
}

export interface Deposit {
  id: string;
  status: 'pending' | 'confirming' | 'confirmed' | 'failed' | 'expired';
  chain: string;
  asset: string;
  /**
   * The address the transfer was to be sent to.
   *
   * Serialized so an open deposit survives a reload. Without it the tag below has nothing to be
   * beside, and the user is left holding an address in their wallet with no way to see the tag
   * that has to travel with it.
   */
  address?: string;
  /** What was invoiced, in USD cents, so a restored instruction shows the real figure. */
  amountCents?: number;
  /** The memo / destination tag the transfer had to carry, on the chains that use one. */
  paymentTag?: string;
  amountCrypto?: string;
  creditedCents?: number;
  createdAt: string;
}
