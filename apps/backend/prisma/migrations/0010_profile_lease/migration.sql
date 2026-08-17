-- Which device currently has a profile open.
--
-- A profile is one browser identity; running it from two machines at once means the same account
-- arriving from two IPs, which is the signal an anti-detect profile exists to avoid. profileId is the
-- PRIMARY KEY, so the database prevents two concurrent holders rather than application logic doing
-- it — a read-then-write acquire would let two callers both believe they hold the profile.
--
-- An expiry rather than a boolean, because a machine that crashes never clears a flag. The holder
-- refreshes while the browser runs; a crashed claim lapses on its own and needs no operator.
CREATE TABLE "profile_leases" (
    "profileId"   TEXT NOT NULL,
    "leaseId"     TEXT NOT NULL,
    "userId"      TEXT NOT NULL,
    "deviceId"    TEXT NOT NULL,
    "deviceLabel" TEXT NOT NULL,
    "acquiredAt"  TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt"   TIMESTAMP(3) NOT NULL,
    CONSTRAINT "profile_leases_pkey" PRIMARY KEY ("profileId")
);

CREATE INDEX "profile_leases_expiresAt_idx" ON "profile_leases"("expiresAt");

ALTER TABLE "profile_leases" ADD CONSTRAINT "profile_leases_profileId_fkey"
  FOREIGN KEY ("profileId") REFERENCES "profiles"("id") ON DELETE CASCADE ON UPDATE CASCADE;
