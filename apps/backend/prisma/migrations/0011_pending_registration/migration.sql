-- Sign-up no longer creates an account before the emailed code is entered.
--
-- Registration previously created the User, the personal Team, the Membership and a signed token
-- immediately, then sent a code. Abandoning the form at the code step therefore left a real,
-- logged-in, unverified account behind; and because `users.email` is unique, anyone could burn the
-- address of someone who had not signed up yet.
--
-- Credentials now wait in `pending_registrations` until the code is proven, at which point the real
-- rows are created in one transaction. An abandoned sign-up simply expires.

CREATE TABLE "pending_registrations" (
    -- The address is the primary key: one live sign-up per address, and re-registering overwrites
    -- rather than leaving several valid codes outstanding.
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "company" TEXT,
    -- SHA-256 of the six-digit code; the code itself exists only in the email.
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    -- Brute-force bound. Six digits is a million possibilities against an endpoint that has to be
    -- public, because there is no session to authenticate at this point in the flow.
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pending_registrations_pkey" PRIMARY KEY ("email")
);

CREATE INDEX "pending_registrations_expiresAt_idx" ON "pending_registrations"("expiresAt");

-- Organisation, collected at sign-up. Nullable so accounts that predate the field stay valid.
ALTER TABLE "users" ADD COLUMN "company" TEXT;
