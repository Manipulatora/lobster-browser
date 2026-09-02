-- Server-side session revocation, and password change / reset.
--
-- A token is valid until it expires — seven days on the web, a YEAR for the desktop launcher, so
-- that opening a browser profile does not cost a browser round-trip every week. That bargain was
-- made with an open promise: "if a token has to be revoked sooner than this, that needs server-side
-- revocation, which no TTL substitutes for." Until now there was none. A launcher token that left
-- the machine it was issued to opened every profile snapshot, and the vault key with it, for as
-- long as a year, and the only remedy was rotating JWT_SECRET for every customer at once.
--
-- The revocation state is one integer per account. Every session token carries the version it was
-- minted under (`sv` in the claims); the guard refuses any other. Signing out everywhere bumps it;
-- changing or resetting the password bumps it in the same statement that writes the new hash, so
-- there is no instant at which the old password is gone but a token minted under it still works.
-- Tokens issued before this column existed carry no version and count as 0 — the default here —
-- so they keep working until the account is first revoked, and then die like any other.
ALTER TABLE "users" ADD COLUMN "sessionVersion" INTEGER NOT NULL DEFAULT 0;

-- The password reset the website's "forgot password" page has assumed since it shipped. A code is
-- mailed to the address; proving it sets a new password and revokes every session — a reset is the
-- answer to "someone else may have my password", and their sessions have to go with it.
--
-- One row per account, keyed by the user, for the same reason pending_registrations is keyed by the
-- address: re-requesting supersedes the previous code instead of leaving several valid at once, and
-- consuming a code DELETES the row, so the table holds at most one short-lived row per account.
CREATE TABLE "password_resets" (
    "userId" TEXT NOT NULL,
    -- SHA-256 of the six-digit code; the code itself exists only in the email.
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    -- Brute-force bound, as on every other six-digit code: the endpoint has to be public, because
    -- the person asking has no password to present.
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_resets_pkey" PRIMARY KEY ("userId")
);

CREATE INDEX "password_resets_expiresAt_idx" ON "password_resets"("expiresAt");

ALTER TABLE "password_resets" ADD CONSTRAINT "password_resets_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
