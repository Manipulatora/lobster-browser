-- Crypto Credit billing: wallets, an append-only Credit ledger, deposits, the new package tiers,
-- and the desktop launcher's authorisation grants.
--
-- Replaces the Stripe-shaped billing stub. Payment is crypto-only: users hold a USD Credit balance
-- topped up by on-chain deposits, and a package purchase or monthly renewal debits it. There is no
-- card on file, so `subscriptions.stripeCustomerId` is dropped rather than left dormant.

-- ---------------------------------------------------------------------------
-- 1. PlanTier: free|pro|team|enterprise  ->  free|light|plus|pro|max
--
-- Postgres cannot remove a value from an existing enum, so the type is rebuilt: create the new
-- type, migrate the column through text, drop the old one. Done before anything else because the
-- subscriptions table below depends on it.
--
-- EXISTING ROWS. `team` and `enterprise` no longer exist and must be mapped to something. They are
-- folded into the nearest new tier by size — team -> pro, enterprise -> max — which is also the
-- generous direction if any row is genuinely in use. In practice there should be none: the old
-- billing service was a stub that never called Stripe, so no subscription was ever activated
-- through it. The mapping is here so the migration is safe even if a row was seeded by hand.
-- ---------------------------------------------------------------------------

CREATE TYPE "PlanTier_new" AS ENUM ('free', 'light', 'plus', 'pro', 'max');

ALTER TABLE "subscriptions" ALTER COLUMN "tier" DROP DEFAULT;

ALTER TABLE "subscriptions"
  ALTER COLUMN "tier" TYPE "PlanTier_new"
  USING (
    CASE "tier"::text
      WHEN 'team' THEN 'pro'
      WHEN 'enterprise' THEN 'max'
      ELSE "tier"::text
    END
  )::"PlanTier_new";

DROP TYPE "PlanTier";
ALTER TYPE "PlanTier_new" RENAME TO "PlanTier";

ALTER TABLE "subscriptions" ALTER COLUMN "tier" SET DEFAULT 'free';

-- ---------------------------------------------------------------------------
-- 2. New enums
-- ---------------------------------------------------------------------------

CREATE TYPE "CreditTxKind" AS ENUM ('deposit', 'purchase', 'renewal', 'refund', 'adjustment');

CREATE TYPE "DepositStatus" AS ENUM ('pending', 'confirming', 'confirmed', 'failed', 'expired');

-- ---------------------------------------------------------------------------
-- 3. subscriptions: drop the Stripe column, add the renewal clock
-- ---------------------------------------------------------------------------

ALTER TABLE "subscriptions" DROP COLUMN IF EXISTS "stripeCustomerId";

ALTER TABLE "subscriptions" ADD COLUMN "priceCents" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "subscriptions" ADD COLUMN "currentPeriodEnd" TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN "autoRenew" BOOLEAN NOT NULL DEFAULT true;
ALTER TABLE "subscriptions" ADD COLUMN "lastRenewalAt" TIMESTAMP(3);
ALTER TABLE "subscriptions" ADD COLUMN "lastFailureCode" TEXT;

-- Backs the renewal sweep's "due for renewal" query.
CREATE INDEX "subscriptions_status_currentPeriodEnd_idx"
  ON "subscriptions"("status", "currentPeriodEnd");

-- ---------------------------------------------------------------------------
-- 4. wallets
--
-- `balanceCents` is a cached projection of credit_transactions, maintained in the same transaction
-- as every ledger row. Integer cents, never a float: a repeatedly credited and debited float
-- balance drifts away from the ledger that is meant to explain it.
-- ---------------------------------------------------------------------------

CREATE TABLE "wallets" (
    "teamId" TEXT NOT NULL,
    "balanceCents" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "wallets_pkey" PRIMARY KEY ("teamId")
);

ALTER TABLE "wallets" ADD CONSTRAINT "wallets_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 5. credit_transactions — append-only ledger
--
-- `amountCents` is SIGNED: deposits and refunds positive, purchases and renewals negative.
-- ---------------------------------------------------------------------------

CREATE TABLE "credit_transactions" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "kind" "CreditTxKind" NOT NULL,
    "amountCents" INTEGER NOT NULL,
    "balanceAfterCents" INTEGER NOT NULL,
    "description" TEXT NOT NULL,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "credit_transactions_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "credit_transactions_teamId_createdAt_idx"
  ON "credit_transactions"("teamId", "createdAt");

ALTER TABLE "credit_transactions" ADD CONSTRAINT "credit_transactions_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "wallets"("teamId") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 6. deposits
--
-- The UNIQUE on providerPaymentId is what makes webhook delivery safe. Processors retry and
-- deliver out of order, so the same "confirmed" callback arriving repeatedly is routine; crediting
-- is guarded by a null check on `creditedAt` inside the crediting transaction, so a duplicate
-- finds the deposit already credited and becomes a no-op instead of minting Credit twice.
--
-- amountCrypto is DECIMAL(38,18), not a float: 18 places is wei precision, and a double would lose
-- the low digits of a wei-denominated value outright.
-- ---------------------------------------------------------------------------

CREATE TABLE "deposits" (
    "id" TEXT NOT NULL,
    "teamId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerPaymentId" TEXT NOT NULL,
    "status" "DepositStatus" NOT NULL DEFAULT 'pending',
    "chain" TEXT NOT NULL,
    "asset" TEXT NOT NULL,
    "amountCrypto" DECIMAL(38,18),
    "address" TEXT,
    "txHash" TEXT,
    "creditedCents" INTEGER,
    "creditedAt" TIMESTAMP(3),
    "providerPayload" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "deposits_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "deposits_providerPaymentId_key" ON "deposits"("providerPaymentId");
CREATE INDEX "deposits_teamId_createdAt_idx" ON "deposits"("teamId", "createdAt");
CREATE INDEX "deposits_status_idx" ON "deposits"("status");

ALTER TABLE "deposits" ADD CONSTRAINT "deposits_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 7. desktop_auth_grants — one-time codes for the launcher's loopback sign-in
--
-- `codeHash` is stored hashed so a read of this table yields nothing redeemable, and
-- `codeChallenge` holds the PKCE challenge whose verifier never travels through the browser.
-- ---------------------------------------------------------------------------

CREATE TABLE "desktop_auth_grants" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "redeemedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "desktop_auth_grants_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "desktop_auth_grants_codeHash_key" ON "desktop_auth_grants"("codeHash");
CREATE INDEX "desktop_auth_grants_expiresAt_idx" ON "desktop_auth_grants"("expiresAt");

ALTER TABLE "desktop_auth_grants" ADD CONSTRAINT "desktop_auth_grants_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- 8. Backfill wallets for existing teams
--
-- Not strictly required — the repository upserts a wallet on first read, so a team without one
-- behaves correctly. Doing it here means the reconciliation query (sum of ledger vs balance) covers
-- every team from the start rather than only those that have visited the billing page.
-- ---------------------------------------------------------------------------

INSERT INTO "wallets" ("teamId", "balanceCents", "createdAt", "updatedAt")
SELECT "id", 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP FROM "teams"
ON CONFLICT ("teamId") DO NOTHING;
