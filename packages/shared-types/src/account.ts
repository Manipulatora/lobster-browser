export type Role = 'admin' | 'member';

export interface User {
  id: string;
  email: string;
  /** The person's name as they entered it at sign-up. */
  displayName?: string;
  /** Organisation, collected at sign-up. Optional: signing up as an individual is legitimate. */
  company?: string;
  createdAt: string;
  /**
   * ISO instant the email address was proven, or undefined while unverified.
   *
   * Exposed on the public user so a client can show verification state without a second call.
   * It is a timestamp rather than a boolean because "when" matters for support and for expiring
   * accounts that never confirmed.
   */
  emailVerifiedAt?: string;
}

export interface Team {
  id: string;
  name: string;
  ownerUserId: string;
  createdAt: string;
}

export interface Membership {
  userId: string;
  teamId: string;
  role: Role;
  createdAt: string;
}

/** API key for the local automation API / backend programmatic access. */
export interface ApiKey {
  id: string;
  /** Only the prefix is stored/displayed after creation; the secret is shown once. */
  prefix: string;
  name: string;
  teamId: string;
  createdAt: string;
  lastUsedAt?: string;
}

/**
 * An immutable action/audit-log entry. Written by the backend whenever a meaningful action
 * happens (profile created, member invited, subscription changed, …) so a team has a durable,
 * append-only history. Rows are never updated or deleted in the ordinary flow — they are the
 * record of what happened. Every entry is scoped to exactly one team.
 */
export interface AuditLog {
  id: string;
  teamId: string;
  /** The user who performed the action; absent for system-originated events. */
  actorUserId?: string;
  /** Machine-readable action name, e.g. `profile.created` / `member.invited`. */
  action: string;
  /** The kind of thing the action targeted, e.g. `profile` / `membership`. */
  targetType: string;
  /** Id of the specific target, when the action concerns one. */
  targetId?: string;
  /** Free-form, non-secret context for the event (opaque JSON grab-bag). */
  metadata?: Record<string, unknown>;
  createdAt: string;
}

/**
 * `free` is the state every team starts in, not a sellable package — see {@link PLAN_CATALOG}
 * for the four that are.
 */
export type PlanTier = 'free' | 'light' | 'plus' | 'pro' | 'max';

/** The four sellable packages, in ascending order. Excludes `free`. */
export type PaidPlanTier = Exclude<PlanTier, 'free'>;

export interface PlanDefinition {
  tier: PaidPlanTier;
  /** Display name, e.g. "Pro". */
  name: string;
  /** Monthly price in USD CENTS. See the money note on {@link Wallet}. */
  priceCents: number;
  /** Number of profiles the package allows. */
  profileLimit: number;
}

/**
 * THE pricing table. Every price and profile count in the product resolves here — the web pricing
 * page, the purchase endpoint, the renewal job and the desktop launcher all read this constant.
 *
 * Deliberately not in the database: a price is a product decision that ships with a release and
 * belongs under code review, not a row an operator can edit into an inconsistent state. Purchased
 * subscriptions snapshot `priceCents`/`profileLimit` onto their own row at purchase time, so
 * changing a price here re-prices the storefront WITHOUT re-pricing existing subscribers.
 */
export const PLAN_CATALOG: readonly PlanDefinition[] = [
  { tier: 'light', name: 'Light', priceCents: 1_000, profileLimit: 10 },
  { tier: 'plus', name: 'Plus', priceCents: 6_000, profileLimit: 100 },
  { tier: 'pro', name: 'Pro', priceCents: 10_000, profileLimit: 200 },
  { tier: 'max', name: 'Max', priceCents: 20_000, profileLimit: 1_000 },
] as const;

/**
 * The packages the Lobee agent is included with.
 *
 * LIGHT IS EXCLUDED DELIBERATELY, and it is a paid package. Agent time is metered spend against a
 * managed model key rather than a seat, and the entry package is not priced to carry it — the
 * pricing page has always sold the agent from Plus upward, and this constant is what makes the
 * product agree with the page.
 *
 * THE single definition: the entitlement check, the panel's upsell copy and the pricing page all
 * resolve here, so an agent refusal can never disagree with what the storefront promised.
 */
export const AGENT_ENABLED_TIERS: readonly PlanTier[] = ['plus', 'pro', 'max'] as const;

/** Whether a team on this tier may run Lobee. `free` and `light` may not. */
export function planAllowsAgent(tier: PlanTier): boolean {
  return AGENT_ENABLED_TIERS.includes(tier);
}

/** The package a refused team is told to move to — the cheapest one that includes the agent. */
export const AGENT_MINIMUM_TIER: PaidPlanTier = 'plus';

/**
 * Profile allowance for a team that has never bought a package.
 *
 * THE single definition. The Prisma default on `Subscription.profileLimit` and
 * `ProfilesService.DEFAULT_FREE_PROFILE_LIMIT` are both aligned to this value, so a team behaves
 * identically before and after a Subscription row exists.
 */
export const FREE_PLAN_PROFILE_LIMIT = 3;

/** How a package is billed. Monthly is the base; yearly pays for twelve months up front. */
export type BillingPeriod = 'monthly' | 'yearly';

/**
 * Discount applied when twelve months are paid up front, as a fraction of the monthly rate × 12.
 *
 * A constant rather than a per-plan column so the storefront cannot drift from what is charged:
 * every yearly figure anywhere in the product is this one number applied to `priceCents`.
 */
export const YEARLY_DISCOUNT = 0.2;

/**
 * What twelve months of a package costs when paid up front, in USD cents.
 *
 * Rounded to a whole cent, and rounded ONCE here rather than at each display site — two places
 * rounding independently is how a storefront ends up quoting a price the charge does not match.
 */
export function yearlyPriceCents(plan: PlanDefinition): number {
  return Math.round(plan.priceCents * 12 * (1 - YEARLY_DISCOUNT));
}

/** What a yearly subscriber effectively pays per month. Display only — nothing charges this. */
export function yearlyPerMonthCents(plan: PlanDefinition): number {
  return Math.round(yearlyPriceCents(plan) / 12);
}

export function planByTier(tier: PaidPlanTier): PlanDefinition {
  const plan = PLAN_CATALOG.find((p) => p.tier === tier);
  // Unreachable while `tier` is typed, but this is also the runtime guard for values that arrive
  // over the wire from a client we do not control.
  if (!plan) throw new Error(`unknown plan tier: ${tier}`);
  return plan;
}

export type SubscriptionStatus = 'active' | 'past_due' | 'canceled' | 'trialing';

export interface Subscription {
  teamId: string;
  tier: PlanTier;
  /** Metered limit — number of profiles allowed on this plan. */
  profileLimit: number;
  /** What the next renewal will cost, in USD cents; snapshotted at purchase. */
  priceCents: number;
  status: SubscriptionStatus;
  /** ISO instant the current period ends and auto-renew becomes eligible; absent on `free`. */
  currentPeriodEnd?: string;
  autoRenew: boolean;
  /** Why the last renewal attempt failed, e.g. `insufficient_credit`. */
  lastFailureCode?: string;
}

// --- Credit / wallet -------------------------------------------------------

/**
 * A team's Credit balance.
 *
 * MONEY REPRESENTATION. Every USD amount crossing this API is an integer count of CENTS, never a
 * float — $10.00 is `1000`. Floats cannot represent 0.1 exactly, so a balance that is repeatedly
 * credited and debited drifts away from the ledger that is supposed to explain it. Formatting to
 * "$10.00" is a presentation concern and happens at the edge.
 */
export interface Wallet {
  teamId: string;
  balanceCents: number;
}

/**
 * What moved Credit.
 *
 * `agent_usage` is metered Lobee spend and is deliberately its OWN kind rather than an
 * `adjustment`. An adjustment means a human decided something; agent spend is machine-generated,
 * arrives many times a day, and has to be separable from operator corrections for a statement — or
 * a dispute — to mean anything.
 */
export type CreditTxKind =
  'deposit' | 'purchase' | 'renewal' | 'refund' | 'adjustment' | 'agent_usage';

/**
 * One entry in the append-only Credit ledger. `amountCents` is SIGNED: deposits and refunds are
 * positive, purchases and renewals negative.
 */
export interface CreditTransaction {
  id: string;
  teamId: string;
  kind: CreditTxKind;
  amountCents: number;
  balanceAfterCents: number;
  description: string;
  metadata?: Record<string, unknown>;
  createdAt: string;
}

export type DepositStatus = 'pending' | 'confirming' | 'confirmed' | 'failed' | 'expired';

/** An inbound crypto payment, from address issuance through to credited. */
export interface Deposit {
  id: string;
  teamId: string;
  provider: string;
  status: DepositStatus;
  chain: string;
  asset: string;
  /** Exact decimal string — crypto amounts exceed float precision and must not round-trip a Number. */
  amountCrypto?: string;
  address?: string;
  txHash?: string;
  /** USD cents credited; absent until confirmed. */
  creditedCents?: number;
  createdAt: string;
}

/**
 * A chain the user can deposit on, with the typical cost of SENDING on it.
 *
 * `networkFeeUsd` is the cost the USER pays their wallet to broadcast — it is not our fee and not
 * the processor's. It is surfaced because the spread is enormous and invisible at the moment of
 * choosing: a USDT transfer costs fractions of a cent on BSC and over a dollar on Tron, and that
 * is a property of the chains themselves, identical at every processor. Showing it moves most
 * users to a cheap rail for free.
 */
export interface DepositChainOption {
  /** Processor currency code, e.g. `usdtbsc`. */
  code: string;
  /** Chain display name, e.g. "BNB Smart Chain (BEP20)". */
  chain: string;
  asset: string;
  /** Indicative sending cost in USD. Order of magnitude, not a quote — it moves with gas prices. */
  networkFeeUsd: number;
  /** Cheap rails are offered first and one is preselected. */
  recommended: boolean;
  /** Asset icon slug under /coins/<icon>.svg — the coin itself (USDT, BTC …). */
  icon: string;
  /**
   * Network icon slug under /coins/<networkIcon>.svg, shown as a small badge on the asset icon.
   *
   * The same token rides several chains and sending it on the wrong one loses it, so the chain is
   * not secondary information here — the badge is what distinguishes USDT-on-Tron from
   * USDT-on-BNB at a glance. Undefined when the asset IS the chain (BTC on Bitcoin), where a badge
   * would just repeat the icon it sits on.
   */
  networkIcon?: string;
  /** True for a fiat-pegged token. Groups the list, since most people want a stablecoin. */
  stable: boolean;
}
