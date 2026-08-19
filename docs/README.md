# Documentation

Start with [`STATUS.md`](STATUS.md). It records what is true today — what builds, what runs, and on
which platform — and it is the document to distrust last when the others disagree with the code.

## Orientation

| Document | What it answers |
| --- | --- |
| [`STATUS.md`](STATUS.md) | What exists, what runs where, and what is still open. Read this first on a new machine. |
| [`ENGINEERING.md`](ENGINEERING.md) | How the browser hides: the fingerprint model, the surfaces it covers, and where it is going. |
| [`OPERATIONS.md`](OPERATIONS.md) | The runbooks — build the engine, ship the product, deploy the site, run the gates. |

## Subsystems

| Document | Covers |
| --- | --- |
| [`subsystems/engine-audit.md`](subsystems/engine-audit.md) | Every anti-detect surface, audited per aspect, with the open findings named. |
| [`subsystems/engine-farbling.md`](subsystems/engine-farbling.md) | How canvas, audio and WebGL noise is applied, and what a detector can still see. |
| [`subsystems/agent.md`](subsystems/agent.md) | Lobee: the loop, perception, memory, the action space, and the safety boundary. |
| [`subsystems/profile-data.md`](subsystems/profile-data.md) | Capture, restore and sync of a profile's cookies, storage and extensions. |
| [`subsystems/billing-and-auth.md`](subsystems/billing-and-auth.md) | Credit, packages, the renewal clock, and identity across the three surfaces. |

## Decisions

Architecture decisions that outlived the discussion that produced them. One belongs here once
reversing it would cost more than writing it down.

| Decision | Subject |
| --- | --- |
| [1. Lobee is a Plus feature](decisions/0001-lobee-is-a-plus-feature.md) | Who may run the agent, and who pays for its tokens. |
| [2. The agent may not touch the identity layer](decisions/0002-the-agent-may-not-touch-the-identity-layer.md) | Why "any settings task" stops at the fingerprint. |

## Elsewhere in the repository

- [`../lobium/hooks.md`](../lobium/hooks.md) — every engine hook, its exact file and line, and why it exists.
- [`../deploy/README.md`](../deploy/README.md) — what actually serves production.
- [`../apps/web/README.md`](../apps/web/README.md) — the marketing and account site.

## Two things these documents are for

**Recording what is not finished.** The engine cannot be compiled on the Linux development host —
Chromium cannot be cross-compiled to Windows — so the shipping artifact is built elsewhere, and a
claim about anti-detect behaviour is worth exactly as much as the binary it was measured against.
Where something is unmeasured, these documents say so rather than rounding it up.

**Explaining why, not what.** The code says what it does. These say why a constraint exists, which is
the part that is expensive to rediscover and easy to undo by accident.
