# Lobee Agent Engineering and Test Roadmap

Status date: 2026-08-10  
Scope: `packages/agent`, `packages/engine-runner/src/agent`, `packages/lobee-app`, the shared agent
contracts, managed-model boundary, local encrypted state, and agent validation harnesses.

This is an implementation plan and release contract, not a claim that every item described below is
already shipped. Status is explicit so an isolated library, a worktree change, and a production guarantee
cannot be confused with one another.

## 1. Objective

Lobee should reliably complete bounded browser tasks in a real, visible Lobium profile while preserving
the profile's anti-detect properties and keeping consequential decisions under human control. The desired
agent is:

- grounded in the current browser state rather than model recollection;
- explicit about plans, actions, observations, approvals, budgets, and terminal outcomes;
- useful without granting page content or model output authority over the host;
- recoverable after interruption without blindly replaying a possibly completed side effect;
- progressively extensible through scoped, reviewable procedures rather than executable page-authored
  code;
- evaluated with deterministic contracts and real-browser, real-model capability evidence.

"Uses the same philosophy as a reference agent" is not an acceptance criterion. Each useful idea must
become an owned component, a security invariant, and a testable release gate in this repository.

## 2. Reference posture and clean-room boundary

The architecture audit used these reference snapshots:

- **Claw Code** (`donaldmorry/claw-code`) at `289138d…`: useful concepts include an explicit tool loop,
  progressive skill disclosure, durable agent state, context hygiene, and recovery as a first-class
  state.
- `browser-use/browser-use` at `717141…`: useful concepts include text-first browser grounding, a rich
  action controller, tab/frame lifecycle handling, state-aware recovery, and real-browser evaluations.

Adoption is clean-room and conceptual:

1. Requirements are restated in Lobee terms and implemented behind Lobee-owned interfaces.
2. No reference runtime is embedded, and no reference source is copied into the agent.
3. Browser Use is MIT-licensed, but Lobee deliberately retains its project-owned `BrowserDriver` and
   first-party CDP boundary. If source is ever imported, its exact version, license, notices, and
   dependency impact require a separate review.
4. The audited Claw Code snapshot has licensing/dependency ambiguity. Treat it as design research only
   unless legal review establishes a distributable license for the exact material being considered.
5. Reference behavior never overrides Lobee's stricter approval, secret-handling, profile-isolation, or
   native-browser constraints.

## 3. Current architecture and ownership

```text
Lobee panel
  -> authenticated per-profile loopback bridge
  -> AgentManager (session, lifecycle, human input, browser attachment)
  -> @lobster/agent (perceive -> decide -> validate/policy -> approve -> execute -> observe)
  -> BrowserDriver
  -> LazyBrowserDriver + CdpBrowserDriver
  -> the user's visible Lobium profile

Managed model calls:
  AgentManager -> authenticated backend proxy -> allowlisted provider/model

Local state:
  Rust-owned secrets -> per-profile key -> encrypted memory/thread files
                                   \-> encrypted production run journals + next-run admission
```

| Boundary | Owns | Must not own or assume |
| --- | --- | --- |
| `packages/lobee-app` | Task input, settings controls, exact approval display, sensitive-input UI, transcript/history presentation | Provider secrets, memory encryption keys, policy decisions, approval inference |
| `packages/shared-types` | Versioned cross-process request/event/action vocabulary | Runtime behavior or permissive coercion |
| `packages/engine-runner/src/agent/bridge.ts` | Header-only per-profile token authentication, strict request validation, mutation request-id deduplication, safe defaults, managed-proxy configuration, encrypted thread reads | Trust in panel payloads, cross-profile access, silent fallback from malformed safety settings, or claiming in-memory deduplication survives a sidecar-process restart |
| `AgentManager` | One live run per profile enforced by process-local admission and a filesystem lease, session snapshots, cancellation, human-input timeout, lazy browser attachment, injected stores/driver/model, encrypted journal construction and unfinished-journal admission | Treating timeout/disconnect as approval, retaining raw provider credentials, replaying actions after restart, claiming a blocked ambiguity was resolved |
| `packages/agent` | Prompt trust boundary, perception, action schema, deterministic policy, approval binding, budgets, memory proposals, loop outcome | Direct CDP/network access, page-authored executable tools, model authority over policy |
| `BrowserDriver` | Small engine-independent capability contract | Provider, UI, or storage policy |
| `LazyBrowserDriver` / `CdpBrowserDriver` | First-party CDP execution, lifecycle, humanized input, final argument validation, explicit-navigation DNS preflight | Assuming a model-approved action is safe, claiming control over all browser egress |
| Memory store | Per-profile encrypted facts, learned procedures, threads, completed-run records | Cross-profile search, secrets, executable learned code |
| Run-journal store | Authenticated append-only state transitions, durability barriers, reduction, and recovery projection | Serialized action arguments, automatic write replay, or an operator resolution workflow |
| Managed backend proxy | Provider credential, authentication, model allowlist, per-request output cap, provider usage collection | Exact per-run enforcement inside a remote provider or truthful metering from a faulty provider |

## 4. Status baseline

Legend: **Integrated** means connected to the runtime and covered by its owning tests. **Hardened
worktree** means implemented and exercised by focused deterministic tests in the current pass, but still
subject to the complete merge/release gates. **Planned** means no shipping guarantee exists.

| Capability | Status | Evidence and remaining boundary |
| --- | --- | --- |
| Provider-agnostic, one-action-per-step loop | Integrated | Forced/advisory structured tool handling, retries, cancellation, step bounds, context-overflow recovery, repeated-action containment |
| Text-first perception | Hardened worktree | Bounded controls/text, open shadow roots, same-origin frames, optional vision fallback, credential-aware event redaction, opaque full-URL identity, and isolated `about:blank` handling; perception still executes through page main-world DOM APIs |
| Action and browser coverage | Integrated | Semantic input, clicks, keys, select, scroll, drag, restricted upload, navigation/back, tabs, extraction/collection, vetted browser settings |
| Commit/consequential policy | Hardened worktree | Activation keys, clicks, selection, drag/drop, submits, coordinate actions, uploads, browser changes, and durable memory proposals are gated |
| Approval time-of-check/time-of-use binding | Hardened worktree | Re-perception, opaque full-URL identity, and action/target/screenshot fingerprints reject stale approval; start-URL source drift is rechecked |
| Durable effect boundary | Hardened worktree | Every mutating executor path calls a journal-supplied `beforeEffect` only after deterministic preflight and immediately before its first browser effect; pre-effect rejection is cancelled rather than left as ambiguous dispatch |
| Post-effect observation | Hardened worktree | Mutating browser actions require a fresh readable perception and matching current full-URL identity before success is journaled. This proves fresh browser state was observed, not that a business transaction semantically succeeded |
| URL/domain/private-network policy | Hardened worktree | HTTP(S)-only web navigation, browser-owned settings allowlist, Public Suffix List validation, literal/private IP handling, direct-route DNS preflight, and journaled rollback of denied or rejected navigation drift exist; redirect/subresource/proxy enforcement remains future work |
| Token budget | Hardened worktree | Current request input is conservatively reserved, output is capped by remaining allowance, cached Anthropic input is counted, and over-budget model output is quarantined before action dispatch; provider metering remains authoritative and imperfect |
| Secrets/uploads | Hardened worktree | Sensitive fields use direct human handoff; ordinary model-authored credential typing is rejected; upload roots reject broad home/filesystem aliases after realpath, files are streamed through a full-content secret scan, and paths are redacted from events/memory |
| Per-profile encrypted memory and threads | Hardened worktree | AES-GCM files, atomic replacement, strict wrong-key/corruption reads, fail-closed append, exact thread identity, credential scrubbing during legacy migration, and compaction retained as visible history |
| Scoped learned skills | Hardened worktree | Host scope is harness-owned and reduced to a tenant boundary, IP scopes remain exact, unknown/malformed/public-suffix scope fails closed, and learned procedures cannot shadow built-ins or execute code; persistence requires approval |
| Panel/bridge history and session fidelity | Hardened worktree | Thread-scoped snapshots, stable turn identity, encrypted content as source of truth, a bounded heuristically redacted local availability/migration fallback, header-only event authentication, last-known bridge identity across transient registry gaps, and request-id reconciliation for lost `/run` and `/input` responses. The fallback is not an encryption or arbitrary-PII boundary; see section 10 |
| Encrypted durable run journal | Hardened worktree | The production manager constructs the per-profile encrypted store; the loop creates a journal before work and syncs non-executable proposal/approval/dispatch/outcome/terminal transitions. Parent-directory durability, safe permissions, timestamp handling, navigation reconciliation, and a cross-process per-profile lease are enforced. Next-run admission closes safe non-sensitive interruptions without replay and blocks unfinished sensitive or ambiguous write/consequential states. There is no supported resolution UI/API yet |
| Real-browser fixtures | Integrated | `ci/validation/e2e/agent-browser-e2e.mjs`: 20 scenarios (late content, infinite scroll, shadow DOM, same-origin frames, consent overlay, popup adoption, native select, custom combobox, gated control, multi-field POST receipt, rejected commit, private-network denial, perception truncation, TOCTOU target drift, blocking native dialog, memory recall, back/forward, tab lifecycle, runtime automation-tell diff) on a real browser with a deterministic pilot. Green on the shipping Lobium 152 build and on an interim Chromium |
| Capability battery | Hardened worktree | Adversarial grader tests, stronger grid/pagination/infinite-scroll/multi-tab/article/consent evidence, exact loopback fencing, public-task private-network denial, validated per-attempt token budgets, JSON reports, fresh attempt isolation, and a protected workflow that fails rather than skips green exist. No paid full live pass was run in this hardening pass |

Evidence for **Hardened worktree** is the focused deterministic test coverage at the owning locations in
section 7.1. Final test counts belong in the merge/release report after the complete command set runs; a
focused pass, unit suite, or grader suite is not promoted here into shipping-browser or paid-model proof.

## 5. Non-negotiable security and correctness invariants

Each invariant needs at least one negative test. A feature is incomplete when only its success path is
tested.

### S1 — Untrusted inputs stay data

- Page text, accessibility names, URLs, model text, learned procedures, and stored site facts are
  untrusted.
- Page-derived labels, URLs, block reasons, and prior action-result text stay inside explicit untrusted
  prompt blocks; they are evidence for replanning, never harness instructions.
- Only the harness defines tool schemas and executes actions. Skills are bounded prose, never scripts,
  selectors to execute blindly, shell commands, or provider instructions.
- Provider output is parsed with exact schemas and bounded fields. Unknown actions or extra authority do
  not degrade into a similar action.

### S2 — Commitment requires current, human-visible authority

- Consequential or externally visible actions require fresh action-bound approval in every autonomy
  mode.
- Because page handlers are opaque, generic clicks, activation keys, selects, drag/drop, coordinate
  gestures, explicit submit, uploads, browser-permission/data changes, and durable memory writes remain
  commit-capable.
- A rejected, timed-out, disconnected, malformed, or stale approval authorizes nothing.
- Approval is bound to the action and relevant page/target/screenshot state. Drift requires a new prompt.
- Semantic typing into a browser-verified text-entry control without submit is composition, but secrets
  still use the direct sensitive handoff.

### S3 — Navigation fails closed at every owned seam

- Web navigation accepts only canonical HTTP(S) destinations. `file:`, `data:`, `blob:`, `filesystem:`,
  extension, developer, and unknown schemes are denied unless a separately vetted browser-owned command
  owns the operation.
- Domain fences use maintained public/private suffix data and normalized hostnames. A public suffix is
  never accepted as the user's tenant boundary.
- Literal IPv4/IPv6, IPv4-mapped IPv6, NAT64, 6to4, loopback, link-local, private, multicast,
  documentation, and local-name destinations fail closed unless private access was explicitly enabled.
- A direct route resolves all current A/AAAA answers immediately before explicit navigation and denies
  the whole destination if any answer is non-public or malformed. Unknown route and resolver timeout fail
  closed.
- This does **not** yet cover Chromium/Node resolver differences, redirects, subresources, service
  workers, page-initiated requests, DNS rebinding after preflight, or proxy-exit resolution. A hard egress
  guarantee requires Milestone 2B.

### S4 — Secrets and visual payloads have narrow channels

- Passwords, OTPs, payment values, access tokens, and provider keys do not enter ordinary model requests,
  action events, run summaries, journals, logs, panel local storage, or learned skills.
- Credential-shaped task text is rejected before model or durable-store access. Model-authored ordinary
  typing cannot carry credential-shaped values; the direct sensitive-input channel owns that handoff.
- Explicitly configured upload roots and model-proposed upload paths can appear in the transient selected-
  model exchange because the model must name the file it proposes to upload. They are redacted from
  ordinary action events and durable stores, the journal is marked sensitive before approval/execution,
  and the human approval shows only file basenames and the destination host.
- When `visionFallback` is explicitly enabled, a current screenshot may be attached to the transient
  request sent to the selected model. The loop marks the run sensitive before capture. Screenshot bytes
  must not enter durable memory/threads, action events, run summaries, journals, logs, panel local
  storage, learned skills, telemetry, or test reports.
- Sensitive field values are delivered from the human-input channel directly to the verified current
  field.
- Upload roots cannot be the filesystem root or a user's home directory, including realpath-equivalent
  dot/symlink aliases. Approved files are size-limited and scanned as a stream through their complete
  contents for credential/private-key material before any browser upload effect begins.
- Redaction is defense in depth, not the primary secret boundary; secret-bearing data should not be
  accepted by ordinary channels in the first place.

### S5 — Identity and isolation are exact

- One profile owns one active agent session and one independent memory namespace.
- Admission is serialized across manager instances and sidecar processes by an exclusive per-profile
  filesystem lease. A provably dead owner may be recovered; a live, corrupt, or unverifiable owner fails
  closed. The authenticated journal, not the lease, decides whether an interrupted effect is safe.
- Bridge authentication resolves to exactly one profile; profile/thread/run identifiers are bounded
  opaque values and cannot become paths. The bridge token is carried in a request header, not an event-
  stream URL. `/run` and `/input` use body-bound request ids so a lost response can be retried without
  duplicating a live run or delivering human input twice.
- History reconciliation uses stable identities, never array position or count.
- Wrong-key, corrupt, missing, and transient storage failures are distinct. An error must not erase the
  last known-good encrypted record. The panel's bounded local availability/migration fallback is explicitly
  secondary, heuristically redacted, and retired only after exact encrypted-thread verification; it must
  never be treated as equivalent to encrypted history.

### S6 — Budgets stop authority, not just accounting

- The loop checks remaining steps and estimated current-request input before calling a provider.
- The request's output cap cannot exceed the remaining allowance.
- Returned provider usage is accumulated before parsing or executing the action. If it crosses the
  configured ceiling, the output is quarantined and the run stops without dispatch.
- This is a conservative client guardrail, **not exact billing enforcement**. Tokenizers, image billing,
  provider-side reasoning, retries, and inaccurate usage reports can differ. Exact enforcement would need
  a trusted proxy that meters every attempt and rejects before the configured account/run allowance.

### S7 — Recovery never guesses whether a side effect happened

- The production loop creates an authenticated journal before lifecycle events, model access, browser
  navigation, or durable memory work. A mutating executor completes deterministic policy, target,
  capability, and path preflight before invoking its journal-supplied `beforeEffect`; that callback
  persists and syncs `action.dispatching` immediately before the first driver/memory effect.
- A mutating browser action is recorded successful only after the driver returns and a fresh readable
  browser observation matches the live full-URL identity. Failure to re-observe remains ambiguous. This
  is a delivery/current-state check, not action-specific proof that an external business effect applied.
- Unexpected navigation that is denied or rejected becomes its own journaled reconciliation action. The
  prior URL/tab must be restored and verified; an interrupted or failed rollback blocks the next run.
- Restart never reconstructs or replays an action from persisted arguments; arguments are not persisted.
- At the next run attempt, a non-sensitive clean/pre-dispatch interruption is closed as stopped, and an
  interrupted read dispatch is explicitly marked unknown then abandoned and closed. Neither is resumed;
  the new run replans from its own state.
- An unfinished sensitive journal or ambiguous write/consequential dispatch blocks admission. Lobee does
  not hide it behind a terminal marker or guess whether it happened.
- No supported bridge/UI/API resolution path exists yet. Blocked records therefore require a future
  operator-resolution workflow; the current behavior provides safe failure, not complete recovery UX.

## 6. Milestone plan

### M0 — Close the deterministic safety baseline

Status: **Core implementation present in the hardened worktree; release eligibility remains governed by
the exit gate below**  
Priority: release blocker

Implemented in this pass:

1. Expanded and regression-tested the commit classifier for click/key/select/drag/coordinate/form,
   browser configuration, upload, `remember`, and `learn` paths.
2. Bound every approval to a redacted exact action plus fresh target/page/screenshot fingerprint; verified
   start navigation against the unchanged source and an immutable absolute destination.
3. Made perception failure output bounded and redacted, and ensured `about:blank` cannot inherit an
   inaccessible prior document's extracted content.
4. Applied maintained Public Suffix List data to domain fences and learned-memory scope, including private
   multi-tenant suffixes; broad/malformed legacy records are dropped during encrypted migration.
5. Kept URL policy at the pure agent seam and direct-route DNS preflight at the driver seam. The live
   profile's direct/remote-proxy route is recorded only after successful launch; unknown route fails
   closed.
6. Reserved the complete current request against the token allowance, dynamically bounded `maxTokens`,
   counted provider cache-read usage, and quarantined responses that cross the ceiling before parsing or
   dispatch.
7. Added an executor-owned `beforeEffect` boundary after deterministic preflight, fresh post-effect
   observation, journaled navigation reconciliation, and a cross-process per-profile run lease.
8. Hardened sensitive input, complete-file upload scanning, legacy memory migration, panel fallback,
   bridge authentication/idempotency, and explicit successful-stop token revocation at their owning
   boundaries.
9. Made battery configuration explicit and validated, isolated attempts, strengthened task-local graders,
   and kept provider-secret testing on a protected self-hosted workflow where `BLOCKED` is non-green.

Intentional compatibility retained:

- literal IP and explicitly supported single-label development hosts remain available only where the run
  policy deliberately permits them;
- an empty domain fence remains an explicit unrestricted-domain choice, not a silently malformed fence;
- the live paid battery remains a separate release gate and was not executed as part of this hardening
  pass.

Exit gate:

- all deterministic agent, engine-runner, bridge/manager, panel, and battery-grader suites pass;
- typecheck, panel production build, and formatting pass;
- every new safety rule has allow, deny, malformed, timeout, and stale-state cases where applicable;
- a final diff review finds no policy duplicated in the model prompt without deterministic enforcement;
- the live battery may be **BLOCKED** by missing infrastructure, but the product cannot be called
  capability-verified until its separate release gate passes.

### M1 — Complete recovery operations for integrated durable journaling

Status: **Production loop and next-run admission integrated; operator resolution and crash-boundary
coverage planned**  
Priority: next after M0

Current implementation:

- strict versioned event schema and reducer;
- AES-GCM with path-bound authenticated data, bounded records, safe permissions, atomic temp-write,
  file and parent-directory sync, and rename;
- process-wide per-run serialization plus optimistic revisions, with an exclusive per-profile filesystem
  lease preventing concurrent manager admission across processes;
- text scrubbing and non-executable action digests;
- fail-closed enumeration, corruption handling, and terminal-only pruning;
- recovery projection that distinguishes terminal, safely closable, non-resumable, and
  possibly-dispatched states;
- `AgentManager` constructs the journal under the profile memory directory with the native-provisioned
  per-profile key and admits authenticated unfinished journals before accepting a new run;
- the loop creates `run.started` before any work, syncs non-executable action/approval/dispatch/outcome
  transitions, marks credential/upload/image runs sensitive before the relevant handoff, and persists
  terminal lifecycle markers without duplicating result content;
- deterministic preflight precedes the durable dispatch transition; fresh browser state is required after
  a mutating driver return, and an unverifiable post-state remains recovery-required;
- unexpected denied/rejected navigation is reconciled through a separate journaled rollback whose restored
  URL/tab must be observed before the run can close;
- admission automatically closes non-sensitive clean/pre-dispatch records, and explicitly abandons then
  closes interrupted reads, without reconstructing or replaying an action;
- admission rejects unfinished sensitive records and ambiguous write/consequential effects. It exposes
  an error to the caller, but there is currently no supported operator resolution UI/API.

Remaining sequence:

1. Extend the existing loop/manager ordering and admission tests into process-termination injection before
   and after every create, approval, dispatch, driver return, observation,
   and terminal append boundary using a real manager plus deterministic browser fixture.
2. Add versioned bridge/shared/UI contracts for blocked records. Show only the content-free task label,
   safe action kind/effect/host, and interruption state; never reconstruct arguments or reveal a sensitive
   payload.
3. Add a supported, authenticated operator decision path for `verified applied`, `verified not applied`,
   or `abandon`. Require explicit live-state verification and append a durable resolution before allowing
   another run. A resolution always leads to a new plan; it never replays the old action.
4. Surface unresolved records proactively in the profile/agent status rather than only when a new run is
   attempted. Until the UI exists, keep admission blocked and document the availability limitation.
5. Make terminal finalization idempotent across manager catch/abort races. Retain the current profile lease
   tests and decide whether any future standalone journal writer needs a separate cross-process lock.
6. Exercise retention only after an authenticated terminal read and retain corrupt/unreadable/unfinished
   records for explicit review.

Exit gate:

- kill-at-every-boundary tests prove zero automatic duplicate side effects;
- wrong key, corruption, disk full, symlink, concurrent append, stale revision, and interrupted rename
  fail closed without losing a previously synced journal;
- every running session reaches exactly one durable terminal state or an explicit admission-blocking
  recovery state;
- journal data passes a secret/path/query/screenshot leak corpus;
- restart recovery passes with the real manager and a real local browser fixture, not only the reducer.

Current journaling is real runtime protection, but it is not general run resume or complete crash recovery.
Only states with no unresolved external effect close automatically. An ambiguous write/consequential or
sensitive unfinished record deliberately blocks, and no supported operator resolution UI/API exists until
this milestone exits.

### M2A — Strengthen browser grounding and action-specific verification

Status: **Fresh URL-bound post-effect observation integrated; deeper document identity and semantic
receipts planned**

Current baseline: mutating browser actions are followed by a fresh perception and an exact opaque full-URL
identity comparison. This prevents a completed driver call from becoming journaled success when the page
is unreadable, detached, or changes during verification. It does not prove that the requested business
operation happened, identify a same-URL document replacement, or provide an action-specific receipt.

Deliverables:

1. Introduce an observation generation containing tab id, frame identity, document/navigation id, URL,
   viewport, and a bounded element signature. Require actions to cite the generation they observed.
2. Reject an action if its tab/document/frame generation changed; re-perceive and ask the model to
   replan. Keep human approval as a second, stronger freshness check for commit actions.
3. Preserve stable identities through popup adoption, tab reorder, frame reload, same-document
   navigation, and back/forward cache restoration. Avoid positional tab identity after any tab mutation.
4. Add structured task evidence separate from assistant prose: extracted rows, submitted receipt,
   authenticated-state marker, download metadata, or current page assertion. Graders should consume
   harness evidence where possible.
5. Implement download lifecycle and bounded artifact metadata without exposing local paths to the model.
6. Expand perception for nested open shadow roots, same-origin frame churn, ARIA-owned controls, virtual
   lists, sticky overlays, and dynamic disabled/enabled state. Cross-origin frames remain explicit
   vision/human territory unless a safe browser-owned accessibility surface is added.
7. Add recovery strategies for detached nodes, target destruction, native dialogs, interrupted page
   loads, popup races, and transient empty DOM. Recovery always begins with fresh state.

Exit gate:

- deterministic fixtures cover each lifecycle transition and prove stale element/tab generations cannot
  dispatch;
- task completion is supported by task-local browser evidence, not only final model prose;
- multi-tab, popup, frame-reload, and dynamic-control fixtures pass three consecutive runs with the
  supported browser build;
- no new CDP behavior weakens the documented first-party/anti-detect invariant.

### M2B — Enforce browser-wide private-network egress

Status: **Planned; current preflight is defense in depth only**

Required design:

1. For direct profiles, enforce destination IP policy at a browser/process network boundary that sees
   every connection, including redirects, subresources, workers, WebSockets, and page-initiated fetches.
2. For remote-proxy profiles, require an upstream proxy capability that resolves at the exit and rejects
   non-public answers. Local DNS must not pretend to validate remote resolution.
3. Define DNS rebinding behavior, resolution TTL, mixed public/private answer handling, CNAME chains,
   IPv6 transition mechanisms, and failover. Any non-public candidate fails the connection.
4. Surface a distinct, redacted policy error to the run and record only hostname/category evidence.
5. Treat `allowPrivateNetwork` as an explicit, visible per-run capability; it must not silently persist as
   a global default.

Exit gate:

- owned network-lab tests block direct and redirected requests to loopback/private/link-local targets,
  malicious multi-answer DNS, rebinding, WebSocket, worker, iframe, image, and service-worker paths;
- the same suite runs for direct and supported proxy routes at IPv4 and IPv6;
- an unknown/non-enforcing proxy route fails closed when private-network isolation is required;
- operations documentation identifies the actual enforcing component and its observable limitations.

### M3 — Engineer the skill and memory lifecycle

Status: **Scoped learned procedures integrated; lifecycle planned**

Deliverables:

1. Version a declarative skill manifest: stable id, name, trigger, bounded procedure, origin, host scope,
   created/last-success timestamps, source run, schema version, and enabled state.
2. Maintain trust tiers: shipped built-ins, user-authored procedures, and agent-learned procedures are
   visibly distinct. Learned content never shadows a built-in or policy.
3. Preserve progressive disclosure: select a small relevant set from metadata, then reveal bounded detail.
   Unknown current host reveals no learned site procedure.
4. Require an approved memory proposal, current host scope, and a completed task with evidence before a
   learned procedure becomes eligible. Page instructions are not sufficient evidence.
5. Add user list/view/disable/delete/export controls and deterministic invalidation for repeated failure,
   stale site behavior, schema migration, and domain ownership changes.
6. Measure benefit against a no-skill control using fixed model/task/config: success rate first, then
   steps/tokens. A skill that reduces tokens but increases unsafe attempts or failures is rejected.
7. Keep procedures as guidance. Do not introduce arbitrary skill code, shell access, package installation,
   or hidden network tools into the browser agent.

Exit gate:

- malformed, cross-domain, public-suffix, Unicode/punycode, built-in collision, secret-bearing, and
  page-injected skills are rejected;
- users can inspect and revoke every non-built-in procedure;
- a benchmark cohort shows no success/safety regression and a reproducible efficiency improvement;
- memory corruption or wrong-key failure never causes global/unscoped skill disclosure.

### M4 — Planning, context, and provider resilience

Status: **Partially present; expansion planned**

Deliverables:

1. Represent task progress as explicit, bounded state: objective, current subgoal, evidence, unresolved
   questions, failed approaches, and completion condition. The model may propose updates; the harness
   owns bounds and history.
2. Make compaction invariant-preserving: retain approvals/rejections, consequential outcomes, user
   constraints, collected data schema, open recovery item, and facts needed to judge completion.
3. Add provider-adapter conformance fixtures for tool choice, tool-call ids, image input, streaming,
   reasoning effort, refusal, truncation, usage, retry headers, abort, and context overflow.
4. Separate planner and step model only when a controlled benchmark proves the pairing. A cheaper model
   must not receive authority beyond the same action/policy boundary.
5. Add loop-detection signals for state oscillation, repeated recovery, no-progress scrolling, and
   identical action/outcome pairs. Escalate or stop honestly rather than spending the remaining budget.
6. Keep task completion explicit: `finish` must state outcome and evidence; reaching `maxSteps`, budget,
   provider refusal, or unavailable capability is not success.

Exit gate:

- context compaction tests preserve every safety/completion invariant across long synthetic histories;
- every supported provider passes the same adapter contract suite;
- model-pair changes pass the full battery at the same or better safety/success threshold before rollout;
- repeated no-progress scenarios stop within a fixed bound and report the real blocking condition.

### M5 — Release operations, observability, and continuous evaluation

Status: **Battery/workflow foundation in progress**

Deliverables:

1. Store machine-readable test reports with commit, engine build, model id, provider route, task version,
   attempt seed, steps, token usage, duration, and verdict. Never store page secrets or raw sensitive
   prompts.
2. Version task fixtures and graders. Run blind-model/adversarial-grader tests on every pull request.
3. Run the paid live battery only from protected main/manual workflows with short-lived credentials,
   clean profiles, explicit terms/rate-limit review, and report retention.
4. Establish committed performance/cost baselines after the functional gate is stable. Alert on median and
   tail regressions; do not trade safety or success for latency.
5. Canary changes by model/engine/policy version with a kill switch that disables new agent runs without
   corrupting local history or active recovery records.
6. Maintain a failure taxonomy: product failure, grader failure, provider/infrastructure blocked, site
   drift, expected human rejection, and unsupported capability. Only product failure affects capability
   score; blocked/incomplete never becomes pass.

Exit gate:

- the release report is complete and reproducible from its recorded versions;
- a failed or incomplete protected battery blocks promotion;
- telemetry review confirms no secret, full URL query, upload path, screenshot payload, or cross-profile
  content is collected;
- rollback and active-run stop behavior have been exercised in staging.

## 7. Test strategy

### 7.1 Deterministic matrix

| Layer | Required coverage | Primary location | Pull-request gate |
| --- | --- | --- | --- |
| Action schema/capabilities | Exact parsing, field/type/size bounds, unknown keys, mutation metadata, redaction, pre-effect ordering, post-effect observation | `packages/agent/src/actions.test.ts`, `executor.test.ts`, upload and loop tests | Yes |
| Policy | Commit/consequential classification, schemes, PSL/domain fence, cross-domain behavior, IP families, settings intent | `packages/agent/src/policy.test.ts`, browser-config tests | Yes |
| Perception | Bounded extraction, sensitive values, fallback errors, shadow/frame context, `about:blank`, diff coherence | perception tests and deterministic DOM fixtures | Yes |
| Loop | Tool history, approval/rejection/timeout, TOCTOU drift, budget quarantine, invalid action recovery, no-progress stop, secret handoff | `packages/agent/src/loop.test.ts` with fake LLM/driver | Yes |
| Memory/skills | Encryption, credential-aware legacy migration, exact thread identity, compaction, tenant scope, collision, corruption/wrong key, fail-closed append, approved persistence | memory and skill tests | Yes |
| Journal | State-machine transitions, revisions, atomic encrypted files, parent sync, caps, scrubbing, recovery projection, retention, loop effect ordering, navigation reconciliation, and manager admission | journal unit tests plus loop/manager integration tests | Yes; process-kill boundary matrix remains an M1 release gate |
| Provider adapters | Request shape, tool calls, retries, abort, usage, refusal, truncation, error redaction | `packages/agent/src/llm/providers.test.ts` plus conformance fixtures | Yes |
| Manager/bridge | Header-only auth, validation/defaults, cross-manager/process profile lease, request-id deduplication, lost-response reconciliation, presence/timeout, SSE replay, status, thread isolation, lazy attach, terminal errors | engine-runner and panel bridge tests | Yes |
| Navigation egress | Direct/proxy/unknown route, all DNS answers, timeout, mixed/private/special IPv4/IPv6, no caching | navigation-egress tests | Yes |
| CDP driver | Real command semantics, tabs, files, config, detach/dialog errors, stealth invariant | CDP and engine integration tests | Yes where browser is installed |
| Panel | Stable transcript identity, history/new-chat isolation, settings round-trip, transient failure preservation, sensitive prompt rendering | `packages/lobee-app/src/*.test.mjs` | Yes |
| Battery grader | Blind answer rejection, missing oracle, task-local evidence, grid/page/tab/article completeness, consent sequencing, exact fixture fencing, budget propagation, incomplete/blocked semantics, workflow isolation | `ci/validation/agent-battery.test.mjs` | Yes |

Minimum local/CI command set:

```bash
npm test --workspace @lobster/agent
npm test --workspace @lobster/engine-runner
npm test --workspace @lobster/lobee-app
npm run typecheck --workspaces --if-present
npm run build --workspace @lobster/lobee-app
node --test ci/validation/agent-battery.test.mjs
npx prettier --check "packages/**/*.{ts,tsx,js,json}" "ci/**/*.{mjs,json}" ".github/**/*.yml"
```

### 7.2 Real-browser deterministic fixtures

Status: **Implemented** — `ci/validation/e2e/agent-browser-e2e.mjs`, run on every pull request against an
interim Chromium and, where a Lobium binary is provisioned, against the shipping engine.

The harness drives the production `runAgent` loop through the production `CdpBrowserDriver` against a
real browser and a real HTTP origin (`fixture-site.mjs`). Only the model is substituted, by a pilot that
reads the same rendered observation a model reads and selects its target BY ROLE AND NAME — so a
perception regression that renumbers or mislabels a control fails the scenario instead of being papered
over by a hard-coded index. Each fixture server mints its answers from a per-boot nonce, so no scenario
can be satisfied from prompt text or public knowledge.

It reports which engine it ran on and never converts absence into success: an interim Chromium pass is
browser-integration evidence, a shipping-engine pass is Gate B evidence, and no engine at all exits 2 as
BLOCKED. The first run against the real browser found that the agent could not tick a consent checkbox,
could not choose from a labelled `<select>`, and could not re-type into a field it had already filled —
none of which any unit test could see, because the pre-dispatch target check had only ever been exercised
against a fake driver returning canned answers.

Required scenarios:

- JavaScript-delayed and repeatedly changing content;
- infinite/virtual scrolling and element-list truncation;
- open shadow DOM and same-origin iframe navigation/reload;
- native select, custom combobox, disabled-to-enabled control, radio/checkbox, and POST receipt;
- consent overlay, native dialog, popup, stable tab switch/close, and back/forward;
- stale element after re-render and target change during approval;
- upload root/symlink boundary and download lifecycle;
- local/private destination rejection and explicit test-only opt-in;
- memory write followed by recall in a different page on the same host;
- sidecar/browser termination at every integrated journal transition boundary; supported resolution
  handling is added with M1.

The fixture server mints per-run facts or receipts that are absent from prompts. A model cannot pass by
restating the task or relying on common benchmark knowledge.

### 7.3 Live model capability battery

The current battery covers browser-free answer, grids, pagination, rendered/delayed content, infinite
scroll, login, select/submit, tables, multi-field POST, tabs, consequential rejection, honest blocking,
shadow DOM, custom controls, overlays, dense pages, iframes, late content, gated controls, memory
write/recall, a live dense list, and a long article.

The deterministic battery/grader tests were expanded in this hardening pass. The paid live invocation
below was **not** run here, so these changes are not evidence of a live model/browser capability pass.

Release invocation:

```bash
AGENT_BATTERY_REPEAT=3 \
LOBSTER_LOBIUM_BIN=/absolute/path/to/lobium \
LOBSTER_AGENT_PROXY_URL=https://approved-proxy.example/agent/llm \
LOBSTER_AGENT_PROXY_TOKEN=... \
node ci/validation/agent-battery.mjs --repeat=3
```

Rules:

- every selected task must complete every repetition; one lucky pass is insufficient;
- a browser task needs task-local action and observation evidence, not only matching final prose;
- consequential tests verify the exact action presented and that rejection prevents the side effect;
- live facts use time-bounded, status/content-validated oracles sampled around the run;
- `FAIL` exits 1; unavailable engine/provider/oracle or incomplete execution is `BLOCKED` and exits 2;
- reports include all attempts, including failures and blocks. A later pass does not erase earlier evidence.

### 7.4 Failure-injection matrix

| Fault | Injection point | Required assertion |
| --- | --- | --- |
| Provider timeout / 429 / 5xx / broken stream | Before headers, mid-stream, after partial tool call | Bounded retry, visible status, abort works, no duplicate dispatch |
| Refusal / prose-only / malformed or oversized tool call | Decision result | No execution; bounded correction or honest terminal state |
| Context overflow / inaccurate usage / response over budget | Initial and retry calls | Bounded retry; over-budget output quarantined before approval/action |
| CDP disconnect / target destroyed / browser closes | Before perceive, before dispatch, during settle, after dispatch | Clean terminal state or recovery-required; never report unobserved success |
| Page/tab/frame/screenshot drift | While human prompt is open | Approval expires; fresh perception and new approval required |
| Human rejection / timeout / panel disconnect | Every approval and sensitive handoff | No action, no memory write, no invented answer; session unwinds |
| DNS NXDOMAIN / timeout / mixed answers / private IPv6 transition address | Explicit navigation and new tab | Fail closed with bounded redacted error; no destination request dispatched |
| Redirect/subresource/rebinding to private IP | Browser-wide network lab after M2B | Connection blocked at enforcing layer, not merely detected afterward |
| Wrong key / corrupt/truncated ciphertext / symlink / permissions | Memory and journal open/write/list | No plaintext fallback, traversal, deletion, or false "not found" |
| Disk full / kill before and after sync/rename | Every journal persistence boundary | Last synced revision remains valid; possible dispatch becomes visible recovery |
| Concurrent/stale journal append | Same run, multiple facades/processes | Conflict or serialization; never silent last-write-wins |
| SSE disconnect/replay/duplicate | Before prompt, during run, after terminal event | Stable identity, idempotent rendering, no duplicate human delivery |
| Compaction at each message boundary | Long task/history | User constraints, approvals, evidence, and recovery state remain represented |

## 8. Benchmark gates

### Gate A — Deterministic correctness (every pull request)

- zero failing unit/contract tests, type errors, build errors, or formatter errors;
- zero skipped safety tests; environment-dependent browser tests must report why they skipped;
- action/policy/shared-wire changes require matching negative tests;
- battery graders must reject blind, prompt-only, missing-oracle, and non-browser-evidence answers.

### Gate B — Browser integration (main and release candidate)

- all deterministic local fixtures pass on the shipping Lobium build three consecutive times;
- zero stale-generation action dispatches and zero cross-profile/thread observations;
- every expected side effect has an independent fixture receipt or post-action browser assertion;
- crash-boundary tests are mandatory for release; the supported operator-resolution path is additionally
  mandatory before recovery/resume is marketed.

### Gate C — Live capability (protected environment)

- the complete versioned battery passes 3/3 runs per task with one pinned supported model/config;
- no `BLOCKED`, timeout, missing task, skipped task, grader exception, or incomplete report;
- a second supported provider/model pair runs at least the critical safety/grounding subset before it is
  offered as agent-capable;
- report artifacts are retained with commit, browser, task, model, and proxy versions.

### Gate D — Security adversarial

- zero unauthorized consequential/commit actions across rejection, timeout, drift, and malformed-input
  cases;
- zero credential/query leaks beyond their explicitly authorized recipient, zero upload-path disclosure
  outside the configured transient model exchange and basename-only human approval, and zero screenshot
  disclosure outside an explicitly enabled transient request to the selected model; durable stores,
  events, logs, telemetry, and reports pass a seeded leak corpus;
- zero accepted private/special destinations in the routes the product claims to enforce;
- zero learned-skill disclosure outside its canonical host scope.

### Gate E — Reliability and recovery

- 100% of injected interruption points reduce to a durable terminal state, an automatically closed safe
  interruption, or an explicit admission-blocking sensitive/ambiguous state; M1 additionally requires a
  supported operator resolution path for the blocked states;
- zero automatic replays of interrupted write/consequential actions;
- repeated/no-progress loops stop within configured step/token bounds;
- cancellation and human-input timeout leave no running-session wedge.

### Gate F — Cost and latency

Functional/safety gates take precedence. Before the first release candidate, record a baseline over the
versioned battery for steps, provider input/output tokens, time to first visible event, total duration, and
retry rate. Thereafter:

- reject an unexplained greater than 10% median step or token regression on unchanged deterministic task,
  model, prompt, and browser cohorts;
- investigate greater than 20% p95 duration regression before release;
- enforce schema/observation/journal hard caps regardless of benchmark variance;
- report provider/site variance rather than weakening graders to preserve a score.

These relative thresholds become blocking only after the baseline and sampling method are committed.

## 9. Release criteria

An agent release is eligible only when:

1. M0 and Gates A-D are green; Gate B uses the exact shipping Lobium build.
2. The protected live battery is complete and green. Missing credits, model capacity, engine, proxy, or
   oracle produces a blocked release, not a pass.
3. Every selectable `agentCapable` model has passed the adapter contract and the required live subset.
4. Security review traces each invariant in section 5 to deterministic tests and its enforcing owner.
5. Data review confirms encrypted per-profile storage, inventories every secondary store, and either
   removes it or explicitly accepts its content, redaction limits, retention, and recovery behavior.
6. Operational documentation states which network paths are actually enforced and does not call a
   navigation preflight a browser-wide egress sandbox.
7. The current automatic safe-closure/admission-blocking behavior passes Gate E. If end-user recovery or
   resume is marketed, M1's operator-resolution work is also green; otherwise the UI makes no
   resume/recovery promise.
8. A rollback/kill-switch exercise proves new runs can be disabled and active runs stopped without
   deleting history or converting uncertainty into success.
9. Known limitations are visible in release notes and accepted by the responsible owner.

## 10. Explicit limitations and non-goals

- **No hard browser-wide private-network guarantee yet.** Current URL policy and explicit-navigation DNS
  preflight do not cover redirects, subresources, browser-side DNS differences/rebinding, service workers,
  or proxy-exit resolution.
- **Main-world DOM APIs remain page-controlled.** Text extraction and some semantic element checks use
  JavaScript evaluated in the page's main world. A hostile page can monkeypatch those DOM APIs; an owned
  isolated-world or browser-native accessibility extraction boundary is not implemented yet.
- **Fresh observation is not an action-specific business receipt.** After a mutating driver call, Lobee
  requires a new readable snapshot with matching full-URL identity. That detects unreadable, detached, or
  drifting state, but it cannot by itself prove that a payment, message, deletion, or other external
  operation semantically applied. Task-specific receipts/assertions remain M2A work.
- **No exact token/billing guarantee.** Local reservation and returned-usage quarantine are safety/cost
  guardrails. Remote reasoning, retries, image accounting, tokenizer differences, or inaccurate provider
  usage can exceed the configured number.
- **The panel has a bounded plaintext availability fallback.** When encrypted thread history cannot be
  verified, terminal task, answer/failure, and step text can be retained in extension local storage (or
  standalone `localStorage`) so a transient read failure does not erase the only visible result. Known
  credential shapes are redacted and content is bounded, but regex redaction is not a confidentiality
  boundary for arbitrary PII, private messages, or business data. A fallback is removed only after an exact
  encrypted counterpart is verified, so it can persist indefinitely if that counterpart is never written.
- **Registry cleanup is complete only on the owned successful-stop path.** The extension token and memory
  directory are staged while the profile extension snapshot is prepared; the memory key and network route
  are committed only after launch succeeds. Successful profile stop revokes the entry, but an out-of-band
  browser crash/close can retain it until a later successful relaunch-and-stop or sidecar restart.
- **Crash handling is fail-closed, not operator-complete.** Production runs are journaled. The next run
  automatically closes only non-sensitive states with no unresolved write and never replays an action.
  Unfinished sensitive records and ambiguous write/consequential effects block admission, but there is no
  supported resolution UI/API or run-resume path yet.
- **No CAPTCHA bypass.** CAPTCHA remains a visible human handoff. OTP/password/payment values use the
  sensitive-field channel.
- **Cross-origin frames and canvas are imperfect.** They require explicit vision or human interaction;
  screenshots can be stale or misread and therefore receive stronger freshness/approval handling.
- **Vision sends pixels to the selected model.** Enabling vision fallback authorizes a screenshot to be
  attached transiently to that provider request. Local code prevents durable secondary copies, but the
  provider's own processing/retention terms remain an external trust consideration.
- **A model remains stochastic.** A green battery is evidence for a pinned cohort, not proof for every
  website, future model, language, account state, or UI variant.
- **Live sites and oracles drift.** Tests must distinguish site/oracle unavailability from product failure
  without accepting stale or guessed answers.
- **Local encryption is at-rest protection.** It does not protect against a compromised desktop process,
  OS account, browser extension supply chain, or unlocked interactive session.
- **Learned skills are suggestions, not trusted policy.** They can become stale or misleading; every
  resulting action still passes schema, policy, approval, and freshness checks.
- **One active agent per profile is intentional.** Parallel agents sharing a mutable browser would break
  action grounding and approval identity. Parallel research requires separately isolated profiles or a
  future read-only orchestration design.
- **Reference parity is not a goal.** Lobee will not import arbitrary shell tools, unrestricted Python,
  a second browser automation runtime, or page-authored executable skills merely to match another agent's
  breadth.
- **No live pass is inferred from unit tests.** The paid/self-hosted battery must actually run with the
  shipping browser and approved provider; until then, capability status remains unverified or blocked.

## 11. Work item completion template

Every roadmap pull request should state:

- invariant or capability changed;
- enforcing component and why that boundary owns it;
- success, deny, malformed, stale-state, timeout, and cancellation tests added as applicable;
- storage/network/provider failure behavior;
- data newly persisted or transmitted and its redaction/retention policy;
- deterministic commands run and environment-dependent gates not run;
- benchmark report/task/model/browser versions;
- limitations changed, removed, or newly discovered;
- clean-room provenance when inspired by either reference repository.

This keeps implementation depth measurable: a feature is complete only when its authority, persistence,
failure behavior, evidence, and release gate are all explicit.
