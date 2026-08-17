-- Email verification moves from a 24h emailed link to a 15-minute 6-digit code.
--
-- The unique index on tokenHash has to go: six digits collide, and with a unique index one user's
-- pending code would block another user from ever being issued the same one. Lookups are scoped by
-- userId instead, which is also what stops a submitted code from matching a stranger's record.
DROP INDEX IF EXISTS "email_verifications_tokenHash_key";
CREATE INDEX IF NOT EXISTS "email_verifications_tokenHash_idx" ON "email_verifications"("tokenHash");

-- Attempts against a 6-digit secret must be countable, or the 1-in-a-million guess becomes a
-- 1-in-a-few-thousand guess for anyone willing to send requests in a loop.
ALTER TABLE "email_verifications" ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;

-- Codes issued under the old link scheme cannot be entered as a 6-digit code; expire them rather
-- than leaving rows that can never be consumed.
UPDATE "email_verifications" SET "expiresAt" = now() WHERE "consumedAt" IS NULL;
