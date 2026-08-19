-- Calendar billing: a period start, a billing anchor, and monthly-or-yearly.
--
-- Billing used to be a 30-day clock: a purchase set `currentPeriodEnd` to now + 30 days and every
-- renewal added 30 more. That is not a month, and the difference is not cosmetic. It walks the
-- billing day backwards — buy on the 31st of January and the dates run 03-02, 04-01, 05-01, 05-31,
-- 06-30 — and it fits 365/30 = 12.17 charges into a year on a package the storefront prices "/mo".
-- The row also held nothing but the END of the period, so there was no anchor to return to and
-- nothing to prorate a mid-period plan change against.
--
-- These three columns are what a calendar period needs. The renewal job advances whole months from
-- the anchor and clamps to the length of the month it lands in, so a subscription anchored to the
-- 31st bills on the 28th in February (29th in a leap year) and returns to the 31st in March.

-- ---------------------------------------------------------------------------
-- 1. BillingPeriod — how long one paid period lasts
--
-- The pricing page has always offered twelve months up front at a discount, and
-- `yearlyPriceCents` has always computed the figure, but the purchase path had nowhere to record
-- which of the two a subscriber chose — so it charged everyone monthly. The column is what makes
-- the choice storable, and the default keeps every existing row exactly as it is billed today.
-- ---------------------------------------------------------------------------

CREATE TYPE "BillingPeriod" AS ENUM ('monthly', 'yearly');

ALTER TABLE "subscriptions" ADD COLUMN "billingPeriod" "BillingPeriod" NOT NULL DEFAULT 'monthly';

-- ---------------------------------------------------------------------------
-- 2. currentPeriodStart — the other end of the window
--
-- Proration for a mid-period plan change divides remaining time by the period's length. With only
-- an end date that length has to be assumed, and any assumption is wrong for most months: the same
-- fraction of "30 days" is worth a different number of cents in February than in March. Nullable
-- because a team on `free` is inside no period at all.
-- ---------------------------------------------------------------------------

ALTER TABLE "subscriptions" ADD COLUMN "currentPeriodStart" TIMESTAMP(3);

-- ---------------------------------------------------------------------------
-- 3. billingAnchorDay — the day of the month the package bills on
--
-- Stored rather than read back off `currentPeriodEnd`, because that date is CLAMPED to the length
-- of the month it falls in. A 31st-of-the-month subscription lands on February 28th, and deriving
-- the anchor from that date would move it there permanently — the exact backwards walk this
-- migration exists to end. Nullable for the same reason as the start.
-- ---------------------------------------------------------------------------

ALTER TABLE "subscriptions" ADD COLUMN "billingAnchorDay" INTEGER;

-- ---------------------------------------------------------------------------
-- 4. Backfill, from the only evidence these rows carry
--
-- ANCHOR: the day of the month the team's current period ends on. Under the 30-day clock that date
-- had already drifted, and nothing on the row records where it started — but it is the date the
-- team will next be charged on, which is the one billing day they have actually seen. Anchoring
-- there changes nobody's next charge and stops the drift from that point on.
--
-- START: `lastRenewalAt` is stamped by both the purchase and the renewal path at the moment the
-- period began, so for every row written by either it IS the period start. The fallback covers
-- rows that predate the stamp, and the guard covers the one case that would produce a backwards
-- window (a stamp later than the end it belongs to), which would make proration meaningless.
-- ---------------------------------------------------------------------------

UPDATE "subscriptions"
   SET "billingAnchorDay" = EXTRACT(DAY FROM "currentPeriodEnd")::INTEGER
 WHERE "currentPeriodEnd" IS NOT NULL;

UPDATE "subscriptions"
   SET "currentPeriodStart" = CASE
         WHEN "lastRenewalAt" IS NOT NULL AND "lastRenewalAt" < "currentPeriodEnd"
           THEN "lastRenewalAt"
         ELSE "currentPeriodEnd" - INTERVAL '1 month'
       END
 WHERE "currentPeriodEnd" IS NOT NULL;
