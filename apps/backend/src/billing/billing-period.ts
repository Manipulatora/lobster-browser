import type { BillingPeriod } from '@lobster/shared-types';

/**
 * Calendar arithmetic for the billing clock.
 *
 * EVERYTHING HERE IS UTC. A billing day is a calendar day, and which calendar day an instant falls
 * on depends on the zone it is read in: a purchase at 23:00 UTC is already tomorrow in Berlin and
 * still yesterday in Los Angeles. Deriving the anchor from local time would put a package bought at
 * 23:00 on a billing day one off from the day it was charged, and would move it again whenever the
 * server's zone changed. `getUTCDate`/`Date.UTC` are used exclusively for that reason.
 */

/**
 * Months in one billing period.
 *
 * Twelve months rather than 365 days, for the reason a month is not 30: a fixed day count walks a
 * yearly subscription off its anniversary every leap year.
 */
const PERIOD_MONTHS: Record<BillingPeriod, number> = { monthly: 1, yearly: 12 };

/** A paid window: `start` inclusive, `end` the instant the next charge falls due. */
export interface BillingCycle {
  start: Date;
  end: Date;
}

/**
 * Advance `from` by one billing period, landing on `anchorDay` clamped to the target month.
 *
 * THE CLAMP IS THE POINT. Months are 28 to 31 days long, so an anchor of the 31st has no date to
 * land on in February. Clamping puts that period end on the 28th (29th in a leap year) while the
 * anchor itself stays at 31, so the following period returns to the 31st. Naive month arithmetic
 * instead overflows February 31st into March 3rd, and re-deriving the anchor from a clamped date
 * walks the billing day permanently backwards.
 *
 * Time of day is carried across unchanged: the charge happens at the same instant of the day it
 * always has.
 */
export function addPeriod(
  from: Date,
  period: BillingPeriod,
  anchorDay: number = from.getUTCDate(),
): Date {
  return shiftMonths(from, PERIOD_MONTHS[period], anchorDay);
}

/** The mirror of {@link addPeriod}: where the period ending at `from` began. */
export function subtractPeriod(
  from: Date,
  period: BillingPeriod,
  anchorDay: number = from.getUTCDate(),
): Date {
  return shiftMonths(from, -PERIOD_MONTHS[period], anchorDay);
}

export interface NextCycleArgs {
  /** End of the period that just finished — what an on-time renewal advances from. */
  previousEnd: Date;
  /** When the renewal is being charged. */
  now: Date;
  period: BillingPeriod;
  /** The team's billing day, 1-31. */
  anchorDay: number;
  /**
   * Whether this charge is recovering a subscription that lapsed to `past_due`.
   *
   * The one fact the dates cannot supply. A renewal charged three weeks after its period end is
   * either a sweep that has not run in three weeks or a team that spent three weeks unable to pay,
   * and only the second means the entitlement was withdrawn for that window.
   */
  lapsed: boolean;
}

/**
 * The period a renewal running at `now` buys, given the period that just ended.
 *
 * ORDINARY RENEWAL — anchored to the previous END, not to `now`. A sweep that runs six hours late
 * must not add six hours to the billing month, or a subscription drifts by however long the job
 * happened to be delayed each time it ran.
 *
 * RECOVERY FROM A LAPSE — anchored to `now` instead. A team can sit in `past_due` for weeks waiting
 * to top up, and for all of that time the paid allowance is not honoured. Advancing from the old
 * period end would invoice the window they were locked out of and hand back only its remainder: a
 * team that lapsed on the 1st and deposited on the 29th would buy three days, and be charged again
 * for the next month three days later. So the recovered period starts now and ends on the anchor
 * day NEAREST one whole period away — the billing day survives the lapse without selling a
 * three-day month, and without (on a yearly package that recovered four days late) giving away a
 * second year.
 *
 * Either way the returned end is strictly after `now`, so one sweep can never leave a subscription
 * still due: the catch-up loop that would otherwise charge a four-month lapse four times over
 * cannot form.
 */
export function nextCycle(args: NextCycleArgs): BillingCycle {
  const { previousEnd, now, period, anchorDay, lapsed } = args;
  const anchored = addPeriod(previousEnd, period, anchorDay);
  // Not lapsed and the anchor is still ahead: the ordinary case, and the common one.
  if (!lapsed && anchored > now) return { start: previousEnd, end: anchored };
  return { start: now, end: recoveredEnd(now, period, anchorDay) };
}

/** The anchored period end nearest to one whole period after `now`. */
function recoveredEnd(now: Date, period: BillingPeriod, anchorDay: number): Date {
  const whole = addPeriod(now, period).getTime();
  const earlier = addPeriod(now, period, anchorDay);
  const later = addPeriod(earlier, period, anchorDay);
  return Math.abs(whole - earlier.getTime()) <= Math.abs(later.getTime() - whole) ? earlier : later;
}

/**
 * Shift by whole calendar months, clamping the day to the target month's length.
 *
 * `Date.UTC` normalises a month index outside 0-11 into the neighbouring year, so December + 1 and
 * January - 1 need no special case.
 */
function shiftMonths(from: Date, months: number, anchorDay: number): Date {
  const year = from.getUTCFullYear();
  const month = from.getUTCMonth() + months;
  const day = Math.min(clampAnchorDay(anchorDay), daysInMonth(year, month));
  return new Date(
    Date.UTC(
      year,
      month,
      day,
      from.getUTCHours(),
      from.getUTCMinutes(),
      from.getUTCSeconds(),
      from.getUTCMilliseconds(),
    ),
  );
}

/**
 * Keep a stored anchor inside the range a month can offer.
 *
 * Defensive on purpose: the anchor is a plain integer column, and a 0 or a 32 arriving from a
 * hand-edited row would otherwise silently produce a period end in the wrong month.
 */
export function clampAnchorDay(day: number): number {
  if (!Number.isFinite(day)) return 1;
  return Math.min(Math.max(Math.trunc(day), 1), 31);
}

/** Days in a UTC month, with `month` free to sit outside 0-11. */
function daysInMonth(year: number, month: number): number {
  // Day 0 of the following month is the last day of this one, leap years included.
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}
