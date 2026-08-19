#!/usr/bin/env node
/**
 * Apply the Prisma migration chain to a real Postgres and assert the resulting shape.
 *
 * WHY THIS GATE EXISTS. `prisma migrate dev` needs a live database, so a migration written on a
 * machine without one is unverified until it reaches an environment that has one — which is to say,
 * until it is deployed. That is the worst place to discover an `ALTER TYPE` that does not apply.
 *
 * PGlite is Postgres compiled to WASM: the actual engine, not a simulator. Enum rebuilds, DECIMAL
 * precision, conditional UPDATEs and cascading deletes all behave as they will in production, with
 * no service to install and nothing to clean up.
 *
 * It checks two different things, and both matter:
 *
 *   SCHEMA        — the migrations apply in order and leave the expected tables, columns, enum
 *                   values and constraints.
 *   BEHAVIOURAL   — the SQL-level invariants the billing code relies on actually hold. A
 *                   conditional debit really does refuse an overdraw; a duplicate
 *                   `providerPaymentId` really is rejected; crediting a deposit twice really does
 *                   match zero rows the second time. These are the guarantees that stop the
 *                   product giving away money, and they live in the database, not in TypeScript —
 *                   so this is the only place they can be tested.
 *
 * Run: `npm run gate:migrations`
 */
import { PGlite } from '@electric-sql/pglite';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS = join(here, '../../apps/backend/prisma/migrations');

const db = new PGlite();
let failures = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

/**
 * Rows that must already exist when a given migration runs.
 *
 * A migration that BACKFILLS is only half-tested by applying it to an empty database: the DDL runs,
 * the UPDATE matches nothing, and a backfill that converts the wrong column looks identical to one
 * that works. Seeding a row that predates the migration is the only way to see what it does to real
 * data — which is the data a deployment actually has.
 */
const SEED_BEFORE = {
  // A subscription as the 30-day clock left it: an end date, a renewal stamp, and no calendar
  // anchor anywhere.
  '0015_calendar_billing': `
    INSERT INTO users (id, email, "createdAt") VALUES ('u0', 'legacy@b.c', CURRENT_TIMESTAMP);
    INSERT INTO teams (id, name, "ownerUserId", "createdAt")
      VALUES ('t0', 'Legacy', 'u0', CURRENT_TIMESTAMP);
    INSERT INTO subscriptions ("teamId", tier, "profileLimit", status, "priceCents",
                               "currentPeriodEnd", "lastRenewalAt", "createdAt", "updatedAt")
      VALUES ('t0', 'pro', 200, 'active', 10000, TIMESTAMP '2026-03-17 09:00:00',
              TIMESTAMP '2026-02-15 09:00:00', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `,
};

// --- Apply every migration in order -----------------------------------------
const dirs = readdirSync(MIGRATIONS, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();

console.log('Applying migrations:');
for (const dir of dirs) {
  const sql = readFileSync(join(MIGRATIONS, dir, 'migration.sql'), 'utf8');
  try {
    if (SEED_BEFORE[dir]) await db.exec(SEED_BEFORE[dir]);
    await db.exec(sql);
    console.log(`  OK    ${dir}`);
  } catch (err) {
    console.log(`  ERROR ${dir}: ${err.message}`);
    process.exit(1);
  }
}

console.log('\nSchema assertions:');

// --- PlanTier was rebuilt with exactly the new values ------------------------
const tiers = await db.query(`
  SELECT e.enumlabel FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'PlanTier' ORDER BY e.enumsortorder
`);
const tierLabels = tiers.rows.map((r) => r.enumlabel);
check(
  'PlanTier = free,light,plus,pro,max',
  JSON.stringify(tierLabels) === JSON.stringify(['free', 'light', 'plus', 'pro', 'max']),
  `got ${JSON.stringify(tierLabels)}`,
);
check('old PlanTier_new type was renamed away', !(await typeExists('PlanTier_new')));

// --- The dropped Stripe column really is gone --------------------------------
check(
  'subscriptions.stripeCustomerId dropped',
  !(await columnExists('subscriptions', 'stripeCustomerId')),
);
for (const col of [
  'priceCents',
  'currentPeriodEnd',
  'currentPeriodStart',
  'billingAnchorDay',
  'billingPeriod',
  'autoRenew',
  'lastRenewalAt',
  'lastFailureCode',
]) {
  check(`subscriptions.${col} added`, await columnExists('subscriptions', col));
}

const periods = await db.query(`
  SELECT e.enumlabel FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'BillingPeriod' ORDER BY e.enumsortorder
`);
check(
  'BillingPeriod = monthly,yearly',
  JSON.stringify(periods.rows.map((r) => r.enumlabel)) === JSON.stringify(['monthly', 'yearly']),
  `got ${JSON.stringify(periods.rows.map((r) => r.enumlabel))}`,
);

// --- New tables ---------------------------------------------------------------
for (const table of [
  'wallets',
  'credit_transactions',
  'deposits',
  'desktop_auth_grants',
  'agent_usage',
]) {
  check(`table ${table} exists`, await tableExists(table));
}

// --- Agent spend has a ledger kind of its own, not a borrowed 'adjustment' ----
const kinds = await db.query(`
  SELECT e.enumlabel FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'CreditTxKind' ORDER BY e.enumsortorder
`);
check(
  "CreditTxKind includes 'agent_usage'",
  kinds.rows.some((r) => r.enumlabel === 'agent_usage'),
  `got ${JSON.stringify(kinds.rows.map((r) => r.enumlabel))}`,
);
check('wallets.agentAccruedMicros added', await columnExists('wallets', 'agentAccruedMicros'));

// --- The idempotency constraint that stops double-crediting -------------------
const uniq = await db.query(`
  SELECT indexname FROM pg_indexes
  WHERE tablename = 'deposits' AND indexdef LIKE '%UNIQUE%providerPaymentId%'
`);
check('deposits.providerPaymentId is UNIQUE', uniq.rows.length === 1);

// --- Behavioural checks: the invariants the code depends on -------------------
console.log('\nBehavioural assertions:');

// The 0015 backfill, against the row seeded before it ran. A subscription that predates calendar
// billing has to come out of the migration with a billing day and a period start, or the first
// sweep after deploy has nothing to anchor to and re-derives both from whatever it finds.
const legacy = await db.query(`
  SELECT "billingAnchorDay" AS anchor,
         "currentPeriodStart"::text AS start,
         "billingPeriod"::text AS period
  FROM subscriptions WHERE "teamId" = 't0'
`);
check(
  'backfill anchors a legacy row to the day it is next charged on',
  legacy.rows[0]?.anchor === 17,
  `got ${legacy.rows[0]?.anchor}`,
);
check(
  'backfill takes the period start from the last renewal',
  legacy.rows[0]?.start.startsWith('2026-02-15 09:00:00'),
  `got ${legacy.rows[0]?.start}`,
);
check('a legacy row bills monthly', legacy.rows[0]?.period === 'monthly');
// Removed before the cascade check below counts what a team deletion leaves behind.
await db.exec(`DELETE FROM teams WHERE id = 't0'`);

await db.exec(`
  INSERT INTO users (id, email, "createdAt") VALUES ('u1', 'a@b.c', CURRENT_TIMESTAMP);
  INSERT INTO teams (id, name, "ownerUserId", "createdAt")
    VALUES ('t1', 'T', 'u1', CURRENT_TIMESTAMP);
`);

// The 0003 backfill only covers teams that existed BEFORE it ran, so t1 (inserted after) has none.
// Insert explicitly, which is also what the repository's upsert-on-read does.
await db.exec(`
  INSERT INTO wallets ("teamId", "balanceCents", "createdAt", "updatedAt")
    VALUES ('t1', 0, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
    ON CONFLICT ("teamId") DO NOTHING;
`);

// The conditional-decrement guard: a debit larger than the balance must match zero rows.
await db.exec(`UPDATE wallets SET "balanceCents" = 1000 WHERE "teamId" = 't1'`);
const overdraw = await db.query(
  `UPDATE wallets SET "balanceCents" = "balanceCents" - 6000
   WHERE "teamId" = 't1' AND "balanceCents" >= 6000 RETURNING "balanceCents"`,
);
check('conditional debit refuses an overdraw', overdraw.rows.length === 0);

const affordable = await db.query(
  `UPDATE wallets SET "balanceCents" = "balanceCents" - 600
   WHERE "teamId" = 't1' AND "balanceCents" >= 600 RETURNING "balanceCents"`,
);
check('conditional debit succeeds when affordable', affordable.rows[0]?.balanceCents === 400);

// Duplicate webhook delivery: the unique constraint must reject the second insert.
await db.exec(`
  INSERT INTO deposits (id, "teamId", provider, "providerPaymentId", chain, asset, "updatedAt")
    VALUES ('d1', 't1', 'nowpayments', 'nowpayments:123', 'BSC', 'USDT', CURRENT_TIMESTAMP);
`);
let duplicateRejected = false;
try {
  await db.exec(`
    INSERT INTO deposits (id, "teamId", provider, "providerPaymentId", chain, asset, "updatedAt")
      VALUES ('d2', 't1', 'nowpayments', 'nowpayments:123', 'BSC', 'USDT', CURRENT_TIMESTAMP);
  `);
} catch {
  duplicateRejected = true;
}
check('duplicate providerPaymentId is rejected', duplicateRejected);

// The exactly-once claim: crediting twice must match zero rows the second time.
const firstClaim = await db.query(
  `UPDATE deposits SET "creditedAt" = CURRENT_TIMESTAMP, "creditedCents" = 5000
   WHERE "providerPaymentId" = 'nowpayments:123' AND "creditedAt" IS NULL RETURNING id`,
);
const secondClaim = await db.query(
  `UPDATE deposits SET "creditedAt" = CURRENT_TIMESTAMP, "creditedCents" = 5000
   WHERE "providerPaymentId" = 'nowpayments:123' AND "creditedAt" IS NULL RETURNING id`,
);
check('first credit claims the deposit', firstClaim.rows.length === 1);
check('second credit claims nothing (exactly-once)', secondClaim.rows.length === 0);

// Wei-precision amounts must survive the round trip without loss.
await db.exec(`UPDATE deposits SET "amountCrypto" = 123.456789012345678901 WHERE id = 'd1'`);
const precise = await db.query(`SELECT "amountCrypto"::text AS v FROM deposits WHERE id = 'd1'`);
check(
  'DECIMAL(38,18) keeps 18 fractional digits',
  precise.rows[0].v.startsWith('123.456789012345678'),
  `got ${precise.rows[0].v}`,
);

// The sub-cent accrual claim. Two agent calls that both cross the same cent boundary compute the
// same cent to flush; the predicate must let exactly one of them take it, or the team is charged
// twice for one cent.
await db.exec(`UPDATE wallets SET "agentAccruedMicros" = 12000 WHERE "teamId" = 't1'`);
const firstFlush = await db.query(
  `UPDATE wallets SET "agentAccruedMicros" = "agentAccruedMicros" - 10000
   WHERE "teamId" = 't1' AND "agentAccruedMicros" >= 10000 RETURNING "agentAccruedMicros"`,
);
const secondFlush = await db.query(
  `UPDATE wallets SET "agentAccruedMicros" = "agentAccruedMicros" - 10000
   WHERE "teamId" = 't1' AND "agentAccruedMicros" >= 10000 RETURNING "agentAccruedMicros"`,
);
check('accrual flush takes the cent once', firstFlush.rows[0]?.agentAccruedMicros === 2000);
check('a racing flush claims nothing and leaves the remainder', secondFlush.rows.length === 0);

// Renewal compare-and-swap: a stale expected period must match nothing.
await db.exec(`
  INSERT INTO subscriptions ("teamId", tier, "profileLimit", status, "priceCents",
                             "currentPeriodEnd", "createdAt", "updatedAt")
    VALUES ('t1', 'pro', 200, 'active', 10000, TIMESTAMP '2026-01-01 00:00:00',
            CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
`);
const staleCas = await db.query(`
  UPDATE subscriptions SET "currentPeriodEnd" = TIMESTAMP '2026-02-01 00:00:00'
  WHERE "teamId" = 't1' AND "currentPeriodEnd" = TIMESTAMP '2025-12-01 00:00:00' RETURNING "teamId"
`);
const freshCas = await db.query(`
  UPDATE subscriptions SET "currentPeriodEnd" = TIMESTAMP '2026-02-01 00:00:00'
  WHERE "teamId" = 't1' AND "currentPeriodEnd" = TIMESTAMP '2026-01-01 00:00:00' RETURNING "teamId"
`);
check('renewal CAS rejects a stale period', staleCas.rows.length === 0);
check('renewal CAS accepts the current period', freshCas.rows.length === 1);

// Deleting a team must take its money records with it.
await db.exec(`
  INSERT INTO agent_usage (id, "teamId", model, "tokensIn", "tokensOut", "cachedIn",
                           "costMicros", "chargedCents")
    VALUES ('au1', 't1', 'anthropic/claude-opus-4.8', 1000, 500, 400, 23550, 2);
`);
await db.exec(`DELETE FROM teams WHERE id = 't1'`);
const orphans = await db.query(`
  SELECT (SELECT count(*) FROM wallets)       AS w,
         (SELECT count(*) FROM deposits)      AS d,
         (SELECT count(*) FROM subscriptions) AS s,
         (SELECT count(*) FROM agent_usage)   AS a
`);
check(
  'team deletion cascades to wallet/deposits/subscription/agent usage',
  Number(orphans.rows[0].w) === 0 &&
    Number(orphans.rows[0].d) === 0 &&
    Number(orphans.rows[0].s) === 0 &&
    Number(orphans.rows[0].a) === 0,
  JSON.stringify(orphans.rows[0]),
);

console.log(failures === 0 ? '\nALL CHECKS PASSED' : `\n${failures} CHECK(S) FAILED`);
process.exit(failures === 0 ? 0 : 1);

async function tableExists(name) {
  const r = await db.query(`SELECT to_regclass($1) AS t`, [`public.${name}`]);
  return r.rows[0].t !== null;
}
async function typeExists(name) {
  const r = await db.query(`SELECT 1 FROM pg_type WHERE typname = $1`, [name]);
  return r.rows.length > 0;
}
async function columnExists(table, column) {
  const r = await db.query(
    `SELECT 1 FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`,
    [table, column],
  );
  return r.rows.length > 0;
}
