# Backend, billing and agent — dedicated review, 2026-08-29

Companion to [`2026-08-29-engineering-review.md`](2026-08-29-engineering-review.md), which covered the
engine, fingerprint stack, desktop shell and release path and explicitly excluded these three. This
closes that gap.

Reviewed at `cba7ab5`: `apps/backend` (161 files, 24.4k lines), `packages/agent` (47 files, 18.9k),
`packages/lobee-app` (33 files, 8.4k).

**[measured]** marks something I executed rather than read.

---

## Verdict

**This is the best-engineered part of the product**, and it is not close. The billing code in
particular is the most careful work in the repository — better than the engine, and well above what I
would expect from a team this size.

I went looking for the five failure classes that actually destroy products in this space:
double-credited payments, credit spent below zero, cross-tenant data access, an agent talked into
acting by the page it is reading, and provider keys leaking to clients. **Four are properly closed.
The fifth — prompt injection — is architecturally sound with one measurable hardening gap.**

I found no critical or high-severity defect in these three subsystems. That is a different result
from the release-engineering review, and it is worth saying plainly rather than manufacturing
symmetry.

---

## 1. Billing — the money paths

Payments run through NOWPayments (crypto), which is a harder problem than Stripe: settlement is
irreversible, amounts drift, callbacks retry, and a refund arrives as an ordinary status transition.

### 1.1 Webhook authentication — correct

`payments/nowpayments.provider.ts:292-337`:

* **Fails closed** when `NOWPAYMENTS_IPN_SECRET` is unset — logs and rejects rather than accepting.
* HMAC-SHA512 over canonically sorted JSON, which is the processor's documented scheme.
* **Constant-time comparison**, with the length check first and a comment explaining that a plain
  `===` leaks how many leading characters of a forgery were right.
* A **payload depth cap** (`PayloadTooDeepError`) before canonicalisation — a deeply nested body
  cannot exhaust the stack in `sortDeep`.
* The mismatch log names the realistic cause (JSON number re-serialisation, `5.0` → `5`) so a total
  callback outage is diagnosable instead of looking like an attack.

That last point is the difference between a security control and a security control someone can
operate.

### 1.2 Exactly-once crediting — correct, and correct for the right reason

`prisma-billing.repository.ts:249-271`. The processor retries with backoff, so duplicate delivery is
routine rather than exceptional. The guarantee is enforced by the **UPDATE predicate**, not the read:

```ts
const claimed = await tx.deposit.updateMany({
  where: { providerPaymentId, creditedAt: null },   // <- the guarantee
  data: { status: 'confirmed', creditedCents, creditedAt: new Date(), … },
});
if (claimed.count === 0) return false;              // already credited
```

The read above it is explicitly documented as advisory. That is the compare-and-swap pattern, and it
is the only version of this that survives two concurrent deliveries. The wallet then moves by
`{ increment }` — not a read-modify-write — and a `creditTransaction` row records
`balanceAfterCents`, giving a reconstructible ledger.

### 1.3 Overdraft — closed everywhere, by the same technique

`prisma-billing.repository.ts:71-89` pushes the sufficiency check into the `WHERE`:

```ts
const guard = amountCents < 0 ? { balanceCents: { gte: -amountCents } } : {};
```

so check and decrement are one atomic operation. The comment works through the interleaving that
makes a read-then-write version wrong. The same shape appears at the renewal debit (`:481-482`,
`balanceCents: { gte: dueCents }`) and the subscription claim (`:453`). **Consistency is the finding
here** — one place doing this correctly is luck; five places doing it identically is a practice.

### 1.4 Refunds and chargebacks — handled, including the unrecoverable case

`billing.service.ts:282-304`. A refund arrives as an ordinary terminal status on a payment that may
already have minted Credit. Writing only the status would leave the user holding both the returned
crypto and the balance it bought. `reverseDeposit` claws the Credit back **in the same transaction as
the status write**, and when the balance was already spent — the wallet is not allowed to go negative
— it logs at error level as a real loss requiring a human. Naming the unrecoverable case instead of
pretending it cannot happen is the right call.

### 1.5 Under/overpayment — deliberately credited, loudly

`billing.service.ts:349-371` credits what the processor says settled, because refusing a mismatch
would strand money that has already arrived on-chain, and logs when the drift exceeds both 100 cents
and 5%. The reasoning is stated: the money is already ours, so the useful thing is that a human can
see it.

### 1.6 Metered agent spend — genuinely subtle, and right

`agent-spend.service.ts:51-117`. Completions cost fractions of a cent, so per-call wallet debits
either overcharge a long conversation many times over or make model time free. Instead:

* spend accrues in **micro-USD**, and the wallet is touched only when accrual crosses a cent;
* **post-charge**, because a completion's cost is unknowable until it exists;
* plus a **reserve check** before the call, rounded **up**, so a team at zero cannot start unbounded
  work;
* on failure it prefers **under-charging over double-charging** — the micros stay accrued.

Cost controls exist upstream too: a model allowlist (`AGENT_ALLOWED_MODELS`) and a bounded output cap
(`AGENT_MAX_OUTPUT_TOKENS`, clamped 8192/32768).

---

## 2. The agent — the largest attack surface in the product

An LLM that reads arbitrary web pages and takes actions, inside a browser holding the user's real
logged-in accounts. If anything here were going to be careless, this is where it would show.

### 2.1 The architecture is right

The load-bearing decision is in `policy.ts:24-27`:

> *"This classification is kept separate from the broader risk score on purpose: the model's choice of
> action must never be able to hide a submit behind a generic `type`, `key`, `select`, or coordinate
> primitive."*

`CommitIntent` is computed from the **action shape and the observed page**, never from the model's own
assessment of what it is doing. That is the correct threat model: prompt injection can control what
the model *proposes*, but not whether the gate fires. Most agent implementations get this backwards
and ask the model to self-report risk.

Supporting layers:

* Three verdicts — `allow` / `confirm` / `deny` — with a high-risk vocabulary covering destructive and
  financial verbs, and a **narrower, stricter list for unattended runs**.
* Consequential-destination checking on the URL itself, not just the link text.
* **Keyboard keys are classified**: only pure navigation keys are ungated, because Enter, Space, Tab,
  Delete and letters can all submit a form or blur-save a field.
* Domain allowlisting (`isDomainAllowed`, with normalisation).
* Untrusted content is fenced (`BEGIN/END_UNTRUSTED_WEB_CONTENT`, `…_ACTION_RESULT`,
  `…_LOCAL_MEMORY`) and the system prompt instructs the model to treat all of it as data, never
  reveal system/task/memory content, and **report injection attempts in its final summary** — which
  turns a silent attack into a visible one.
* Credential redaction (`security.ts`, `sensitive-text.ts`) for logs, UI events, model history and
  disk, with execution using the original — so secrets are not laundered into the transcript.
* Per-profile memory is fenced and sanitized like any other untrusted input, and explicitly
  non-authoritative.

### 2.2 The one gap I found — fence escape is case-sensitive

**[measured]** `sanitizeUntrusted` (`prompt.ts:227-235`) strips the fence delimiters with a `/g`
regex and **no `/i`**, and does no Unicode normalisation:

```
STRIPPED  exact uppercase       "[delimiter removed]"
PASSES    lowercase             "end_untrusted_web_content"
PASSES    mixed case            "End_Untrusted_Web_Content"
PASSES    zero-width inserted   "END_UNTRUSTED<ZWSP>_WEB_CONTENT"
STRIPPED  chat marker           "[chat marker removed]"
```

The chat-marker strip on the very next line **is** `/gi`, which is why I read this as an oversight
rather than a decision.

**Severity: low-to-medium, and deliberately not higher.** The model sees the real fence in uppercase,
so a lowercase variant is not literally the delimiter — but models read fuzzily, and a line reading
`end_untrusted_web_content` followed by injected instructions has a real chance of being taken as a
boundary, more so on a small model. What keeps this out of the high band is §2.1: even a successful
escape only changes what the model *asks* for, and the deterministic policy gate still fires on the
action. This is defence-in-depth with one layer thinner than intended, not a bypass of the control.

Fix is one line plus a normalisation pass: add `i`, strip zero-width characters (`​-‍`,
`﻿`) before matching, and add the three variants above to `prompt`'s test file.

---

## 3. Backend — sound, with two structural hardening points

### 3.1 No IDOR — membership is verified

`teamId` is accepted from `?teamId=` across profiles, billing, api-keys and audit, which is correct
for a user who belongs to several teams — but only if membership is checked. It is
(`billing.service.ts:129-139`, `api-keys.service.ts:157-171`, and the same in audit and agent-token):

```ts
const membership = await this.teams.getMembership(teamId, userId);
if (!membership) throw new ForbiddenException('you are not a member of the requested team');
```

`api-keys` goes further and requires the **admin role** to mint or revoke, with the reasoning stated:
a key authenticates as the whole team, outlives the session that made it, and cannot be recovered
once shown — so it is the same class of act as inviting a member.

### 3.2 Authorization is opt-in, not opt-out

There is no global `APP_GUARD`. Guards are applied per controller or per route.

**[measured] Every current route is covered.** I checked all twelve controllers; the only unguarded
routes are the ones that must be — `health`, `auth`'s login/register/verify, and the payment
`webhook`, which is authenticated by HMAC instead. `admin/renewal-sweep` has its own
`AdminTokenGuard`.

The finding is the *shape*, not a present hole: with opt-in authorization, a route added without a
decorator is public, and nothing fails. A global `JwtAuthGuard` with an explicit `@Public()` opt-out
inverts the default so the mistake is a compile-time-visible annotation rather than an absence.

Worth noting my own process here: two automated scans of guard coverage produced **false positives**
(NestJS allows the guard decorator to follow the route decorator, which my heuristics mis-parsed).
Both times the code was correct and my tooling was wrong. A reviewer running a similar grep should
read the decorator blocks rather than trust the pattern.

### 3.3 `resolveTeamId` is duplicated across five services

Byte-for-byte the same security-critical function in `billing`, `api-keys`, `audit`, `agent-token`
and profiles. All five are currently correct. The risk is drift: a sixth service that forgets it, or
one copy that gains a special case, is exactly an IDOR — and there is no single place to review or
test. Extract it to a shared guard or a `TeamScope` helper.

### 3.4 Provider credentials stay server-side

`OPENROUTER_API_KEY` is read from config in `agent-llm.service.ts` and used only in outbound
`authorization: Bearer` headers (`:164, :284, :475`). Nothing returns it; no response shape carries
it. The desktop client talks to the managed proxy, never to the provider.

---

## 4. What I did not cover

Stated so the scope of "no critical findings" is honest:

* **I did not run the backend test suites.** There are e2e specs (`billing.e2e.spec.ts`,
  `auth.e2e.spec.ts`, `agent.e2e.spec.ts`) and dense unit coverage; I read them for intent, not for
  green.
* **The Prisma schema** — indexes, uniqueness constraints, cascade behaviour, migration safety. The
  `providerPaymentId` uniqueness that §1.2's guarantee rests on I inferred from `findUnique`, and did
  not verify in the schema.
* **Rate limiting and abuse controls** beyond noticing they exist (`body-limit.ts`, throttling).
* **`packages/lobee-app`** — the MV3 extension shell, 8.4k lines. Its manifest permissions and
  content-script isolation are their own review, and it runs inside the profile's own browser, so its
  blast radius is the user's live sessions.
* **The mail path, vault, and housekeeping/leases** modules.

---

## 5. Recommendations, in order

1. **Make `sanitizeUntrusted` case-insensitive and Unicode-normalising** (§2.2). One line, plus three
   test cases. It is the only measured defect in this review.
2. **Invert the authorization default** — global `JwtAuthGuard` + `@Public()` (§3.2). Nothing is
   broken today; this stops a future route from being born public.
3. **Extract `resolveTeamId`** to one shared implementation (§3.3).
4. **Verify the `providerPaymentId` unique constraint exists in the schema**, since the exactly-once
   guarantee in §1.2 depends on it and I did not confirm it.
5. Review `packages/lobee-app` separately — it is the only substantial part of the product neither
   review has touched, and it runs closest to the user's live accounts.

Nothing here changes the conclusion of the previous review: the risks that threaten this product are
still the unsigned installer, the single-origin download path, and artifact-vs-tree provenance in
release. Those remain the things to fix first. This subsystem is not what will hurt you.
