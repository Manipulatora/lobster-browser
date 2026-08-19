import assert from 'node:assert/strict';
import { test } from 'node:test';

import { addPeriod, clampAnchorDay, nextCycle, subtractPeriod } from './billing-period';

/**
 * Every date in this file is written out in full and asserted as an exact ISO instant.
 *
 * Billing dates are the class of bug that comes back: the arithmetic looks obviously right, the
 * off-by-one only appears in February, and by the time anyone notices, the subscription has been
 * walking backwards for a year. Nothing here is computed from another date the code under test also
 * computes — the expected value is always typed out.
 */

const iso = (date: Date): string => date.toISOString();

// --- Calendar advance ---------------------------------------------------------

test('a January 31st subscription bills on the 28th in February and returns to the 31st in March', () => {
  // The whole reason the anchor is stored separately. Re-deriving it from February's clamped date
  // would move the billing day to the 28th permanently.
  const february = addPeriod(new Date('2026-01-31T12:00:00.000Z'), 'monthly', 31);
  assert.equal(iso(february), '2026-02-28T12:00:00.000Z');

  const march = addPeriod(february, 'monthly', 31);
  assert.equal(iso(march), '2026-03-31T12:00:00.000Z');

  // April is 30 days, so it clamps again — and May is 31 again.
  const april = addPeriod(march, 'monthly', 31);
  assert.equal(iso(april), '2026-04-30T12:00:00.000Z');
  assert.equal(iso(addPeriod(april, 'monthly', 31)), '2026-05-31T12:00:00.000Z');
});

test('February 29th is used in a leap year, and the anchor still returns to the 31st', () => {
  const february = addPeriod(new Date('2028-01-31T12:00:00.000Z'), 'monthly', 31);
  assert.equal(iso(february), '2028-02-29T12:00:00.000Z', '2028 is a leap year');
  assert.equal(iso(addPeriod(february, 'monthly', 31)), '2028-03-31T12:00:00.000Z');
});

test('a leap-day anchor lands on the 28th in the following common year', () => {
  // Someone who buys a yearly package on February 29th has no anniversary in 2029.
  const next = addPeriod(new Date('2028-02-29T00:00:00.000Z'), 'yearly', 29);
  assert.equal(iso(next), '2029-02-28T00:00:00.000Z');
});

test('a yearly period is twelve calendar months, not 365 days', () => {
  assert.equal(
    iso(addPeriod(new Date('2027-03-15T23:00:00.000Z'), 'yearly', 15)),
    '2028-03-15T23:00:00.000Z',
    'across a leap year, and still the same calendar day',
  );
});

test('the billing day survives the turn of the year', () => {
  assert.equal(
    iso(addPeriod(new Date('2026-12-31T00:00:00.000Z'), 'monthly', 31)),
    '2027-01-31T00:00:00.000Z',
  );
});

test('the time of day is carried across, so a 23:00 charge stays on its own calendar day', () => {
  // Read in local time this instant is already tomorrow east of Greenwich. The arithmetic is UTC
  // throughout precisely so the billing day does not depend on where the server is.
  const next = addPeriod(new Date('2026-03-15T23:00:00.000Z'), 'monthly');
  assert.equal(iso(next), '2026-04-15T23:00:00.000Z');
});

test('subtractPeriod is the mirror image, clamping the same way', () => {
  assert.equal(
    iso(subtractPeriod(new Date('2026-03-31T12:00:00.000Z'), 'monthly', 31)),
    '2026-02-28T12:00:00.000Z',
  );
  assert.equal(
    iso(subtractPeriod(new Date('2027-01-15T00:00:00.000Z'), 'monthly')),
    '2026-12-15T00:00:00.000Z',
  );
});

test('an anchor outside 1-31 is clamped rather than shifting the month', () => {
  assert.equal(clampAnchorDay(0), 1);
  assert.equal(clampAnchorDay(32), 31);
  assert.equal(clampAnchorDay(Number.NaN), 1);
});

// --- Where the next period lands ----------------------------------------------

test('a sweep that runs late keeps the billing day it was late for', () => {
  const cycle = nextCycle({
    previousEnd: new Date('2026-03-01T00:00:00.000Z'),
    now: new Date('2026-03-01T06:30:00.000Z'),
    period: 'monthly',
    anchorDay: 1,
    lapsed: false,
  });

  assert.equal(iso(cycle.start), '2026-03-01T00:00:00.000Z', 'the period ran from the last end');
  assert.equal(iso(cycle.end), '2026-04-01T00:00:00.000Z', 'six late hours are not added to it');
});

test('a 29-day lapse buys a whole month, not the three days left of the old one', () => {
  // The double charge this replaced: a period ending on the 1st, a deposit on the 29th, a full
  // month charged for the last two days of it, and another full month charged 48 hours later.
  const cycle = nextCycle({
    previousEnd: new Date('2026-01-01T00:00:00.000Z'),
    now: new Date('2026-01-29T09:00:00.000Z'),
    period: 'monthly',
    anchorDay: 1,
    lapsed: true,
  });

  assert.equal(iso(cycle.start), '2026-01-29T09:00:00.000Z', 'the lapsed window is not invoiced');
  assert.equal(iso(cycle.end), '2026-03-01T09:00:00.000Z', 'a month of service, on the 1st');
});

test('a lapse recovered the same day keeps the same billing day', () => {
  const cycle = nextCycle({
    previousEnd: new Date('2026-01-01T00:00:00.000Z'),
    now: new Date('2026-01-01T10:00:00.000Z'),
    period: 'monthly',
    anchorDay: 1,
    lapsed: true,
  });

  assert.equal(iso(cycle.end), '2026-02-01T10:00:00.000Z');
});

test('a yearly package recovering days late does not receive a free second year', () => {
  // The anchored date four days BEFORE a whole year is nearer than the one twelve months after it,
  // so the subscriber keeps January 1st rather than being handed 2028.
  const cycle = nextCycle({
    previousEnd: new Date('2026-01-01T00:00:00.000Z'),
    now: new Date('2026-01-05T00:00:00.000Z'),
    period: 'yearly',
    anchorDay: 1,
    lapsed: true,
  });

  assert.equal(iso(cycle.end), '2027-01-01T00:00:00.000Z');
});

test('however long the lapse, one pass lands the period in the future', () => {
  // The catch-up trap: with a period end still in the past, the row comes back as due on the very
  // next sweep, and again, each pass charging another month for service nobody received.
  const now = new Date('2026-05-20T10:00:00.000Z');
  const cycle = nextCycle({
    previousEnd: new Date('2026-01-01T00:00:00.000Z'),
    now,
    period: 'monthly',
    anchorDay: 1,
    lapsed: true,
  });

  assert.equal(iso(cycle.start), '2026-05-20T10:00:00.000Z');
  assert.equal(iso(cycle.end), '2026-07-01T10:00:00.000Z');
  assert.ok(cycle.end > now, 'the new period must end in the future');
});

test('a period end four months stale is rebased even when nothing was marked lapsed', () => {
  // An instance that stopped sweeping leaves `active` rows arbitrarily far behind. Advancing one
  // month at a time from the old end would charge each of the missed months in turn.
  const now = new Date('2026-05-20T10:00:00.000Z');
  const cycle = nextCycle({
    previousEnd: new Date('2026-01-01T00:00:00.000Z'),
    now,
    period: 'monthly',
    anchorDay: 1,
    lapsed: false,
  });

  assert.ok(cycle.end > now, 'one sweep must not leave the subscription still due');
  assert.equal(iso(cycle.end), '2026-07-01T10:00:00.000Z');
});

test('a 31st-of-the-month subscription renewing out of February returns to the 31st', () => {
  const cycle = nextCycle({
    previousEnd: new Date('2026-02-28T12:00:00.000Z'),
    now: new Date('2026-02-28T12:00:01.000Z'),
    period: 'monthly',
    anchorDay: 31,
    lapsed: false,
  });

  assert.equal(iso(cycle.end), '2026-03-31T12:00:00.000Z');
});
