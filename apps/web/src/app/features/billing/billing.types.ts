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

export interface Subscription {
  teamId: string;
  tier: PlanTier;
  profileLimit: number;
  priceCents: number;
  status: 'active' | 'past_due' | 'canceled' | 'trialing';
  currentPeriodEnd?: string;
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
  amountCrypto?: string;
  creditedCents?: number;
  createdAt: string;
}
