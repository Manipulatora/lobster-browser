import {
  entitledProfileLimit,
  FREE_PLAN_PROFILE_LIMIT,
  type Subscription,
} from '@lobster/shared-types';

/** What the allowance rule reads from a subscription row — the slice `entitledProfileLimit` takes. */
export type AccountSubscription = Pick<
  Subscription,
  'status' | 'profileLimit' | 'currentPeriodEnd'
>;

/**
 * The profile allowance of a BILLING ACCOUNT — the user who owns a team — given every Subscription
 * row on a team that user owns.
 *
 * WHY THE ACCOUNT AND NOT THE TEAM. A plan is bought by a person, but the allowance used to be
 * counted per team, and teams were free to create. That made the paid limit optional: `POST /teams`,
 * then `POST /profiles?teamId=<new>` for another three free slots, repeated with curl. Every team
 * an account owns now draws on one allowance, so a new team is a way to organise profiles, not a
 * way to get more of them.
 *
 * WHY THE BEST ENTITLEMENT AND NOT THE SUM. Summing what each owned team is entitled to brings the
 * bypass back through a side door: a free-tier row is entitled to the free allowance, so three
 * free rows would sum to nine. Taking the single best live entitlement means a free team adds
 * nothing, a support-granted limit on a `free`-tier row still counts, a lapsed package still falls
 * back to the free allowance (both come through `entitledProfileLimit`, the one rule for "is this
 * entitlement live"), and a package bought twice by the same account does not double — which the
 * product cannot do anyway, since billing without an explicit teamId resolves to the account's own
 * team.
 *
 * With no rows at all the account is on the free allowance. The Prisma repository reports that
 * case as `null` from `getProfileLimit`, the wire contract that predates this rule.
 */
export function accountProfileLimit(
  subscriptions: readonly AccountSubscription[],
  now: Date = new Date(),
): number {
  let best: number | null = null;
  for (const subscription of subscriptions) {
    const entitled = entitledProfileLimit(subscription, now);
    if (best === null || entitled > best) best = entitled;
  }
  return best ?? FREE_PLAN_PROFILE_LIMIT;
}
