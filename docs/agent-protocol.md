# Agent Protocol — how Claude & OpenAI Codex build Lobster Browser

This is the operating contract for the two builder agents. It expands
[`MASTER_PLAN.md` §7](MASTER_PLAN.md). If this doc and the master plan ever disagree, the master
plan wins — edit it first.

## 1. Roles

| Agent | Owns | Review authority |
|-------|------|------------------|
| **Claude** — Lead Architect / Integrator / Reviewer | This plan & all specs/ADRs, the Rust desktop core, fingerprint-coherence logic, security-sensitive code, engine integration, the validation harness. Writes ticket specs. | **Blocking** on P0 / security / engine / architecture PRs. |
| **OpenAI Codex** — Primary Implementer | High-throughput, well-specified modules: React/TS UI, NestJS CRUD + data models, proxy utilities, local-API handlers, SDK examples, tests, docs. | Reviews Claude's non-critical PRs. |

Both agents write tests. Every PR is cross-reviewed by the **other** agent.

## 2. Unit of work = a Ticket

- Tickets live in [`docs/tickets/`](tickets/) as `T-XXX-slug.md`.
- Claude authors tickets. Each has: **Goal · Spec · Files to touch · Acceptance criteria · Test requirements · Assigned agent · Pillar**.
- **No code without a ticket.** **No ticket spans more than one product pillar.**

## 3. Git workflow

- **Trunk-based.** Branch from `main`: `git switch -c t-XXX-slug`.
- **One PR per ticket.** Keep diffs small (< ~400 lines ideal); split large work into multiple tickets.
- **Squash merge** into `main`.
- **Conventional Commits**: `feat(fingerprint): ...`, `fix(desktop): ...`, `chore(ci): ...`, `docs: ...`, `test: ...`.
- End every commit message with the required co-author trailer.
- Never commit directly to `main`. Never force-push shared branches.

## 4. Definition of Done (ALL must hold)

1. Meets the ticket's acceptance criteria.
2. Unit + integration tests written and green.
3. `npm run typecheck`, `npm run lint`, `npm run build` green for every affected package (and `cargo build`/`clippy`/`fmt` for `apps/desktop`).
4. Anything touching a fingerprint surface or engine: **fingerprint validation gate green** (see [`ci/`](../ci/) and `MASTER_PLAN.md` §5–§6).
5. Cross-reviewed and approved by the other agent (Claude blocking on P0/security/engine).
6. No secrets committed. Production profile launch is Lobium-only (ADR-0003). If Lobium is not
   provisioned, product launch fails clearly; Patchright/Chromium may appear only in internal validation
   harnesses.

## 5. Working rules

- **Import freely.** Lobster ships open source, so fork/import/adapt any OSS that helps
  (fingerprint-suite, Chromium tooling, mitmproxy, Patchright for tests; reference from Donut/others).
  Keep attribution files.
- **Own Lobium & the UI.** The engine is our own **Lobium** build (Donut = reference only); the UI/UX is our own **design system**.
- **Production fingerprinting is native Lobium.** All profile-visible fingerprint values must flow through
  Lobium config/native patches or host calibration. CDP is allowed for automation/control and internal
  validation only; never make Patchright/JS/CDP the product stealth layer.
- Fingerprints are **per-profile stable, coherent, and derived from proxy geo**.
- **No secrets in the repo.** Use env / secret store; the CI secret-scan will fail the build otherwise.
- **Respect the contracts.** The wire formats in [`docs/contracts/`](contracts/) and the types in
  `@lobster/shared-types` are the source of truth — change the contract doc + shared-types first, in
  their own ticket, before changing an implementation to match.
- **Report faithfully.** If a test fails, say so with the output. If a surface can't be handled
  cleanly, say so and document it — do not fake it. Confidence comes from green gates.

## 6. Handoff format

When an agent finishes a ticket, post:

```
Ticket:   T-XXX
Changed:  <one-line summary>
Files:    <paths>
Verified: <tests run + gate output>
Follow-ups: <anything deferred, or "none">
```

The reviewer replies `APPROVE` or leaves specific blocking comments. Only `APPROVE` + green CI merges.

## 7. Boundaries so the two agents never collide

- Each ticket names the files/dirs it touches; two in-flight tickets must not overlap those.
- Shared files (`package.json` root, `tsconfig.base.json`, `docs/contracts/*`, `@lobster/shared-types`)
  change **only** via a dedicated ticket, never as a side-effect of feature work.
- When a package needs to join the root `workspaces` array (e.g. `apps/desktop`, `apps/backend`),
  that is its own small ticket owned by Claude.
