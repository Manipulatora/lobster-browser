-- Metered Lobee spend: a ledger kind of its own, a sub-cent accrual, and a per-call audit.
--
-- Until now an agent call spent the operator's OpenRouter balance and metered nothing but a
-- process-local token counter that was lost on restart. Spend now lands on the team's wallet, and
-- these three changes are what make that chargeable and explicable.

-- ---------------------------------------------------------------------------
-- 1. CreditTxKind gains `agent_usage`
--
-- Its own kind rather than an `adjustment`, whose comment reserves it for a correction a human
-- decided on. Agent spend is machine-generated many times a day; folding it into adjustments would
-- make both unreadable and leave a dispute with nothing to separate them.
--
-- ADD VALUE, not a type rebuild: nothing is being removed, so the existing enum can be extended in
-- place. The new value is not USED anywhere in this migration, which is what Postgres requires of
-- a value added inside a transaction.
-- ---------------------------------------------------------------------------

ALTER TYPE "CreditTxKind" ADD VALUE 'agent_usage';

-- ---------------------------------------------------------------------------
-- 2. wallets.agentAccruedMicros — the sub-cent remainder
--
-- MICRO-USD, where 1 cent = 10,000. A single agent call routinely costs a fraction of a cent. A
-- whole-cent wallet can only round that: up, and a chatty session is overcharged by an order of
-- magnitude; down, and the agent is free. Calls accrue here instead and only whole cents are
-- flushed to `balanceCents`, so the remainder survives the next call and a restart alike.
--
-- The column also carries spend the balance could not cover, so it is not bounded by one cent. It
-- is bounded instead by the pre-flight reserve check refusing the NEXT call, which keeps it orders
-- of magnitude below the INTEGER ceiling (~$2,147).
-- ---------------------------------------------------------------------------

ALTER TABLE "wallets" ADD COLUMN "agentAccruedMicros" INTEGER NOT NULL DEFAULT 0;

-- ---------------------------------------------------------------------------
-- 3. agent_usage — one row per metered call
--
-- A ledger row for agent spend reads "Lobee — 3¢" and can say no more: it is the sum of many calls
-- flushed when the accrual crossed a cent. This table is what those cents were, and it is the only
-- thing that can answer a dispute.
--
-- Token counts are kept SPLIT rather than summed because they are billed at rates that differ by a
-- factor of five or more — output against fresh input against cached input. A summed "tokens used"
-- figure cannot be re-priced and cannot be checked.
-- ---------------------------------------------------------------------------

CREATE TABLE "agent_usage" (
    "id"           TEXT NOT NULL,
    "teamId"       TEXT NOT NULL,
    "userId"       TEXT,
    "profileId"    TEXT,
    "sessionId"    TEXT,
    "model"        TEXT NOT NULL,
    "tokensIn"     INTEGER NOT NULL,
    "tokensOut"    INTEGER NOT NULL,
    "cachedIn"     INTEGER NOT NULL,
    "costMicros"   INTEGER NOT NULL,
    "chargedCents" INTEGER NOT NULL,
    "createdAt"    TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "agent_usage_pkey" PRIMARY KEY ("id")
);

-- Every read of this table is one team over a time range: a statement line, a monthly total, or a
-- dispute.
CREATE INDEX "agent_usage_teamId_createdAt_idx" ON "agent_usage"("teamId", "createdAt");

ALTER TABLE "agent_usage" ADD CONSTRAINT "agent_usage_teamId_fkey"
  FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE CASCADE ON UPDATE CASCADE;
