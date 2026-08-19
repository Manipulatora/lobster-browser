-- Per-account sign-in backoff.
--
-- The only throttle in front of /auth/login was the per-IP limiter, which keeps its counters in the
-- process: with several instances behind the proxy each one has its own bucket, and a spray that
-- tries one password against many accounts from many addresses fills none of them. The account
-- being guessed is the one place the pattern is visible, so the counter lives with the password.
--
-- A run of wrong passwords delays the next attempt, doubling and capped — never a permanent lock,
-- which would let anyone who knows an address keep its owner out. A successful sign-in clears both.
ALTER TABLE "users" ADD COLUMN "failedLoginAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "users" ADD COLUMN "lockedUntil" TIMESTAMP(3);
