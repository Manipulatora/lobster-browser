-- The free allowance drops from 5 profiles to 3.
--
-- The column default has to move with `FREE_PLAN_PROFILE_LIMIT`, or a team created after this
-- release would still be seeded with the old allowance and behave differently from one whose limit
-- is read from the constant.
ALTER TABLE "subscriptions" ALTER COLUMN "profileLimit" SET DEFAULT 3;

-- Teams still on the free allowance are moved to the new one. Scoped to rows that are exactly the
-- old free value AND have never bought a package: a purchased subscription snapshots its own
-- profileLimit at purchase time precisely so a catalogue change cannot re-price or re-size it.
UPDATE "subscriptions" SET "profileLimit" = 3
WHERE "profileLimit" = 5 AND "tier" = 'free';
