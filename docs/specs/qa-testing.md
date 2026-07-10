# SPEC — QA, Testing & Anti-Detect Validation Strategy + Non-Functional Requirements

> **Scope:** the full test strategy for Lobster Browser — the testing pyramid, the anti-detect
> detector matrix, live anti-bot targets, the coherence validator, fingerprint-drift monitoring,
> performance benchmarks, non-functional requirements (SLOs), test-data reproducibility, and the
> release gates that map every layer to a CI job.
> **Audience:** both building agents (Claude — architect/reviewer/validation-harness owner; Codex —
> primary implementer of package/UI/backend tests).
> **Relationship to MASTER_PLAN:** this expands Pillar 6 (§4), the coherence bar (§6), the CI gates
> (§8), and Verification (§13). MASTER_PLAN stays the source of truth for scope; this doc is the
> detailed testing contract.
> **Status honesty:** every layer/target below is tagged **done / partial / planned** against the
> code that exists today (`ci/validation/`, the package tests, `apps/backend/**/*.spec.ts`, the Rust
> `#[cfg(test)]` modules, and `.github/workflows/ci.yml`). See the closing **Status vs target**.

---

## 0. Current state (what exists today)

The testing foundation that is already committed, so this spec is honest about the delta:

| Area | What exists | Status |
|---|---|---|
| Unit test runner (TS) | Node built-in `node:test` (`node --test "dist/**/*.test.js"`) across `fingerprint`, `proxy`, `cookies`, `engine-runner` | **done** |
| Unit/integration (backend) | NestJS specs via `node:test` + `supertest`: `auth` (service+e2e), `teams` (service+e2e), `profiles` (e2e) | **partial** |
| Rust unit tests | `cargo test --lib` — `sidecar.rs`, `profile_store.rs` `#[cfg(test)]` modules | **partial** |
| Engine integration | `engine-runner` `start-profile.integration.test.ts`, `patchright.integration.test.ts` (live Chromium launch; skip when no browser) | **done** |
| Coherence validator | `validateFingerprintCoherence()` in `packages/fingerprint/src/coherence.ts` (7 rules) + tests | **done** |
| Anti-detect gate | `ci/validation/run.mjs` → live **bot.sannysoft.com** + direct applied-fingerprint checks; `thresholds.json` | **done** (Sannysoft only) |
| Thresholds declared but not yet enforced | `creepjs`, `webrtc`, `coherence` keys exist in `thresholds.json` with no harness code driving them | **planned** |
| CI jobs | `web`, `secret-scan` (gitleaks), `rust`, `engine-launch`, `fingerprint-gate` | **done** |
| Load / chaos / security / drift / perf harnesses | none | **planned** |

Everything below marked **planned** is net-new work; **partial** means a thin slice exists and this
spec defines the target coverage.

---

## 1. The testing pyramid

Seven layers. Each has a **fixed runner**, a **CI-vs-nightly** placement, and a **coverage target**.
We keep the base wide (fast unit tests on every push) and the apex narrow (expensive live/anti-bot
suites nightly or on release).

```
                 ┌─────────────────────────┐
                 │   chaos / soak (nightly) │   L7  — resilience under failure
               ┌─┴─────────────────────────┴─┐
               │  security (nightly + PR-lite)│   L6  — SAST/DAST/deps/secrets
             ┌─┴─────────────────────────────┴─┐
             │      load / performance          │   L5  — SLO benchmarks
           ┌─┴─────────────────────────────────┴─┐
           │   DETECTOR matrix (anti-detect)      │   L4  — the moat gate
         ┌─┴─────────────────────────────────────┴─┐
         │              e2e / journey               │   L3  — full flows
       ┌─┴─────────────────────────────────────────┴─┐
       │             integration                      │   L2  — cross-module
     ┌─┴─────────────────────────────────────────────┴─┐
     │                    unit                          │   L1  — pure logic
     └──────────────────────────────────────────────────┘
```

### L1 — Unit

| | |
|---|---|
| **Runners** | TS: `node:test` (built-in); Rust: `cargo test --lib`; React: Vitest + Testing Library (**planned**) |
| **What** | pure functions: `deriveFingerprint`, `generateSeed`, PRNG determinism, `applyGeoToFingerprint`, `validateFingerprintCoherence`, proxy `parse`/`geo`, cookie codec, `buildLaunchOptions`/`buildCdpEmulation`, NestJS service methods, Rust profile-store crypto + single-instance lock |
| **CI** | every push / PR (the `web` + `rust` jobs) |
| **Speed budget** | whole suite < 60 s on CI |
| **Coverage target** | **≥ 90 %** lines on `packages/fingerprint` and `packages/proxy` (crown-jewel logic); **≥ 80 %** on other packages; **≥ 75 %** on Rust core |
| **Determinism rule** | no network, no filesystem outside tmp, no clock reads without injection; every fingerprint test uses a **fixed seed** (see §8) |

### L2 — Integration

| | |
|---|---|
| **Runners** | `node:test` (`*.integration.test.ts`); NestJS + `supertest` for HTTP; Rust integration harness for the Axum local API (**planned**) |
| **What** | sidecar JSON-RPC round-trips (`rpc.ts`), `start-profile` → direct native Lobium launch when provisioned, `lobium-fp.json` native-config assertion, backend module ↔ Prisma (against an ephemeral Postgres), local-API SDK ↔ Axum daemon |
| **CI** | `engine-launch` job prefers provisioned native Lobium; Patchright/Chromium jobs are internal compatibility harnesses only. Backend integration runs on `web` (Prisma client generated, SQLite/Postgres test DB). |
| **Coverage target** | every sidecar RPC method + every local-API endpoint + every backend controller has ≥ 1 integration test |
| **Skip contract** | browser-dependent tests **self-skip** when no engine is installed — never silently pass. Product-release gates must not count Patchright skips/passes as native Lobium proof. |

### L3 — e2e / journey

| | |
|---|---|
| **Runners** | Playwright (drives the Tauri UI via WebView + the local API); `tauri-driver` + WebDriver for the desktop shell (**planned**); backend e2e via `supertest` against a booted Nest app (**partial — auth/teams/profiles exist**) |
| **What** | the MASTER_PLAN §13 journeys end-to-end: create → launch → proxy → validate → connect Playwright/Selenium → stop; sign-up → create/sync profile → invite teammate → shared profile opens → action log recorded → Stripe tier gates count; export/import/transfer round-trip; cookie persistence across restart; single-instance lock |
| **CI** | a subset (backend journeys) on PR; **full desktop e2e nightly** (needs a display / Xvfb + engine) |
| **Coverage target** | 100 % of the seven §13 verification journeys have an automated e2e (today: journeys 4–5 partially covered by backend specs; desktop journeys **planned**) |

### L4 — Detector (anti-detect) matrix

The moat gate — see §2 and §3. Runner: `ci/validation/run.mjs` (extended). Live detectors headful
under Xvfb. **Blocking** on PR for Sannysoft; the full matrix runs nightly.

### L5 — Load / performance

Runner: k6 (API/sync throughput) + a bespoke Node orchestrator for concurrent-profile launch, memory,
and CPU (`tests/perf/`). See §6. **Nightly + pre-release**, never blocking on PR (too slow/noisy).

### L6 — Security

| Tool | Layer | Status |
|---|---|---|
| gitleaks | secret scan | **done** (`secret-scan` job) |
| `cargo audit` + `cargo clippy -D warnings` | Rust deps + lint | **partial** (clippy done; audit **planned**) |
| `npm audit --audit-level=high` / OSV-Scanner | JS deps | **planned** |
| CodeQL (JS + Rust) SAST | static analysis | **planned** |
| OWASP ZAP baseline (DAST) against staging backend | dynamic | **planned** |
| Semgrep ruleset (crypto misuse, injection, CDP-artifact leaks) | targeted SAST | **planned** |

Blocking scope: gitleaks + `npm audit` high/critical + `cargo audit` on PR; CodeQL/ZAP/Semgrep nightly.

### L7 — Chaos / soak

| Scenario | Injected fault | Pass criterion | Status |
|---|---|---|---|
| Sidecar crash mid-session | `SIGKILL` the Node sidecar | desktop core detects, marks profile stopped, releases lock, restarts sidecar | **planned** |
| Proxy drops mid-session | kill upstream proxy | no fingerprint/IP leak (no WebRTC fallback to real IP), profile surfaces error | **planned** |
| Backend 5xx / network partition during sync | fault-inject S3 + Postgres | desktop queues, retries with backoff, no blob corruption; conflict resolution holds | **planned** |
| 24 h soak: 25 profiles cycling launch/stop | none (endurance) | no fd/memory leak (RSS drift < 5 %/24 h), no orphaned Chromium procs | **planned** |
| Clock skew / DST boundary | shift host clock | timezone spoof stays coherent; no lie introduced | **planned** |

---

## 2. Detector matrix

The objective anti-detect bar. Each detector is **self-hosted** (deterministic, offline-capable) where
an OSS build exists, and cross-checked against the **live** site nightly to catch upstream detection
changes. Scoring thresholds live in `ci/validation/thresholds.json`.

| Detector | Signals we read | Self-host | Live URL | Pass criterion | Status |
|---|---|---|---|---|---|
| **Sannysoft** | webdriver, UA/UA-CH, plugins, WebGL vendor/renderer, permissions, per-test pass/fail cells | vendored HTML (planned) | `bot.sannysoft.com` | `failed ≤ thresholds.sannysoft.maxFailed` (currently **2**, WebGL native-surface allowance) | **done (live)** |
| **CreepJS** | trust score, **lies** count, workers/OffscreenCanvas coherence, WebGL/canvas/audio hashes, `resistance` (Tor/Brave tells) | self-host from OSS repo | `abrahamjuliot.github.io/creepjs` | `trustScore ≥ minTrustScore` (**60**) **and** `lies == maxLies` (**0**) | **planned** (thresholds present, no scraper) |
| **Pixelscan** | consistency verdict, mask/automation detection, WebRTC vs proxy | live only (no OSS) | `pixelscan.net` | verdict == "consistent"/"You look normal"; no "automation" flag | **planned** |
| **Iphey** | "Trustworthy" verdict across browser/OS/proxy/hardware sections | live only | `iphey.com` | all sections "Trustworthy" (green) | **planned** |
| **BrowserLeaks** | canvas hash stability, WebGL, WebRTC IP leak, fonts, JS/navigator, ClientRects, timezone, DNS | vendored per-page HTML | `browserleaks.com/{canvas,webgl,webrtc,fonts,ip}` | WebRTC public IP == proxy IP; canvas/WebGL **stable within session**; timezone == proxy geo | **planned** |
| **FingerprintJS** (open-source + Pro demo) | visitorId stability, `botd` bot signals, incognito detection | self-host OSS `fingerprintjs` + `botd` | `fingerprint.com/demo` | `botd` returns not-bot; visitorId **stable across restarts** for one profile, **distinct across profiles** | **planned** |
| **CreepJS-lies** (sub-check) | the `lies` array specifically — any prototype/Proxy tamper tell | part of CreepJS host | — | `lies.length == 0` (hard fail on any) | **planned** |
| **AmIUnique / deviceInfo** (optional cross-check) | entropy bits, uniqueness | self-host | `amiunique.org` | entropy within real-population band (not maximally unique, not suspiciously common) | **planned (P2)** |

### `thresholds.json` — target schema

Extend the existing file (today it has `sannysoft`, `creepjs`, `webrtc`, `coherence`) to the full matrix:

```jsonc
{
  "sannysoft":     { "maxFailed": 2 },
  "creepjs":       { "minTrustScore": 60, "maxLies": 0, "minResistanceScore": 0.5 },
  "pixelscan":     { "requireConsistent": true, "forbidAutomationFlag": true },
  "iphey":         { "requireAllTrustworthy": true },
  "browserleaks":  { "requireCanvasStableInSession": true, "requireWebglStableInSession": true },
  "fingerprintjs": { "requireNotBot": true, "requireVisitorIdStable": true, "requireVisitorIdDistinct": true },
  "webrtc":        { "requireIcePublicIpEqualsProxyIp": true, "forbidLocalIpLeak": true },
  "coherence":     { "maxIssues": 0 }
}
```

### Self-host vs live policy

- **Self-host is authoritative for the gate** (deterministic, no rate-limit, works offline in CI). Vendor
  the OSS builds under `tests/detectors/<name>/` and serve them from a local static server during the run.
- **Live runs nightly** and is **advisory→alerting** (opens an issue on regression) — it catches when a
  detector ships new heuristics before we vendor them, and validates the self-hosted copy hasn't drifted.
- A detector with **no OSS build** (Pixelscan, Iphey) is live-only and runs nightly, never blocking a PR
  (avoids flaky external-dependency failures on the merge path).

### Engine expectation

The production matrix runs against **native Lobium** and targets full green on real consumer GPU hardware.
Patchright/Chromium harnesses may run for regression comparison, but their allowances do not define the
release bar. Any remaining detector allowance must be documented against Lobium in `thresholds.json` and
`PROJECT-STATUS.md`.

---

## 3. Live anti-bot testing

Beyond fingerprint detectors, we validate against real commercial bot-management stacks. These are the
customers' actual adversaries.

| Vendor | Test target | Signal | Pass criterion | Status |
|---|---|---|---|---|
| **Cloudflare Turnstile** | a controlled page with a Turnstile managed widget | challenge auto-solves / does not hard-block | non-interactive pass (token issued) behind a residential proxy | **planned** |
| **Cloudflare Bot Management** | Cloudflare-fronted test origin (own domain) | bot score / `cf-mitigated` header | not challenged (`cf-mitigated: none`), served 200 | **planned** |
| **DataDome** | DataDome demo / protected test page | `x-datadome` cookie, block interstitial | no CAPTCHA interstitial; request proceeds | **planned** |
| **Akamai Bot Manager** | Akamai-fronted test path | `_abck` cookie validity, sensor-data acceptance | `_abck` valid, no 403/deny | **planned** |
| **Kasada** | Kasada demo endpoint | `x-kpsdk-*` headers, 429 challenge | challenge cleared, content served | **planned** |
| **HUMAN / PerimeterX** | PX-protected test page | `_px*` cookies, block page | no block/CAPTCHA | **planned** |
| **reCAPTCHA v3 score probe** | own page with a v3 site key | returned score | score ≥ 0.5 (human band) | **planned** |

### Pass criteria (general)

A profile **passes** a target when, behind a residential proxy with a coherent geo-matched fingerprint,
it reaches the protected content **without a hard block or an interactive challenge** on a cold visit.
We record the response code, mitigation headers, and any interstitial — and trend the **pass rate**
(target ≥ 90 % across the panel per engine) rather than demanding 100 % (these stacks are probabilistic).

### How to run safely / legally

- **Own the targets.** Prefer our **own domains** fronted by each vendor (a small paid test tenant) so we
  are not probing third-party production sites. Use vendors' official demo/sandbox pages where provided.
- **Respect ToS and rate limits.** Low volume (a handful of visits per target per nightly run), randomized
  spacing, our own proxies, no scraping of real data. This is compliance validation of *our* product, not
  attacking others.
- **Isolate credentials.** Test-tenant API keys live in CI secrets, never in the repo (gitleaks enforces).
- **Non-blocking.** Live anti-bot runs **nightly only** and alerts on trend regressions; it never gates a
  PR (external, probabilistic, and rate-limited).
- **Kill-switch.** A single env flag (`LOBSTER_LIVE_ANTIBOT=0`) disables the whole panel if a vendor asks
  or a target changes.

---

## 4. Coherence validator

The automated cross-surface consistency check — the cheapest, fastest anti-detect defense (runs in unit
time, no browser). Today `validateFingerprintCoherence(fp)` enforces **7 rules**; this section is the
target rule set. Extend the same function so the editor UI, the sidecar, and the CI gate all consume one
list of issues.

### Existing rules (done)

1. UA string contains the OS token for `fp.os`.
2. `navigator.languages[0]` == `locale.locale`.
3. `Accept-Language` leads with `locale.locale`.
4. `navigator.platform` matches the OS (`Win32` / `MacIntel` / `Linux …`).
5. `screen.avail{W,H}` ≤ physical `screen.{width,height}`.
6. WebGL vendor/renderer non-empty.
7. No `Direct3D` renderer on non-Windows OS.

### Target additional rules (planned)

| # | Rule | Rationale |
|---|---|---|
| 8 | UA-CH `Sec-CH-UA` brand/version list matches the UA major version and includes correct GREASE | UA vs UA-CH mismatch is a top tell |
| 9 | UA-CH `platform` / `platformVersion` coherent with `fp.os` (e.g. `"Windows"` + `"15.0.0"`) | client-hints OS must equal navigator OS |
| 10 | `deviceMemory` ∈ {0.5,1,2,4,8} and coherent with `hardwareConcurrency` band | implausible RAM/CPU pairing |
| 11 | `maxTouchPoints > 0` **iff** mobile profile; desktop == 0 | touch on desktop = tell |
| 12 | WebGL `UNMASKED_VENDOR/RENDERER` GPU string exists in the real-device GPU pool for that OS | fabricated GPU string |
| 13 | Screen resolution + DPR ∈ the real-device resolution pool; `colorDepth == 24`, `pixelDepth == 24` | odd resolution/DPR |
| 14 | Timezone ∈ the set valid for the proxy country; geolocation lat/long inside the country bbox | geo cluster must agree with proxy IP |
| 15 | Fonts set is the canonical OS font list (no Linux fonts on a Windows profile) | font enumeration tell |
| 16 | AudioContext `sampleRate` ∈ {44100, 48000}; `baseLatency` plausible for the claimed hardware | audio DSP outlier |
| 17 | Engine version (Chromium/Lobium build) major == UA-claimed major | version-alignment (ties to §5 drift) |
| 18 | WebRTC policy set such that ICE would surface only the proxy IP (config-level check) | pre-empts §3 WebRTC leak |
| 19 | `navigator.webdriver` absent + no CDP `Runtime.enable` global (automation-artifact check) | clean-CDP invariant |
| 20 | Mobile profile: UA `Mobile` token ⇔ `maxTouchPoints>0` ⇔ mobile GPU ⇔ narrow viewport all agree | mobile set internal coherence |

### Contract

- **Return shape:** `string[]` today; upgrade to `{ code, severity: 'error'|'warn', message, surface }[]`
  so the editor can badge fields and the gate can fail only on `error`.
- **Gate wiring:** the CI harness calls `validateFingerprintCoherence` on the derived (and geo-applied)
  fingerprint and fails when `errors > coherence.maxIssues` (0). **This wiring is planned** — the
  threshold key exists but `run.mjs` does not yet invoke the validator.
- **Editor wiring:** live inline validation in the fingerprint editor UI, blocking save on `error`.
- **Runtime wiring:** the harness additionally re-reads the surfaces **from the live page** (as `run.mjs`
  already does for UA/hwConcurrency/languages/timezone) and asserts the applied values equal the intended
  fingerprint — catching a divergence between the config model and what the engine actually renders.

---

## 5. Fingerprint drift monitoring

Fingerprints rot when Chrome-stable moves. A profile built for Chrome 141 looks stale the day Chrome 142
ships (UA major, UA-CH version list, GREASE, feature detection, new APIs). We monitor drift and alert.

| Signal | Source | Cadence | Alert trigger | Status |
|---|---|---|---|---|
| **Chrome-stable version** | Chromium release API / `chromiumdash` | daily cron | new stable major published | **planned** |
| **UA / UA-CH template staleness** | diff our default UA template vs latest stable | daily | our default major < stable major − 1 (we lag > 1 release) | **planned** |
| **Lobium rebase lag** | Lobium build base vs stable | weekly | base major < stable − 2 | **planned** |
| **Real-device dataset freshness** | fingerprint-suite dataset version | weekly | dataset > 90 days old | **planned** |
| **Detector heuristic drift** | nightly live-detector deltas (§2/§3) | nightly | score/verdict regresses vs 7-day baseline | **planned** |

### Mechanism

- A scheduled workflow (`.github/workflows/drift.yml`, **planned**) queries the Chromium release feed,
  compares against `packages/fingerprint` UA templates + the Lobium base, and opens a GitHub issue
  (`kind: drift`) with the delta and a suggested bump.
- **Version-cadence alert:** because Chrome ships ~monthly, the target is to **never lag stable by more
  than one major**. The alert escalates: lag 1 = info, lag 2 = warn (issue), lag 3 = block (drift becomes a
  release gate — see §9).
- Drift monitoring **reuses the coherence validator rule 17** (engine major == UA major) so a stale
  fingerprint fails the gate locally even before the cron fires.

---

## 6. Performance benchmarks & targets

Measured in `tests/perf/` (**planned**), nightly + pre-release. Reference hardware: an 8-core / 16 GB CI
runner (documented in the result so numbers are comparable run-to-run).

| Metric | Definition | Target | Stretch (Lobium) | Status |
|---|---|---|---|---|
| **Cold profile launch** | `POST /start` → CDP endpoint reachable, first paint | **≤ 3.0 s** p50, ≤ 5.0 s p95 | ≤ 2.0 s p50 | **planned** |
| **Warm launch** | same, engine binary cached, warm user-data-dir | ≤ 1.5 s p50 | ≤ 1.0 s | **planned** |
| **Concurrent profiles (1 host)** | N simultaneous live profiles, all responsive | **≥ 25** on 16 GB; ≥ 50 on 32 GB | ≥ 50 / 16 GB | **planned** |
| **Memory per idle profile** | RSS delta per additional idle profile | **≤ 250 MB** | ≤ 180 MB | **planned** |
| **Memory per active profile** | RSS under light browsing | ≤ 450 MB | ≤ 350 MB | **planned** |
| **CPU per idle profile** | steady-state | ≤ 1 % core | ≤ 0.5 % | **planned** |
| **Fingerprint derive** | `deriveFingerprint()` single call | **≤ 5 ms** p50, ≤ 20 ms p99 | — | **partial** (measurable now) |
| **Local API latency** | `list`/`status` round-trip on loopback | **≤ 20 ms** p95 | — | **planned** |
| **Local API `start` throughput** | serial launches/min | ≥ 20/min | ≥ 40/min | **planned** |
| **Cloud API latency** | backend CRUD p95 (excl. network) | **≤ 150 ms** p95 | — | **partial** (e2e exists) |
| **Sync throughput** | encrypted blob push/pull | ≥ 20 MB/s or ≤ 2 s per 10 MB profile | — | **planned** |
| **Sync latency (small profile)** | 100 KB cookie blob push+ack | ≤ 500 ms p95 | — | **planned** |
| **Detector-gate wall time** | full nightly matrix, 1 profile | ≤ 8 min | — | **partial** (Sannysoft ~2 min) |
| **Desktop app cold boot** | Tauri window interactive | ≤ 2 s | — | **planned** |
| **Installer size** | signed Windows installer (excl. downloaded engine) | ≤ 40 MB | — | **planned** |

Perf runs record p50/p95/p99 and **fail the nightly** on a > 20 % regression vs the trailing 7-day median
(guards against silent perf rot without flaking on single noisy runs).

---

## 7. Non-functional requirements (SLOs)

The formal NFR contract. "Availability" applies to the cloud SaaS; the desktop agent is local-first and
must keep working (create/launch/automate) **fully offline** — cloud sync is best-effort.

| Category | Requirement | Target / SLO | Measure | Status |
|---|---|---|---|---|
| **Performance** | Cold launch p95 | ≤ 5 s | perf suite (§6) | **planned** |
| | Local API p95 | ≤ 20 ms | perf suite | **planned** |
| | Cloud API p95 | ≤ 150 ms | APM / load test | **partial** |
| **Scalability** | Profiles per host | ≥ 25 / 16 GB | perf suite | **planned** |
| | Profiles per account | ≥ 5,000 stored | backend load | **planned** |
| | Backend RPS | ≥ 500 req/s/instance @ p95 SLO | k6 | **planned** |
| | Concurrent sync clients | ≥ 1,000 | load test | **planned** |
| **Reliability** | Launch success rate | ≥ 99.5 % (excl. bad proxy) | e2e + telemetry | **planned** |
| | Sync data-loss rate | 0 (versioned, conflict-safe) | chaos L7 | **planned** |
| | Profile corruption rate | 0 (atomic writes, checksums) | chaos + soak | **planned** |
| | Crash-free sessions | ≥ 99 % | telemetry | **planned** |
| **Availability** | Cloud SaaS uptime | ≥ 99.9 % (≈ 43 min/mo) | uptime monitor | **planned** |
| | Desktop offline capability | 100 % of core flows offline | e2e offline suite | **planned** |
| | RTO / RPO (backend) | RTO ≤ 1 h, RPO ≤ 5 min | DR drill | **planned** |
| **Security** | Profile blobs encrypted | AES-256-GCM at rest + TLS in transit | crypto unit + review | **partial** |
| | Secrets in repo | 0 | gitleaks (blocking) | **done** |
| | Known high/critical CVEs in deps | 0 shipped | `npm/cargo audit` | **planned** |
| | Local API auth | Bearer key required on every endpoint; rate-limited | integration | **partial** |
| | CDP artifacts | none (`webdriver` absent, no global `Runtime.enable`) | detector gate | **done** (Sannysoft check) |
| | WebRTC/DNS leak | none behind proxy | detector gate (§2) | **planned** |
| **Maintainability** | Test coverage (crown-jewel pkgs) | ≥ 90 % | coverage report | **partial** |
| | Version lag vs Chrome-stable | ≤ 1 major | drift monitor (§5) | **planned** |
| **Usability / Compat** | Target OS | Windows (P0), macOS (P1), Linux (headless/Lobium) | manual + CI matrix | **partial** |

---

## 8. Test-data management & reproducibility

Anti-detect testing is only meaningful if it is **reproducible** — the same seed must yield the same
fingerprint, so a gate failure is debuggable and a regression is bisectable.

- **Seeded determinism (done).** `deriveFingerprint(seed, opts)` is a pure function of `(seed, os,
  engine)` via the package PRNG (`prng.ts`, `seed.ts`). Every unit test passes a **fixed literal seed**
  (`'seed-de'`, `'seed-xx'`, …). The validation harness uses `generateSeed()` for realism but must **log
  the seed** so any failure is replayable (add `seed` to the emitted JSON report — currently it derives a
  fresh seed without printing it: **gap**).
- **Golden fixtures (planned).** Commit `tests/fixtures/fingerprints/*.json` — a frozen set of derived
  fingerprints per OS/engine — and a snapshot test asserting `deriveFingerprint(knownSeed)` still equals
  the golden. This catches unintended fingerprint changes (which are also anti-detect regressions) and is
  the local counterpart to §5 drift.
- **Real-device dataset pinning (planned).** Pin the fingerprint-suite dataset version in the lockfile;
  the drift monitor (§5) alerts when it ages out. Never let CI silently pull a newer dataset.
- **Proxy/geo fixtures (partial).** `packages/proxy` tests use canned `GeoInfo` objects; the anti-bot and
  WebRTC checks need a **stable test proxy** (a dedicated residential exit in CI secrets) so geo-coherence
  is verifiable. Mark tests that need it and self-skip when absent.
- **Backend test DB (partial).** Ephemeral Postgres (or SQLite for unit) spun per run; Prisma `migrate
  deploy` + a deterministic seed script; torn down after. No shared/stateful test DB.
- **No PII / no live customer data** in any fixture. Synthetic accounts only.
- **Detector fixtures (planned).** Vendor the self-hosted detector builds at a **pinned commit** under
  `tests/detectors/` so a detector's own change never silently moves our gate.

---

## 9. Release gates → CI jobs

Every layer maps to a concrete job. **Blocking** = merge/release cannot proceed red.

| Gate | Layer | CI job (existing / planned) | Trigger | Blocking? | Status |
|---|---|---|---|---|---|
| Format | — | `web` → `format:check` | PR/push | yes | **done** |
| Typecheck | L1/L2 | `web` → `typecheck` (+ `prisma generate`) | PR/push | yes | **done** |
| Build | — | `web` → `build` | PR/push | yes | **done** |
| Unit + integration (TS/backend) | L1/L2 | `web` → `test --workspaces` | PR/push | yes | **done** |
| Rust build/test/fmt/clippy | L1 | `rust` | PR/push | yes | **done** |
| Secret scan | L6 | `secret-scan` (gitleaks) | PR/push | yes | **done** |
| Engine launch (native Lobium when provisioned) | L2 | `engine-launch` | PR/push | yes | **partial** |
| **Anti-detect gate (Sannysoft)** | L4 | `fingerprint-gate` (`run.mjs` under Xvfb) | PR/push | **yes** | **done** |
| Coherence validator wired into gate | L4 | `fingerprint-gate` (invoke `validateFingerprintCoherence`) | PR/push | yes | **planned** |
| Dep audit (`npm`/`cargo audit`) | L6 | `deps-audit` | PR/push | yes | **planned** |
| Full detector matrix (CreepJS/Pixelscan/Iphey/BrowserLeaks/FingerprintJS) | L4 | `detector-matrix` | nightly | alerting | **planned** |
| Live anti-bot panel | L4 | `anti-bot` | nightly | alerting | **planned** |
| Desktop e2e (Tauri journeys) | L3 | `e2e-desktop` | nightly | alerting | **planned** |
| Performance / load | L5 | `perf` | nightly + pre-release | pre-release blocking | **planned** |
| Security SAST/DAST (CodeQL/ZAP/Semgrep) | L6 | `security` | nightly | alerting | **planned** |
| Chaos / soak | L7 | `chaos` | nightly/weekly | alerting | **planned** |
| Fingerprint drift | §5 | `drift` | daily cron | alerting → blocking at lag ≥ 3 | **planned** |

**Release-candidate gate (Day 10 / any release):** all PR-blocking gates green **plus** a clean nightly
of the detector matrix, the anti-bot panel ≥ 90 % pass, perf within targets, no high/critical CVEs, and
version lag ≤ 1 major. This is the machine-checkable form of MASTER_PLAN §13 acceptance.

---

## Status vs target

**Built and honest today:** a fast unit/integration base on `node:test` + `cargo test`, direct native
Lobium launch tests when a binary is provisioned, a retained Patchright compatibility harness, backend
auth/teams/profiles specs, a working **coherence validator**, and detector scripts including
`lobium-detect.mjs`. The L1/L2 base is real; the release-grade L4 rail still needs real-GPU Lobium CI.

**The delta to this spec (all planned):** the rest of the detector matrix (CreepJS/Pixelscan/Iphey/
BrowserLeaks/FingerprintJS — thresholds are declared but unwired), the live anti-bot panel, wiring the
coherence validator and WebRTC-leak check into the gate, desktop e2e journeys, the load/perf suite with
its SLO numbers, the security SAST/DAST stage, chaos/soak, fingerprint-drift monitoring, golden-fixture
reproducibility (including logging the harness seed), and the nightly/daily CI jobs that host them. The
Sannysoft historical allowances came from the interim-harness era. The release target is native Lobium
full green on real GPU, with any temporary allowance explicitly justified and tracked. The pyramid's base
is load-bearing; the apex is scaffolding to build.
