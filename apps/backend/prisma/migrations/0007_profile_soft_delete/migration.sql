-- Profiles are soft-deleted from here on: DELETE is replaced by a `deletedAt` tombstone.
--
-- A hard delete leaves an offline machine no way to learn the profile is gone — on its next sync a
-- missing row is indistinguishable from "never synced", so it re-creates the profile. Existing rows
-- are left NULL (live), which is correct: nothing has ever been deleted through this path.
ALTER TABLE "profiles" ADD COLUMN "deletedAt" TIMESTAMP(3);

-- Every profile read is scoped to (ownerTeamId, live) — including the plan-limit count, which must
-- never charge a team for tombstones.
CREATE INDEX "profiles_ownerTeamId_deletedAt_idx" ON "profiles"("ownerTeamId", "deletedAt");
