# Credit, crypto payments, and the desktop sign-in

How money and identity work across the three surfaces (backend, website, launcher), and the
decisions behind the parts that are not obvious.

---

## 1. The billing model in one paragraph

Users hold a **Credit** balance denominated in USD. They top it up with cryptocurrency, in any
amount, at any time. Buying a package **debits Credit**. Every 30 days the renewal sweep debits it
again for the same package. If the balance is short, the subscription lapses to `past_due` and
recovers by itself the next time a deposit lands. There is no card, no external subscription
object, and no recurring mandate against anything outside the account — Credit behaves like a
prepaid balance, and the only way money enters the system is a confirmed on-chain payment.

### Packages

| Tier  | Price  | Profiles |
| ----- | ------ | -------- |
| Free  | $0     | 5        |
| Light | $10/mo | 10       |
| Plus  | $60/mo | 100      |
| Pro   | $100/mo| 200      |
| Max   | $200/mo| 1,000    |

Defined once, in `PLAN_CATALOG` (`packages/shared-types/src/account.ts`). The API, the renewal job
and the launcher all read it from there.

**The pricing page duplicates these numbers**, deliberately: the marketing site is prerendered and
statically served, so fetching the catalog would leave an empty price table in the prerendered HTML
and shift the layout on hydration. A wrong number in `pricing-page.ts` is therefore a real defect —
change both together.

`Subscription.priceCents` and `profileLimit` are **snapshotted at purchase**. Re-pricing the
catalog changes the storefront without re-pricing existing subscribers.

### Changing package mid-period

Switching packages **credits back the unused part of the current period**, prorated by elapsed time
and floored to the cent. Upgrading from Light to Pro on day two of a Light month costs
`$100 − ~$9.33`, not `$100`.

Without this, an ordinary action — upgrading — would silently confiscate time the customer had
already paid for. The refund and the charge are applied as **one net movement**, never as a refund
followed by a charge: two movements can half-apply, leaving either a windfall plus the old package,
or a double payment.

No credit is given when the subscription is `past_due` (the last renewal was not paid, so there is
no paid period to refund) or when the period has already ended.

---

## 2. Money representation

**Every USD amount is an integer count of cents.** `$10.00` is `1000`. This holds in the database,
across the wire, and in both frontends. Floats cannot represent `0.1` exactly, so a balance that is
repeatedly credited and debited drifts away from the ledger meant to explain it.

**Crypto amounts are `DECIMAL(38,18)`** in Postgres and **exact decimal strings** on the wire. 18
places is wei precision; a double loses the low digits outright.

The wallet's `balanceCents` is a **cached projection** of the `credit_transactions` ledger, written
only inside the same transaction as the row that justifies it. So this is a genuine integrity
check, not a tautology:

```sql
SELECT w."teamId", w."balanceCents", COALESCE(SUM(t."amountCents"), 0) AS ledger
FROM wallets w LEFT JOIN credit_transactions t ON t."teamId" = w."teamId"
GROUP BY w."teamId", w."balanceCents"
HAVING w."balanceCents" <> COALESCE(SUM(t."amountCents"), 0);
```

Any row returned is a bug. It should always return none.

---

## 3. The three concurrency hazards, and what stops each

These are the places where getting it wrong costs real money. All three are enforced **in SQL**,
not in TypeScript, and all three are covered by `npm run gate:migrations`.

### Double-spend on purchase

Two concurrent purchases both read a $100 balance, both decide a $60 package is affordable, both
write $40 — two packages for one package's Credit.

Prevented by putting the sufficiency check **inside the UPDATE predicate**, so the check and the
decrement are one atomic statement:

```sql
UPDATE wallets SET "balanceCents" = "balanceCents" - :amount
WHERE "teamId" = :team AND "balanceCents" >= :amount
```

The second transaction re-evaluates against the already-decremented row, matches nothing, and gets
`count = 0`. This is why `BillingRepository` exposes `move()` rather than a getter and a setter —
the racy version cannot be written against the interface.

### Double-credit on webhook redelivery

Payment processors retry aggressively and deliver out of order. The same `finished` callback
arriving three times is routine operation, not an attack.

Prevented by `deposits.providerPaymentId UNIQUE` plus a `creditedAt IS NULL` predicate on the
claiming UPDATE. Exactly one delivery claims the row; the rest are no-ops that report success so
the processor stops retrying.

### Double-charge on renewal

The renewal sweep runs on **every backend instance**. Two instances seeing the same due
subscription would both debit — the team pays twice for one month.

Prevented by a compare-and-swap on `currentPeriodEnd` in the **same transaction** as the debit.
Whichever instance commits first changes the period, so the other's CAS matches nothing and it
reports `not_due` without charging. Because the CAS and the debit share a transaction, a crash
between them rolls back both.

### The catch-up trap (a bug that was found and fixed)

Anchoring a renewal to the previous period end is correct for keeping the billing date stable — but
if a team lapses for longer than one period, `previousEnd + 30d` is **still in the past**. The row
comes back as due on the very next sweep, and again, and again. A team returning after four months
would have a fresh $10 deposit consumed in seconds by four retroactive renewals for service they
never received.

`nextPeriodEnd()` therefore rebases a past period onto `now`. Missed months are forgiven rather
than invoiced, and each sweep can charge a given subscription at most once. Covered by the test
`a long lapse is not billed retroactively`.

---

## 4. NOWPayments integration

### Configuration

| Variable | Purpose |
| --- | --- |
| `NOWPAYMENTS_API_KEY` | Creating deposit addresses |
| `NOWPAYMENTS_IPN_SECRET` | Verifying callbacks — the only thing between a POST and minted Credit |
| `NOWPAYMENTS_IPN_CALLBACK_URL` | Public HTTPS URL for `/billing/webhook` |
| `NOWPAYMENTS_FEE_PAID_BY_USER` | Optional, default off — charge the commission to the customer |
| `NOWPAYMENTS_FIXED_RATE` | Optional, default off — lock the quoted rate |

The last two are sent as `is_fee_paid_by_user` and **`is_fixed_rate`** — note the `is_` prefix on
the rate lock. It was previously sent as `fixed_rate`, which NOWPayments ignores: the request still
returned 200, nothing was logged, and every payment ran unlocked while the config said otherwise.
Both default off and are omitted from the request entirely unless set.

There is no `PAYMENT_PROVIDER` selector. One processor is bound directly in `billing.module.ts`;
a selector whose default silently decided which company handled the money was not worth keeping.

### Which rails are offered

`deposit-chains.ts` is our curated catalogue, but the codes in it are NOWPayments' and can stop
being valid without notice. `NowPaymentsProvider` loads the live list from the unauthenticated
`GET /v1/currencies` at boot (refreshed hourly) and `supportsCurrency` filters the catalogue
against it, so a rail that is no longer offered disappears from the deposit page rather than
failing after the user has chosen it and committed to an amount.

The first time that check ran for real it removed four entries: `bnb` (the code is `bnbbsc`),
`dot`, `usdctrc20` and `usdcerc20` — the last three do not exist at NOWPayments at all.

If the list cannot be loaded the check **fails open** and every catalogue rail stays offerable.
`createDeposit` still fails closed against the live API, and an outage turning the page from
"some rails missing" into "deposits look impossible" is the worse failure.

Adding an entry means confirming its **network**, not just that the code resolves — the code alone
does not say which chain the address will be on (NOWPayments has a bare `usdc` whose network is
only visible through the authenticated `/v1/full-currencies`), and a wrong `chain` label tells the
user to send on a chain the address cannot receive.

### IPN signature — the unusual part

NOWPayments does **not** sign the bytes it sent. It signs
`JSON.stringify(payload with every object's keys sorted, recursively)`, HMAC-SHA512, hex, keyed
with the IPN secret, in the `x-nowpayments-sig` header.

Verification therefore has to parse the body, re-sort it, and re-serialise it — which means the
comparison depends on our `JSON.stringify` producing the same text theirs did. **The realistic
failure mode is numeric**: a value they emit as `5.0` re-serialises from a JS number as `5`, and
the signature will not match. If *every* callback is being rejected, suspect this before suspecting
an attacker; the mismatch log line says so explicitly.

`main.ts` is created with `rawBody: true` so the undecoded bytes are available. Without it, every
deposit callback is rejected and no Credit ever lands.

### Status mapping — the distinction that costs money

NOWPayments uses `confirmed` for *blockchain-confirmed* and `finished` for *settled to the
merchant*. **Only `finished` mints Credit.** Crediting on `confirmed` would hand out balance for
payments that can still fail during settlement.

| NOWPayments | Ours | Credits? |
| --- | --- | --- |
| `waiting` | `pending` | no |
| `confirming`, `confirmed`, `sending`, `partially_paid` | `confirming` | no |
| `finished` | `confirmed` | **yes** |
| `failed`, `refunded` | `failed` | no |
| `expired` | `expired` | no |

`partially_paid` maps to `confirming`, not to a failure: the user underpaid and the payment is
still open. Treating it as terminal would strand real money.

### What gets credited

Gross — the full USD value of what the user sent, with the processor's commission as our cost.
Someone who deposits $50 expects to see $50 of Credit. Under- and overpayment are handled by
scaling: `price_amount x (actually_paid / pay_amount)`.

---

## 5. Chain steering, and the TRC20 question

The fee difference between chains is a **property of the chains**, not of the processor. Measured
against live chain state on 2026-08-14:

| | Cost to send one USDT transfer |
| --- | --- |
| BEP20 (BSC) | **$0.0017** — 0.05 gwei x 55k gas, BNB @ $606 |
| TRC20 (Tron) | **$1.06 – $2.16** — `getEnergyFee` 100 SUN x 32–65k energy, TRX @ $0.332 |

A ~600–1,300x gap, and every processor pays it. **Switching payment processors cannot change
this.** The only things that do are using a cheaper chain or renting Tron energy.

So `deposit-chains.ts` curates a short list sorted cheapest-first, and the deposit UI prints the
network cost next to each option. Tron is deliberately still offered — it is the habitual choice for
much of this market and removing it would just send people away — but it is not recommended and its
real cost is shown. On a $10 deposit, Tron takes 10–20% before it arrives; BSC takes about a
fiftieth of a cent.

The figures are indicative and move with gas and token prices. Re-measure before relying on them.

---

## 6. Authentication

### Website

Sign-up and sign-in are a **modal**, not a page — signing up is nearly always something a visitor
does mid-read, and routing them away discards that context. `/signup` and `/login` remain real URLs
(the launcher opens them; people paste them) that resolve to a backdrop with the modal open. The old
`/auth/sign-in` and `/auth/sign-up` routes redirect rather than 404, because they were public.

The bearer token lives in `localStorage`, which is readable by any script on the origin — a
successful XSS is a session compromise. An httpOnly cookie would not be. It is used anyway because
the API is bearer-token based and the launcher needs the same token over the same endpoints; two
auth mechanisms in one backend is the worse trade. The mitigation that matters is keeping the origin
free of injection.

### Desktop launcher — loopback with PKCE

The launcher never handles a password. Instead (RFC 8252):

1. It picks a random `state` and PKCE `verifier`, derives `challenge = base64url(SHA256(verifier))`,
   and binds a listener on `127.0.0.1:0` (the OS assigns a free port).
2. It opens the system browser at `lobrowser.com/login?desktop=1&state=…&port=…&challenge=…`.
3. The user authenticates on the website as normal.
4. The site calls `POST /auth/desktop/grant` with its own session and gets a one-time code, then
   redirects to `http://127.0.0.1:<port>/callback?code=…&state=…`.
5. The launcher checks `state`, then calls `POST /auth/desktop/exchange` over HTTPS with the code
   **and the verifier**, and receives the real token.

**A loopback redirect has several distinct weaknesses and one mitigation does not cover them all:**

| Mechanism | Defends against |
| --- | --- |
| `state` | A code minted for one launcher instance being replayed into another; CSRF on the callback |
| **PKCE** | A hostile local process binding the callback port and stealing the code — it cannot redeem it, because the verifier never travels through the browser |
| Single-use (`redeemedAt IS NULL` claim) | Replay of a code captured from browser history or a proxy log |
| 5-minute TTL | The window in which any of the above is worth attempting |
| Server-built redirect URL | An open redirect on the endpoint that mints session codes |

The bearer token itself never appears in a URL, a redirect, or the browser at all. Codes are stored
**hashed**, so a read of `desktop_auth_grants` yields nothing redeemable.

The launcher stores its token in the **OS keychain only** — no file fallback, unlike the Local Store
Key. The LSK falls back to a file because losing it makes stored secrets permanently undecryptable,
so availability wins; a session token expires and can always be re-obtained, so writing it to disk
would trade a permanent exposure for a small convenience.

### Offline is not signed out

`auth_status` returns three states, not two: signed in, signed out, and **`offline`** — a token is
held but the API could not be reached to verify it. The launcher lets `offline` through to the
dashboard. Profiles, proxies and launches are entirely local; locking someone out of them because
their connection dropped would break the product's core function over something unrelated to it.
The gate exists to establish an account, not to police day-to-day use.

---

## 7. Running it

```bash
# Backend
cp apps/backend/.env.example apps/backend/.env    # fill in NOWPAYMENTS_* and DATABASE_URL
npx prisma migrate deploy --schema apps/backend/prisma/schema.prisma
npm run start --workspace @lobster/backend

# Website
cd apps/web && npm install && npm run build       # NOT an npm workspace: it pins TypeScript 6.0
                                                   # while the backend uses 5.6, so hoisting them
                                                   # together would break one of them.

# Launcher
npm run build --workspace @lobster/desktop
```

The web app resolves its API origin from the page origin (`api.<host>`), falling back to
`http://localhost:8080` on localhost. Override via the `API_BASE_URL` injection token in
`app.config.ts`.

### Gates

| Command | Checks |
| --- | --- |
| `npm run gate:migrations` | Applies the migration chain to real Postgres (PGlite/WASM) and asserts both the schema and the SQL-level money invariants |
| `npm test --workspace @lobster/backend` | 106 specs, including the billing and IPN suites |
| `cargo test --lib` (in `src-tauri`) | Includes the PKCE challenge against the RFC 7636 test vector |

---

## 8. Known gaps

- **`/v1/merchant/coins` is not used.** It is the per-account rail list and would be the stricter
  check than the platform-wide `/v1/currencies`; its response shape has not been observed against a
  real account, and guessing at a schema is what produced the `fixed_rate` bug.
- **Network fee figures are a point-in-time measurement** (2026-08-14) and are not refreshed
  automatically.
- **No password-reset backend.** `/auth/forgot-password` is still a UI-only shell.
- **No admin surface** for refunds or manual Credit adjustments. The `refund` and `adjustment`
  ledger kinds exist and the repository supports them, but nothing exposes them yet.
- **The IPN endpoint uses the global 50 MB body limit.** It is rate-limited and behind whatever
  proxy fronts it, but a dedicated small-body parser on that route would be better.
