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

/**
 * What ONE billing period of a package costs, in USD cents — the figure actually debited.
 *
 * The purchase path and the renewal job both resolve the price through here, so a yearly
 * subscriber cannot be charged a monthly amount (or charged the yearly amount every month).
 */
export function periodPriceCents(plan: PlanDefinition, period: BillingPeriod): number {
  return period === 'yearly' ? yearlyPriceCents(plan) : plan.priceCents;
}

export function planByTier(tier: PaidPlanTier): PlanDefinition {
  const plan = PLAN_CATALOG.find((p) => p.tier === tier);
  // Unreachable while `tier` is typed, but this is also the runtime guard for values that arrive
  // over the wire from a client we do not control.
  if (!plan) throw new Error(`unknown plan tier: ${tier}`);
  return plan;
}

/**
 * Where a package sits in the range, ascending. `free` is below all four.
 *
 * Read off {@link PLAN_CATALOG}, which is already ordered by price, so there is ONE definition of
 * "a bigger package" — the storefront's Upgrade label, the purchase endpoint's downgrade refusal
 * and the quote a confirmation dialog renders cannot disagree about which way a change goes.
 */
export function planRank(tier: PlanTier): number {
  return tier === 'free' ? -1 : PLAN_CATALOG.findIndex((p) => p.tier === tier);
}

/**
 * What a requested package means for a team that already has one.
 *
 * THREE ARE CHARGED and three are refused, which is the whole plan-change policy in one type:
 *
 *   new       nothing is live — no package, a lapsed one, or a period that has already run out.
 *             The full period price is charged and no time is credited back.
 *   upgrade   a bigger package while a period is still paid for. The unused remainder is credited
 *             and the difference charged.
 *   extend    the same package, moving from monthly onto a year. Priced exactly like an upgrade.
 *
 *   same      already on this package, on this term.
 *   downgrade a smaller package while a bigger one is still paid for.
 *   shorten   leaving a prepaid year for a monthly term.
 *
 * WHY THE LAST TWO ARE REFUSED RATHER THAN PRORATED. Both hand Credit back for time already
 * granted, and both withdraw an allowance the team is using — a Max subscriber who moves to Light
 * loses 990 profiles the instant it applies. The product has exactly one way to spend less, and it
 * is the same one that reaches the free tier: turn auto-renew off, and buy the smaller package
 * when the current one runs out. Refusing here keeps that single path rather than adding a second
 * one that only works between two paid packages.
 *
 * The split also guarantees the arithmetic never inverts: every allowed change moves onto a package
 * that costs MORE than the credit it reclaims, so a purchase can never be a net refund.
 */
export type PlanChangeKind = 'new' | 'upgrade' | 'extend' | 'same' | 'downgrade' | 'shorten';

/** Whether {@link PlanChangeKind} is one of the three that are charged. */
export function planChangeAllowed(kind: PlanChangeKind): boolean {
  return kind === 'new' || kind === 'upgrade' || kind === 'extend';
}

/** The package a change is measured against. */
export interface CurrentPlan {
  tier: PlanTier;
  /** The term the package is on. Meaningless, and ignored, when it is not `live`. */
  period: BillingPeriod;
  /**
   * Whether a paid period is still running.
   *
   * A package that lapsed, was cancelled, or whose period simply ran out protects nothing and is
   * not owed anything back — so every purchase made against one is a plain `new` purchase.
   */
  live: boolean;
}

/** Classify a requested package against what the team already has. Pure; money is priced elsewhere. */
export function classifyPlanChange(
  current: CurrentPlan,
  target: { tier: PaidPlanTier; period: BillingPeriod },
): PlanChangeKind {
  if (!current.live || current.tier === 'free') return 'new';
  // Checked before the tier comparison: moving UP a tier but off a prepaid year is still leaving
  // eleven paid months on the table, and it is the yearly term that has to be answered for.
  if (current.period === 'yearly' && target.period === 'monthly') return 'shorten';

  const delta = planRank(target.tier) - planRank(current.tier);
  if (delta > 0) return 'upgrade';
  if (delta < 0) return 'downgrade';
  return current.period === target.period ? 'same' : 'extend';
}

/**
 * Everything a client needs to show what buying a package would do, BEFORE it does it.
 *
 * PRICED BY THE SERVER, on purpose. A confirmation dialog has to state the exact figure that will
 * leave the balance, and proration is the one number a client cannot work out for itself — it
 * depends on the real period bounds and on the server's clock. A dialog that computed it locally
 * would quote one amount and charge another.
 *
 * The money fields describe the charge as it would be made. When `allowed` is false there is no
 * charge to describe, so no credit is applied and `dueCents` is simply the list price.
 */
export interface PlanChangeQuote {
  tier: PaidPlanTier;
  period: BillingPeriod;
  kind: PlanChangeKind;
  allowed: boolean;
  /** List price of one period of the target package, in USD cents. */
  priceCents: number;
  /** Credit for the unused remainder of the live period; 0 when there is none to give back. */
  unusedCreditCents: number;
  /** What will actually be debited: `priceCents - unusedCreditCents`. Always above zero. */
  dueCents: number;
  balanceCents: number;
  /** What the balance becomes. Negative exactly when the balance cannot cover the purchase. */
  balanceAfterCents: number;
  /** How much more Credit is needed; 0 when the balance covers it. */
  shortfallCents: number;
  /** The tier in force right now. */
  currentTier: PlanTier;
  /** The term the live package is on, or null when nothing is live. */
  currentPeriod: BillingPeriod | null;
  /** When the live period runs out — what a refused change has to wait for. Null when none is. */
  currentPeriodEnd: string | null;
  /** The instant the next renewal would charge, if this purchase went through now. */
  nextBillingAt: string;
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
  /**
   * ISO instant the current period began; absent on `free`.
   *
   * The other end of the window `currentPeriodEnd` closes, and the only thing proration can be
   * measured against: without it, "how much of this period is left" has to be guessed from an
   * assumed period length, which is wrong for every month that is not exactly that long.
   */
  currentPeriodStart?: string;
  /** ISO instant the current period ends and auto-renew becomes eligible; absent on `free`. */
  currentPeriodEnd?: string;
  /**
   * Day of the month the package bills on, 1-31; absent on `free`.
   *
   * Stored rather than read off `currentPeriodEnd`, because the end is CLAMPED to the length of the
   * month it lands in. A subscription anchored to the 31st bills on the 28th in February, and
   * re-deriving the anchor from that date would move it there permanently — the billing day walking
   * backwards a few days a year, which is exactly what a calendar anchor exists to prevent.
   */
  billingAnchorDay?: number;
  /** Whether the package is billed every month or twelve months up front. */
  billingPeriod?: BillingPeriod;
  autoRenew: boolean;
  /** Why the last renewal attempt failed, e.g. `insufficient_credit`. */
  lastFailureCode?: string;
}

/**
 * The profile allowance a team is ACTUALLY entitled to right now.
 *
 * `profileLimit` records what was BOUGHT, and it stays on the row when a renewal fails and when a
 * period simply runs out with auto-renew off. Reading it directly is how a team that stopped paying
 * keeps a Max allowance forever, for free — the row still says 1,000.
 *
 * THE single definition of "is this entitlement live", so the cap the API enforces, the meter the
 * desktop draws and the plan the dashboard names cannot disagree. `trialing` counts as live: a
 * trial is a granted period, and collapsing it would refuse profiles the server would accept.
 */
export function entitledProfileLimit(
  subscription: Pick<Subscription, 'status' | 'profileLimit' | 'currentPeriodEnd'> | null,
  now: Date = new Date(),
): number {
  if (!subscription) return FREE_PLAN_PROFILE_LIMIT;
  if (subscription.status !== 'active' && subscription.status !== 'trialing') {
    return FREE_PLAN_PROFILE_LIMIT;
  }
  // An elapsed period is a lapse the renewal sweep has not reached yet — or one it never will,
  // because auto-renew is off. Either way the paid window is over and the allowance with it.
  if (subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd) <= now) {
    return FREE_PLAN_PROFILE_LIMIT;
  }
  return subscription.profileLimit;
}

/**
 * The tier a team is ACTUALLY entitled to right now — `entitledProfileLimit`'s rule, applied to the
 * other thing a plan buys.
 *
 * The profile cap already lapsed correctly when a period elapsed; the agent gate did not. It read
 * `status === 'active'` alone, and nothing ever writes `canceled`: `findDueForRenewal` selects only
 * `autoRenew: true` rows, so a package with auto-renew OFF keeps `status='active'` and `tier='pro'`
 * forever with `currentPeriodEnd` in the past. That is not a subscription that has not been swept
 * yet — it is one that will never be swept, so the expiry cannot be left to a background job to
 * express. Deriving the tier from the period end makes the lapse true the moment it happens, no
 * matter what the row says, and keeps the agent gate and the profile cap on one rule instead of two.
 *
 * `trialing` counts as live for the same reason it does above: a trial is a granted period.
 */
export function planEntitledTier(
  subscription: Pick<Subscription, 'status' | 'tier' | 'currentPeriodEnd'> | null,
  now: Date = new Date(),
): PlanTier {
  if (!subscription) return 'free';
  if (subscription.status !== 'active' && subscription.status !== 'trialing') return 'free';
  if (subscription.currentPeriodEnd && new Date(subscription.currentPeriodEnd) <= now) {
    return 'free';
  }
  return subscription.tier;
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
  /**
   * What the user asked to deposit, in USD cents, at the moment the address was issued.
   *
   * Serialized so an open deposit can be shown again after a reload without inventing a figure.
   * Nullable on rows written before the column existed.
   */
  amountCents?: number;
  amountCrypto?: string;
  address?: string;
  /**
   * The memo / destination tag the transfer had to carry, on the chains that use one.
   *
   * Beside `address` because on those chains it is not extra detail, it is the other half of the
   * destination: XRP, Stellar and Cosmos reuse ONE shared deposit address for every payment and
   * identify the depositor by this tag alone, so a transfer that arrives without it credits nobody
   * and cannot be recovered. Absent on chains that issue a real per-payment address.
   */
  paymentTag?: string;
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
