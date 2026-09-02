# Full-project audit and master plan — 2026-09-02

**Status: findings gathered for 5 of 7 domains** (agent core, agent performance, panel UX,
presence/real-time, backend/DB/web). The first-run/sync domain was reconstructed by hand from
server evidence (below); the engine/distribution domain is not yet audited. Findings carry
`file:line`; where a finding drives a change, the implementer re-verifies the citation.

## The owner's failures, explained

### (d)(e) Second machine showed no profiles, and no session came back — ROOT CAUSE FOUND, FIXED
nginx has the whole story. The second PC (`168.158.124.69`, 13:02–13:03) completed the *browser*
side of sign-in — `login?desktop=1&port=…` → `POST /auth/login 200` → `POST /auth/desktop/grant
200` — and then **the launcher never reached the API once**: no `engine-manifest.json`, no
`desktop/exchange`, no `GET /profiles`, no engine download. The only `desktop/exchange` in the
entire log is the first machine's. It was never a slow download; nothing was ever requested.

Cause, proven in the vendored crates: `reqwest` is pulled with `default-features = false`, which
drops its default `system-proxy` feature; that feature is the *only* path that reads the Windows
registry proxy (`hyper-util/client-proxy-system` → `windows-registry`). The launcher honoured env
proxies only, so on a machine routed through a system proxy / VPN client the browser worked and
every launcher request failed to connect. **Fixed in `5724cda`** (one feature flag; all launcher
HTTP clients share the builder). Ships with the next installer.

Session data itself is captured correctly (cookies transcoded portably, storage, extensions —
verified 2026-09-01 in `snapshot/mod.rs`); it never came back because the launcher never signed
in server-side. Two backend defects would still bite a *reachable* second machine, both
`profiles.service.ts:425-427`: no version probe (the launcher downloads every clean profile's full
blob every 60 s to learn nothing changed), and the profile row never records blob state, so one
failed/oversized pull is silent and never retried. Wave 3.

### (a) The agent "doesn't work well" / "remove all cookies of outlook.com" left Outlook signed in
Fully explained: `clear_cookies` matches `outlook.com` and subdomains only
(`cdp-driver.ts:580`) while Microsoft's session lives on `live.com` / `microsoftonline.com` /
`office.com`; a zero-cookie result is phrased "cleared 0 cookie(s)" and classified "completed"
(`prompt.ts:199`); there is no cookie read-back, no reload, no verification of *any*
`browser_config` effect (`loop.ts:2217`); no site-knowledge skill for "log out / clear session"
(`skills.ts:364`); and the prompt steers "all … cookies" toward `clear_all_cookies`, which wipes
every session in an anti-detect profile (`actions.ts:350`).

"Flexibility" fails structurally: a reply to `ask` reaches the model as a 120-char clip inside
an UNTRUSTED fence it is told never to obey (`loop.ts:1661`); a second message is refused while a
run is active and Stop+resubmit starts from an empty context (`manager.ts:106`, made worse by the
2026-09-02 no-persistence change); Ask/Agent is a manual toggle with no intent router
(`App.tsx:479`); "situation change" is five regexes (`extract-script.ts:299`); in-run memory keeps
6 snapshots and 300-char headers (`loop.ts:2071`).

### (b) Slow
One LLM round trip per step — but configured as slowly as possible: Opus 4.8 at medium effort
(thinking, 8000 max_tokens) on *every* step; `stepModel` never wired (`models.ts:89`,
`managed-credential.ts:345`); non-streamed behind a 55 s ceiling with one attempt
(`agent-llm.service.ts:35`); the prompt cache is defeated every step because already-sent
messages are rewritten (`loop.ts:2077`) — that is the 10–12K uncached tokens/step seen in
production; `waitForSettle` is 0.5–8 s per action and never stabilises on live pages like Outlook
(`cdp-driver.ts:521`); 2–3 DOM walks per step; 4–6 fsynced journal re-encryptions per step for a
journal whose blocking purpose was removed; 100 K budget ends dense runs at step 8–12
(`bridge.ts:24`); hrefs up to 8192 chars and 6 verbatim snapshots in context (`perceive.ts:154`);
zero timing telemetry.

### (c) Only dots, no text
The rail demotes text to a tooltip (`App.tsx:201`, the 2026-09-02 change), and the harness never
emits an action *outcome* event while the prompt discourages `note` (`loop.ts:1373`). Metering
notices (retry/backoff) are emitted as `log` and dropped by the reducer (`turns.ts:188`).

### (f) No real-time status
No shipped client ever writes a lease: the launch path never acquires/refreshes/releases one
(`local_api.rs:234`); there is no device identity or label; no bulk lease read; `GET /profiles`
hard-codes `status: idle`; no push transport. Worse, the status pollers bump `updated_at`, and
dirtiness derives from `updated_at`, so **every running profile is permanently dirty and
re-uploaded every 60 s** (`useProfiles.ts:59`, `profile_store.rs:885`).

### (g) "Messy" — the honest engineering verdict
Real, and mostly in production plumbing rather than product code: the release procedure ships
`dist/` only (workspace packages and migrations go stale — hit live on 2026-09-01);
`NODE_ENV` is set by nothing, and every production-only guard keys on it
(`health.controller.ts:49`); the backend logs no requests; the blob store keeps every version
forever and never enforces the quota (`filesystem-blob-store.ts:131`); auth has no revocation,
password change or reset, 365-day desktop tokens, and re-registering a pending email overwrites the
victim's credentials (`prisma-users.repository.ts:72`); unlimited free teams bypass the paid
profile limit (`teams.service.ts:134`); default team is "oldest team", so an invitation silently
redirects sync, billing and agent spend (`resolve-team-id.ts:488`); one in-memory 120/min bucket
covers sync, leases and every LLM step (`main.ts:41`); metering runs in the critical path of every
step with ~8 DB round trips (`agent-llm.service.ts:805`); the roster sync runs inside requests
with no negative cache (`:428`); `tool_choice` is silently rewritten for Anthropic models (`:746`).
The security boundaries (fences, redaction, upload scanning, config guard) are genuinely strong;
the loop is a 2,300-line function with dead action kinds and docs that contradict the code.

## Two conflicts, resolved
1. **"Remember the user" vs "never save history/memory."** The visible conversation is the unit
   of context: one thread per on-screen chat, a new one only on an explicit *New chat*, retained
   in-session (runtime memory + `chrome.storage.session`) and never written to long-term disk. Plus
   a harness-owned working-memory block re-sent each step (task contract, trusted user
   instructions, the model's own plan/notes). The 2026-09-02 fresh-thread-per-submit change broke
   follow-ups and is reverted by this.
2. **"Never stop for approval" vs `clear_all_cookies` wiping every session.** Autonomy stays. A
   named site is site-scoped *by construction* (a product gate, not model judgment); wipe-all
   requires literal site-less phrasing; every destructive step is announced in the step report.

## The plan, in waves

**Wave 0 — done:** system proxy (`5724cda`); everything shipped 2026-09-01/02.

**Wave 1 — the reported failures, contained, doable solo — DONE 2026-09-02 (see the commits of
that day; every item below shipped with tests, except phase timing telemetry, which moves to
Wave 2 with the streaming work):**
- Per-step report rows in the rail (rail + one brief line; `step.outcome` event; required `note`).
- Speed defaults: `stepModel` = Sonnet-class at low effort for routine steps, primary model for
  step 1/recovery; panel default model/effort revisited; timing telemetry per phase.
- Cookie/session clearing that works: `clear_session {site}` resolves a site to its cookie footprint
  (`site-families.ts`: a curated table of identity domains — outlook.com → live.com,
  microsoftonline.com, office.com … — plus whatever the live store holds under the site), deletes
  cookies AND storage across the family, reloads a tab that is on the site, reads the store back and
  reports per-domain counts; `list_cookies` shows where sessions live; a zero-match `clear_cookies`
  is an error that names the related domains instead of "cleared 0 cookie(s)"; a wipe-all for a
  request that names a site becomes that site's `clear_session` in the loop (site-scoped by
  construction, `scopeWipeAllToNamedSite`); a "clear-site-session" skill.
- `waitForSettle` → MutationObserver quiet window (kills the 8 s ceiling on live pages).
- `NODE_ENV=production` in the unit; request logging in the backend.
- Status pollers must not bump `updated_at` (stops the every-60 s re-upload of running profiles).

**Wave 2 — agent architecture (needs agent fan-out).** *First slice shipped 2026-09-02 (solo):*
steering RPC (`POST /steer` → `AgentManager.steer` → `deps.takeSteering`) + the trusted user
channel (`BEGIN_USER_MESSAGE` fence, reserved in `sanitizeUntrusted`; steering and `ask` replies
arrive as full user turns; the panel composer steers a live run instead of refusing; `run.steered`
rows in the rail); cache-stable message layout (nudges + both ledgers moved into ONE regenerated
trailing user message that the loop removes before appending the next step; tool results are never
rewritten; pruning moves in batches of 3); observation diet (element hrefs clipped to 256,
verbatim window 4); budget default 1M for managed runs (the wallet meters); same-URL navigate waits
on `performance.timeOrigin` turnover instead of a 10 s dead poll. *Second slice shipped 2026-09-02 (652d9e1):* streamed tool steps — the adapter reassembles the
forced tool call from OpenRouter's fragments, reasoning/argument bytes are activity for the 90 s
idle watchdog (no more 55 s wall clock ending a long-thinking step), `step.progress` → "Reasoning…
2.4k" on the thinking step. Shipped state at 22:00 Berlin: backend redeployed (request log live),
Linux .debs and Windows installers republished from d4a8438 (streaming lands in the next build).
*Still open:* steering RPC + trusted user channel;
working memory; intent router ("auto" mode); situation-change transitions as events; streamed
agent steps with idle watchdog instead of a wall clock; cache-stable message layout; observation
diet (href clip, 2–3 snapshots, diffs); bounded action batches; budget arithmetic; journal
cost decision; `loop.ts` split into observe/decide/gate/execute/verify/record.

**Wave 3 — presence + lazy first run.** *First slice shipped 2026-09-02 (solo):* the version
probe (`GET /profiles` carries `syncVersion` from the blob store's `head`; the launcher's
`reconcile` skips the pull when the account has not moved — ends the full-blob download of every
clean profile every 60 s); presence end to end (`presence.rs`: stable device id + hostname label,
lease acquire on launch / refresh every 60 s / release on stop, a 20 s poll of the new bulk
`GET /leases`, merged into `list_profiles` as `presence`; the profile list shows "Running on
<machine>"). *Second slice (same day):* row-first sign-in — `materialise` creates the row from
the account's metadata before any download, keeps it when the data fails, and the list shows each
row's state ("Not downloaded yet", "Downloading…", "Restoring 12/40 files"); a profile's data is
fetched on demand at Run (`ensure_materialised`) and by the next reconcile tick, which now also
restores a pulled snapshot into a missing user-data-dir. *Still open:* device identity + label; lease acquire/refresh/release
around launch; `GET /profiles/leases`; lease on the Profile row; "running on <machine>" and
proxy "used by"; sync version probe + `blobVersion` on the row + conditional pull; download
progress in the list; restore deferred to launch; blob retention + quota.

**Wave 4 — engineering debt:** staged deploy script (dist + prisma + workspaces + migrate);
sessions/revocation/password reset; pending-registration fix; team caps / allowance per billing
account; per-route rate limits; metering off the critical path; roster warmed at boot;
`tool_choice` passthrough; engine/distribution audit; upstream rebase (.42 → .64).

**Needs a real machine to verify:** every agent behaviour, the panel, installers, and the
second-PC sign-in (its launcher log will confirm the proxy diagnosis).
