# 1. Lobee is a Plus feature, and its tokens are paid for from the wallet

**Decided:** 2026-08-19 · **Status:** accepted

## Context

The Lobee agent proxy spent the operator's OpenRouter balance on every call, behind a single static
`AGENT_PROXY_TOKEN` shared by every install. There was no user identity on the request, no plan
check, and no per-tenant metering — two integers on a service instance, summed across all callers
and lost on restart. Meanwhile the storefront had been selling "Browser agent — Lobee" on Plus and
above the whole time, so the product was mis-sold in the other direction: a Light customer paid $10
and received an uncapped agent that spent someone else's money.

## Decision

**Only `plus`, `pro` and `max` may use Lobee.** `free` and `light` are refused server-side, on every
call rather than only at token mint, so a downgrade or a lapse stops spend mid-run.

`light` is a paid plan and is still refused. That is deliberate: one rule that can be stated in a
sentence — *Lobee is Plus and above* — is enforceable and explainable, and it matches what the
pricing page already promised. A small included allowance on Light would be neither.

**Token usage debits the wallet directly**, at cost × 1.5. Fresh input, cached input and output are
priced separately because they differ by an order of magnitude, and cached input is a subset of
input rather than an addition. Cost accrues in micro-USD; only whole cents move, through the same
atomic conditional debit that every other charge uses.

## Consequences

- A model with no known price is refused rather than served at a guess.
- A single sub-cent call charges nothing yet and is not lost — the carry is persisted, so a thousand
  tiny calls charge what they actually cost instead of a thousand rounded-up cents.
- Agent spend has its own ledger kind, so it is never disguised as an operator adjustment, and every
  call is a row that can explain a disputed charge.
- The desktop exchanges its session for a short-lived `aud=agent` token. Nothing long-lived and
  shared reaches an end user's machine again.
