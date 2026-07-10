# MASTER PLAN — Lobster Browser (Anti-Detect Browser & SaaS)

> **Product & project name:** **Lobster Browser**
> **Owner:** dkangevworld.wang1@gmail.com
> **Builders:** Claude (lead architect / integrator / reviewer) + OpenAI Codex (primary implementer). All engineering, coding, and review is done by these agents.
> **License posture:** Lobster ships **open source**, so we **freely fork, import, and adapt** any open-source code (any license). Donut Browser and other projects are used as **reference/inspiration only** — we own our full codebase. Legal & licensing are maintained by the owner separately.
> **Timeline:** the original 10-day sprint produced the product scaffold; the current production target is
> Lobium-only. See [`PROJECT-STATUS.md`](PROJECT-STATUS.md) for live status and
> [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md) for current sequencing.
> **Status of this doc:** authoritative — the single source of truth for both agents. Any change to scope, stack, or the working rules is edited here first.
> **Depth:** this plan is the strategy and shape; the **production-depth detail** lives in [`docs/specs/`](specs/) (§14). For an honest, current read of what's built vs. the target, see [`docs/GAP-ANALYSIS.md`](GAP-ANALYSIS.md) and the risk/gap register (§16).

---

## 0. Context — what we're building and why

We are building **Lobster Browser**: a **production-grade anti-detect browser + SaaS**, feature-comparable to **Octo Browser** and its peers (Multilogin, AdsPower, GoLogin, Dolphin{anty}, Kameleo). Managing many isolated, real-looking browser identities for affiliate marketing, e-commerce multi-accounting, ad verification, market research, web QA/automation, and privacy.

Each **profile** gets a **coherent, stable, real-system-based device + network identity** (fingerprint), fully isolated from every other profile and consistent enough to sail through modern anti-bot systems (Cloudflare, DataDome, Akamai, HUMAN/PerimeterX, Kasada). Our value: (1) genuine native fingerprint fidelity, (2) a beautiful fully-custom UI/UX for profile/proxy/team management, and (3) a first-class automation API — as a slick desktop agent + cloud SaaS.

### Our winning strategy — own the engine, own the experience

The deepest, most durable stealth comes from **native, engine-level fingerprinting**. So the moat is **Lobium** — our own patched Chromium build (the Octo model) — and a **fully custom UI/UX** on top. We build both, and we move fast by standing on open source everywhere it helps (open-source project → no license friction).

**One production engine: Lobium.**

1. **Lobium** — our own Chromium-based build with native fingerprint patches (canvas/WebGL/audio/TLS/JA4 +
   configurable profile parameters). This is the moat and the only production browser runtime.
2. **Patchright / Playwright / CDP** — allowed only for internal validation, regression tests, and external
   automation attachment. They are not production stealth layers and never substitute for native Lobium
   fingerprint enforcement.
3. **Uncustomized Chromium** — not a production fallback. If Lobium is missing, the product must fail clearly
   instead of silently launching a weaker browser.

Donut Browser is a **reference only** for orchestrator design — we implement our own Rust+Tauri core (already scaffolded in Day 0).

**Result:** the product ships only when the direct native Lobium path is coherent, tested, and packaged. Any
historical interim-Chromium work remains a harness/reference path, not the product engine.

---

## 1. Product vision & scope (the Octo-class feature set)

The full target — and where each piece lands.

| Capability | v1 (10-day) | Lobium track / beyond |
|---|---|---|
| **Dedicated Chromium-based engine (Lobium)** | Direct native launch path + config channel + dev-proven native patches | Full native param coverage + TLS/JA4 + multi-OS signed builds |
| **Real-system fingerprints** | Coherent profile model + host-calibration scaffold | Lobium presents them natively on real host hardware (no JS tell) |
| **50+ configurable fingerprint parameters** | Full parameter model + editor UI with honest support status | All production params enforced natively by Lobium |
| **Android fingerprints** | Android profile model at config level, kept non-launchable until a mobile runner exists | Android Lobium APK + device runner |
| **Profile export / import / transfer** | JSON/CSV export/import + encrypted transfer package | Cross-account transfer + org migration |
| **Encrypted cloud storage** | AES-encrypted profile blobs in S3; versioned sync | Zero-knowledge / per-team KMS keys |
| **Team roles** | Admin/member roles enforced end-to-end | Granular RBAC (tag-scoped, per-profile perms) |
| **Action logs** | Audit log of profile/team/API actions | Full immutable audit + export |
| **API automation** | Local REST/WS API (Selenium + CDP endpoints) + SDKs | Official SDKs, MCP server, cloud-run |
| **Subscription tiers** | Stripe billing metered on profile count | Higher-scale tiers: seats, API RPM, annual |
| **Fully custom UI/UX** | Our own React/TS design system + flows (not derived from any other product) | Continuous UX polish |
| **Proxy management** | Per-profile HTTP/SOCKS5, test, geo/timezone auto-sync | Proxy marketplace / rotation pools |

**Posture:** v1 is a real, polished, sellable product only when rich, real-system fingerprints run through
the direct native Lobium path. The orchestrator/UI can be built ahead of the native depth, but production
launches do not fall back to uncustomized Chromium.

---

## 2. Architecture

```
┌──────────────────────────────── USER'S MACHINE ────────────────────────────────┐
│  LOBSTER DESKTOP AGENT  (Rust + Tauri, fully custom UI/UX)                       │
│  ┌───────────────┐  ┌──────────────────┐  ┌───────────────┐  ┌───────────────┐ │
│  │  React/TS UI  │  │ Profile Store     │  │ Proxy Manager │  │ Local Auto.   │ │
│  │ (design sys.) │  │ (SQLite, encrypt) │  │ (test+geo)    │  │ API (Axum)    │ │
│  └───────┬───────┘  └────────┬─────────┘  └───────┬───────┘  └───────┬───────┘ │
│          └───────────────────┴─────────┬──────────┴──────────────────┘         │
│                                         │ local JSON-RPC/stdio                  │
│                              ┌──────────▼───────────┐                           │
│                              │  ENGINE RUNNER        │  (Node/TS sidecar)       │
│                              │  • fingerprint gen    │  ← fingerprint-suite     │
│                              │  • direct native     │                           │
│                              │    launch+control    │                           │
│                              └──────────┬───────────┘                           │
│                                         ▼                                       │
│                              ┌─────────────────────┐                            │
│                              │ Lobium ★             │                            │
│                              │ (our own build)      │                            │
│                              │ native config path   │                            │
│                              └─────────────────────┘                            │
└───────────────────────────────────┬─────────────────────────────────────────────┘
                                     │  HTTPS (auth, encrypted profile blobs, billing)
┌────────────────────────────────────▼────────────────────────────────────────────┐
│  LOBSTER CLOUD SaaS  (TypeScript / NestJS)                                         │
│  Auth+JWT · Teams/roles · Encrypted profile blob store (S3) · Sync · Action logs · │
│  Stripe billing/metering · Admin        Postgres · S3-compatible object storage    │
└────────────────────────────────────────────────────────────────────────────────┘
  ★ Lobium is the only production engine. CDP endpoints are exposed for automation/control only.
```

### Control-plane rule
The **Rust desktop core is the single privileged control plane**: it owns the profile store, proxy attach,
auth, and the local automation API, and delegates Lobium launch/control to the Node sidecar over a stable
stdio JSON-RPC contract. The sidecar direct-spawns Lobium, writes `lobium-fp.json`, passes
`--lobium-fp-config`, and returns CDP endpoints strictly for automation/control.

---

## 3. Fixed tech stack (agents: keep to this unless this section is edited)

| Layer | Decision | Rationale |
|---|---|---|
| Desktop shell | **Rust + Tauri 2**, React + TypeScript + Vite, **our own design system** | Small binary; strong system control; fully custom UI/UX (Donut = reference only). |
| Local store | **SQLite** (rusqlite), AES-encrypted blobs | Local profile metadata + cookie/storage cache. |
| Local automation API | **Rust Axum** HTTP+WS on a fixed loopback port | Single privileged control plane; Bearer API-key auth + rate limit. |
| Engine runner (sidecar) | **Node/TS**; direct native Lobium launcher; Patchright retained only as an internal validation harness | JS-first orchestration around a native engine; production fingerprinting stays in Lobium C++ config/patches. |
| **Lobium** | **Chromium fork** via `depot_tools` + GN/ninja; a **quilt/series patch pipeline** (ungoogled model); native fingerprint patches + BoringSSL TLS/JA4 + a per-profile config channel | Our moat: native, tell-free fingerprinting with 50+ params, like Octo. Built on a dedicated build machine/CI (long compiles → ccache/reclient). |
| Fingerprint generation | **Lobster's own internal coherent device catalog** (`packages/fingerprint/pools.ts`): curated device classes, seed-based + deterministic | We OWN the fingerprint model — no third-party generation API (a shared statistical distribution is itself a tell) and no random field-mixing; a seed picks one coherent machine (GPU+screen+cores+memory bundled). Proxy geo is applied as an overlay on top. Lobium enforces the values natively. |
| Proxy tooling | Per-profile HTTP/SOCKS5; **mitmproxy** for header/geo canonicalization | Timezone/locale/Accept-Language derived from exit IP. |
| Backend | **TypeScript + NestJS**, Postgres (Prisma), S3-compatible storage | Fast CRUD; shared types with front; Stripe SDK. |
| Billing | **Stripe** | Tiered, metered on profile count. |
| CI/CD | **GitHub Actions**: build/lint/typecheck/test + **fingerprint validation gate**; separate Lobium build pipeline | See §7–§8. |

**Languages: Rust + TypeScript** (Lobium itself is C++/GN Chromium). Each has one clear role behind documented contracts so both agents build in parallel without collisions.

---

## 4. Product pillars (v1 feature spec)

### Pillar 1 — Profiles & Fingerprints (crown jewel, P0)
- Profile CRUD + **clone** + **bulk-create** + **import/export/transfer** (JSON/CSV + encrypted transfer package) with tags/folders.
- **Real-system fingerprints**: values sourced from real-device datasets; per-profile **seed** → deterministic, **coherent, stable** fingerprint persisted with the profile.
- **50+ configurable parameters** exposed in a **fully custom fingerprint editor UI** (navigator/UA-CH, screen, WebGL, fonts, hardware, locale/timezone, audio, WebRTC policy, and more).
- **Android fingerprint profiles** (mobile UA, touch, screen, GPU, deviceMemory), gated behind the
  Android Lobium APK/device-runner track.
- Per-profile **persistent user-data-dir**; cookie/localStorage/session persistence; **single-active-instance locking**.
- Engine is **Lobium** for every production profile. UI may expose engine build/version/status, but not a
  weaker engine choice.

### Pillar 2 — Proxy Management (P0)
- Per-profile **HTTP/SOCKS5 (+auth)**; proxy **test / IP-check**.
- **Auto-derive & apply** timezone, locale, `navigator.languages`, `Accept-Language`, geolocation **from the proxy exit IP** — the top coherence rule.
- **WebRTC leak protection** (ICE public IP == proxy IP): native/policy-controlled in Lobium, with launch
  flags as defense-in-depth.

### Pillar 3 — Local Automation API (P0)
- Loopback REST+WS daemon on a fixed port, **Bearer API-key auth**, per-endpoint rate limits.
- `start` / `stop` / `list` / `status` + profile CRUD (AdsPower/Octo-compatible contract).
- `start` returns **both** a Selenium `debuggerAddress` **and** a Playwright/Puppeteer CDP `ws://`, in a `{code,data,msg}` envelope.
- SDK examples (Python + JS) + connect recipes.

### Pillar 4 — Cloud SaaS: Auth · Sync · Teams · Logs · Billing (P0/P1)
- Account auth (email + password/OTP, JWT); desktop ↔ cloud.
- **Encrypted cloud storage**: AES-encrypted profile blobs (cookies/storage/seed) in S3; versioned push/pull with conflict handling.
- **Team roles**: invite members; share profiles; **admin/member** enforced end-to-end.
- **Action logs**: audit trail of profile/team/API actions.
- **Subscription tiers** via **Stripe**, metered on profile count; API-key management UI.

### Pillar 5 — Lobium (flagship engine, parallel track — see §10 Track F)
- Own Chromium build with a quilt patch series; native control of **all** deep surfaces (canvas/WebGL/audio/fonts/WebRTC) + **BoringSSL TLS/JA3/JA4 + HTTP/2** matching.
- A **per-profile fingerprint config channel** so the orchestrator injects all 50+ params natively (no JS tell).
- v1 milestone: direct Lobium launch path, native config channel, and enough native coverage/proof that no
  production profile depends on Patchright/CDP spoofing.

### Pillar 6 — QA / Anti-Detect Validation (P0, cross-cutting)
- Self-hosted detector suite as an **objective CI gate**: **CreepJS**, **Pixelscan**, **Sannysoft**, **Iphey**, **browserleaks**, **FingerprintJS** — plus WebRTC-leak and coherence checks. Regressions fail the build.

---

## 5. Fingerprint engine spec — real-system, 50+ params, native-by-Lobium

**Governing principle:** *coherence beats coverage.* Every surface describes one plausible **real** machine,
drawn from real-device datasets and, for production, calibrated from the user's real host where appropriate.
The fingerprint is **stable per profile** and enforced by **Lobium natively**. CDP helpers are internal
test/control mechanisms only, not a production spoofing layer.

**Method legend:** `native` (Lobium, our build) · `control-CDP` (automation/control or internal validation,
not production fingerprint spoofing) · `network` (proxy/header layer) · `real-value` (host-calibrated value).

| Surface (50+ params grouped) | Method | Priority |
|---|---|---|
| TLS JA3/JA4 + HTTP/2 SETTINGS/header order + TCP/IP OS FP | `native` (Lobium BoringSSL/net) | **P0** |
| Canvas 2D toDataURL/getImageData + text metrics | `native` farbling (seeded, Lobium) | **P0** |
| WebGL/WebGL2 vendor/renderer/params/extensions + pixel hash | `native` (Lobium, host-calibrated on real GPU) | **P0** |
| AudioContext DSP hash + sampleRate/baseLatency | `native` (Lobium) | **P0/P1** |
| WebRTC IP behind proxy (no leak) | `native` (Lobium)/`network` | **P0** |
| navigator/UA/UA-CH/Sec-CH-UA (platform, mobile, version, GREASE) | `native` (Lobium) + `network` headers | **P0** |
| Timezone/locale/languages/Accept-Language/geolocation (from proxy IP) | `native` (Lobium) + `network` headers | **P0** |
| Fonts enumeration + metrics matched to OS | `native` (Lobium) | **P1** |
| screen/window/DPR/matchMedia/color depth | `native` (Lobium) | **P1** |
| hardwareConcurrency/deviceMemory/maxTouchPoints/platform | `native` (Lobium) | **P1** |
| Android set (mobile UA, touch, mobile GPU, orientation) | `native` (Android Lobium APK/device runner) · modeled only until runner exists | **P1** |
| WebGPU adapter/limits/features | `native` (Lobium) | **P2** |
| Battery/Sensors/speech voices/codecs/permissions shape | `native` (Lobium) | **P2** |
| Human-like input (mouse non-linearity, timing) | automation-layer | **P1** |

### Rules (both agents)
1. **All production fingerprint surfaces go native.** Deep surfaces and ordinary navigator/locale/screen
   values are consumed from Lobium's config channel or host calibration, not from Patchright/JS injection.
2. **CDP is control/debug only.** It may connect automation clients, collect validation evidence, import
   cookies through a clearly separated control path, or run internal tests. It must not be the product's
   fingerprint spoofing mechanism.
3. Fingerprints are **seeded, stable per profile**, sourced from **real-device data**, and **coherent** across every surface.
4. Deep-surface reads are **stable within a session** (no per-call noise variance).
5. The **50+ params** share one config model (`@lobster/shared-types`) consumed identically by the editor UI, the sidecar, and the Lobium config channel.

---

## 6. Anti-bot coherence bar (what we validate in CI)
- **One device story:** UA ↔ OS ↔ WebGL ↔ canvas ↔ screen/DPR ↔ hardware all describe one plausible real machine.
- **Geo cluster:** timezone + locale + languages + Accept-Language + geolocation all match the **proxy exit IP**.
- **Version alignment:** engine version matches the UA-claimed version.
- **Coherent network story:** TLS/HTTP2 matches the claimed Lobium/Chrome-family build.
- **No WebRTC/DNS leak; artifact-free control CDP** (automation endpoints must not create detectable
  page artifacts).
- **CI gate:** CreepJS trust / Pixelscan "consistent" / Sannysoft pass, as an objective threshold.

---

## 7. Agent operating model & rules

### 7.1 Roles
- **Claude — Lead Architect / Integrator / Reviewer.** Owns this plan, specs/ADRs, the Rust desktop core, the fingerprint-coherence model, security-sensitive code, the **Lobium** build+patch pipeline, engine integration, and the validation harness. **Blocking** review authority on P0/security/engine/Lobium PRs.
- **OpenAI Codex — Primary Implementer.** React/TS UI + design system, NestJS CRUD + data models, proxy utilities, local-API handlers, SDK examples, tests, docs.
- Both write tests; every PR is cross-reviewed by the other agent.

### 7.2 Unit of work = a Ticket
`docs/tickets/T-XXX-*.md`: **goal · spec · files · acceptance · tests · assignee · pillar**. No code without a ticket. No ticket spans >1 pillar.

### 7.3 Git
Trunk-based, one PR per ticket, squash merge, Conventional Commits + co-author trailer. Small PRs.

### 7.4 Definition of Done (ALL hold)
1. Meets acceptance criteria. 2. Tests written + green. 3. `typecheck`/`lint`/`build` green for affected packages (`cargo fmt`/`clippy` for desktop; Lobium builds via its pipeline). 4. Fingerprint-surface/engine work: **validation gate green**. 5. Cross-reviewed + approved (Claude blocking on P0/security/engine/Lobium). 6. No secrets committed.

### 7.5 Working rules
- **Import freely.** The project is open source — fork/import/adapt any OSS that helps
  (fingerprint-suite, Chromium tooling, mitmproxy, Patchright for tests, and reference from Donut/others).
  Keep attribution files.
- **Own Lobium & the UI.** The engine is our **own Lobium** build (Donut = reference only); the UI/UX is our **own design system**.
- **Production fingerprinting is native Lobium.** Keep CDP artifact-free and out of the stealth layer.
- Fingerprints: **real-system, per-profile stable, coherent, proxy-geo-derived**.
- **No secrets in the repo.** **Report faithfully** — green gates over assertions.
- **Protect the product bar.** A profile that cannot launch through Lobium must fail clearly rather than
  silently downgrading to an uncustomized engine.

### 7.6 Handoff
`ticket · what changed · files · how verified (tests + gate) · follow-ups` → reviewer replies `APPROVE` or blocking comments.

---

## 8. Repository structure & CI gates

```
/apps
  /desktop            # Rust + Tauri core + React/TS custom UI + Axum local API
  /backend            # NestJS cloud SaaS (auth, teams, sync, logs, billing)
/packages
  /engine-runner      # Node/TS sidecar: direct native Lobium launch/control
  /fingerprint        # seed→coherent fp, 50+ param model, real-device data, coherence rules
  /proxy              # proxy test, exit-IP geo derivation
  /shared-types       # shared types incl. the 50+ param fingerprint config model
  /local-api-sdk      # JS + Python API clients
/lobium               # Lobium: build scripts, GN args, quilt patch series, config channel
/engines              # legacy/download helpers; production ships Lobium resources, binaries NOT committed
/docs                 # this plan, ADRs, contracts, tickets, agent protocol
/ci                   # fingerprint validation harness
/tests                # e2e / integration / detector validation
```

**CI gates (block merge):** build/lint/typecheck/unit tests · integration (launch → connect via local API) · **fingerprint validation gate** · secret scan (gitleaks). The **Lobium build** runs in its own long-running pipeline (not on every PR).

---

## 9. Success factors — how we win

| # | Focus | How we win |
|---|---|---|
| S1 | **Lobium is the moat** | Build our own Chromium engine (Lobium) with native fingerprinting + TLS/JA4; start now, bring it online progressively as the flagship engine. |
| S2 | **No weak fallback** | Product launches either use Lobium or fail with a clear provisioning error; tests may use harness engines. |
| S3 | **Real-system realism** | Drive fingerprints from real-device datasets; 50+ coherent params; stable per profile. |
| S4 | **Always-passing quality bar** | Detector matrix wired into CI as an objective gate from day one. |
| S5 | **Own experience** | Fully custom UI/UX design system — a distinctive, polished product, not a clone. |
| S6 | **Clean automation** | CDP/WebDriver endpoints are exposed for user automation/control without becoming the fingerprint layer. |
| S7 | **Solid data foundation** | Encrypted profile blobs at rest + in transit; versioned sync; action logs; single-instance isolation. |

---

## 10. The plan (parallel tracks + milestones)

> **Live execution status is tracked in [`PROJECT-STATUS.md`](PROJECT-STATUS.md)**, not in this
> day-numbered plan. The Day 0–10 schedule below is the original strategy; the actual state (native Lobium
> launch path wired, major native surfaces dev-proven, real-GPU/host-calibration still open) is in
> PROJECT-STATUS. Update PROJECT-STATUS as work moves.

`[C]` Claude · `[X]` Codex · `[C+X]` paired. Claude reviews all P0/engine/Lobium PRs.
**Track A** Desktop Core · **Track B** Engine runner & Fingerprint · **Track C** Backend/SaaS · **Track D** Automation API + SDK · **Track E** QA/Validation · **Track F** Lobium (parallel, longer horizon).

### Day 0 — Foundations `[C]` ✅ done
Repo, npm workspaces, foundational packages (`shared-types`, `fingerprint`, `proxy`, `engine-runner`), app scaffolds, CI skeleton, docs/ADRs/agent-protocol, engine download scripts, validation stub. Verified: core packages build; fingerprint engine deterministic + coherent.

### Day 1
- A `[X]`: Tauri shell boots; custom UI shell + design-system foundation.
- B `[C+X]`: sidecar IPC live; internal coherent device catalog behind `deriveFingerprint` (no third-party API); expand to the 50+ param model.
- C `[X]`: NestJS + Prisma migrate (User/Team/Profile/ApiKey/Subscription).
- E `[C]`: host CreepJS/Sannysoft + score scraper.
- **F `[C]`: stand up the Lobium build environment (depot_tools, fetch Chromium), kick off the first Linux build.**

### Day 2
- B `[C]`: historical: first live launch harness. Current production path is direct native Lobium.
- A `[X]`: profile CRUD + single-instance lock; fingerprint editor UI (first params).
- C `[X]`: JWT auth + accounts.
- **F `[C]`: first Chromium build succeeds; init the quilt patch series.**

### Day 3
- B `[C]`: historical: CDP harness hardening. Current rule: Lobium consumes fingerprint config natively.
- Proxy `[X]`: per-profile HTTP/SOCKS5 + test + geo/timezone auto-sync.
- A `[X]`: profile UI (create/clone/list/delete, tags/folders); Android fingerprint profile model.
- C `[X]`: teams + roles; encrypted blob storage (S3).
- **F `[C]`: first native patch builds (navigator/UA-CH); design the per-profile config channel.**

### Day 4
- D `[C]`: local automation API (start/stop/list/status → debuggerAddress + CDP ws) + Bearer auth.
- A `[X]`: cookie + profile import/export/transfer.
- C `[X]`: cloud sync (push/pull encrypted blob + versioning); action-log skeleton.
- E `[C]`: fingerprint validation gate in CI.

### Day 5 — mid-sprint integration `[C+X]`
- Full E2E: create → launch → proxy → pass validation → connect Playwright.
- WebRTC leak check; bulk create; export/import/transfer.
- C `[X]`: Stripe tiers + metering.
- **F `[C]`: wire one fingerprint param end-to-end through the Lobium config channel (POC).**

### Day 6
- C `[X]`: share profiles; roles enforced; action logs; API-key UI.
- D `[X]`: SDK examples + connect docs.
- A `[C]`: 50+ param editor coverage + profile status/lock robustness.

### Day 7 — stealth polish
- E `[C]`: full detector matrix; tighten coherence across all params + mobile.
- **F `[C]`: canvas/WebGL farbling patch prototype in Lobium.**

### Day 8 — packaging
- A `[C+X]`: desktop installer (Windows first; macOS if time); bundle sidecar; engine download-on-first-run; signing setup.
- Security pass; C `[X]`: backend to staging.

### Day 9 — QA & docs
- E `[C+X]`: full E2E QA + real anti-bot targets; bug bash; perf. Docs (user/API/SDK/admin). Feature freeze.

### Day 10 — launch candidate `[C]`
- Installer + staging backend; demo script; **Lobium status + roadmap**. Acceptance vs §7.4 + §4. Retro.

### Track F beyond Day 10 — Lobium to flagship
Full native coverage of all configurable params, TLS/JA3/JA4 + HTTP/2 matching, audio/WebGPU, multi-OS
signed builds (Win/mac-Intel/mac-ARM/Linux), continuous upstream-rebase automation, and blocking real-GPU
validation.

---

## 11. Roadmap beyond v1

1. **Lobium to production**: complete native param enforcement, BoringSSL TLS/JA4 + HTTP/2,
   canvas/WebGL/audio/WebGPU farbling across frames/workers/OffscreenCanvas, and direct-launch product E2E.
2. **Multi-OS signed Lobium builds** + notarization + auto-update; continuous Chrome-stable rebase.
3. **Android Lobium / device runner** for true Android fingerprints. Emulators are smoke-only;
   production proof requires physical Android devices.
4. **Granular RBAC** (tag-scoped, per-profile perms) + full immutable audit.
5. **Cloud-run profiles** (browser in the cloud), simultaneous-launch metering, cloud phones.
6. Proxy marketplace / rotation; official SDKs (Py/JS/C#); **MCP server**; disposable profiles; cookie collector / warm-up; human-like input library; higher-scale billing (seats, API RPM, annual).

---

## 12. Decisions to confirm (defaults chosen; override anytime)
1. **Lobium base** — default: fork Chromium via depot_tools with an ungoogled-style quilt patch series. (Alt: patch on top of ungoogled-chromium directly.)
2. **Lobium build infra** — needs a dedicated build machine/CI (large, long compiles). Confirm where it runs (self-hosted runner / cloud build).
3. **Proxy sourcing** — default bring-your-own in v1; reseller later.
4. **Target OS priority** — Windows first, macOS second, Linux for headless/Lobium builds.

---

## 13. Verification — how we prove it works (end-to-end)
1. **Fingerprint fidelity:** a native Lobium profile behind a residential proxy → CreepJS trust high/no
   lies, Pixelscan "consistent", Sannysoft all-pass, no WebRTC leak, timezone/locale match proxy geo.
2. **Coherence & params:** UA ↔ UA-CH ↔ platform ↔ WebGL ↔ fonts ↔ screen agree; all 50+ params round-trip UI → sidecar → engine.
3. **Automation:** `POST /start` → Playwright `connectOverCDP` + Selenium `debuggerAddress` drive the same profile → `POST /stop`.
4. **Persistence/isolation:** cookies survive restart; profiles never share state; single-instance lock holds.
5. **SaaS:** sign up → create/sync profile → invite teammate → shared profile opens → action logs recorded → Stripe tier gates profile count.
6. **Lobium config proof:** a Lobium build launches directly and honors the configured native fingerprint
   surfaces without Patchright/JS spoofing.
7. **Packaging:** clean install on a fresh Windows machine → engine download → launch works.

**v1 is accepted** when 1–7 pass and every §4 pillar has a working end-to-end path through direct native
Lobium.

---

## 14. Detailed specifications (`docs/specs/`)

This plan is deliberately the strategy and shape. The **production-depth detail** — every parameter,
every table, every endpoint, every patch — lives in [`docs/specs/`](specs/) so ticket bodies stay short
and both agents build to one reference. Each spec is written to the full Octo-class target and tags each
item **done · partial · planned** against today's code, closing with a *Status vs target* note. Index:
[`docs/specs/README.md`](specs/README.md).

| Spec | What it locks down |
|---|---|
| [`specs/feature-catalog.md`](specs/feature-catalog.md) | Every feature (11 areas + Lobium) with priority + competitor-parity + status; billing plan/tier matrix; screen inventory + key flows; the phased Phase 1→2→3 roadmap |
| [`specs/product-ui-ux-plan.md`](specs/product-ui-ux-plan.md) | 2026-07-07 product UI declaration: light/red shell, header logo, Profiles/Proxies/Templates/Pricing IA, create-profile wizard, proxy/template/pricing screens, OS/mobile policy, and data/engine implications |
| [`specs/fingerprint-parameters.md`](specs/fingerprint-parameters.md) | The **~90-param** catalog (18 surfaces) — the concrete "50+"; the 29-rule coherence engine; seed→native-config pipeline; the editor UI grouping |
| [`specs/data-model.md`](specs/data-model.md) | Cloud Postgres schema (6 built + 9 planned tables, DDL-level) + local SQLite; encryption boundaries; data lifecycle (retention/export/erasure); migration strategy |
| [`specs/api-reference.md`](specs/api-reference.md) | Local automation API + cloud REST API (per-endpoint schemas, error codes, connect recipes) + webhooks + SDKs + MCP server + versioning policy |
| [`specs/security.md`](specs/security.md) | 3-tier key hierarchy + AES-GCM blob envelope + zero-knowledge; auth upgrade path (refresh rotation, 2FA, SSO, API-key scoping); RBAC matrix; threat model; supply-chain |
| [`specs/lobium-build.md`](specs/lobium-build.md) | Build pipeline (toolchain/pinned-ref/rebase); the ordered native **patch series** (incl. TLS/JA4 + HTTP/2); the config-channel wire protocol; multi-OS signing + auto-update; Android variant |
| [`specs/android.md`](specs/android.md) | Android-only mobile engine track after the iOS drop: APK build, device bridge, mobile fingerprint family, config channel, device validation matrix, and AND-0..AND-9 roadmap |
| [`specs/proxy.md`](specs/proxy.md) | Proxy type matrix; chaining + rotation + pools; providers; testing + IP-quality; geo-coherence pipeline; leak protection; the SOCKS-in-launcher fix |
| [`specs/qa-testing.md`](specs/qa-testing.md) | 7-layer testing pyramid; detector matrix + `thresholds.json` schema; live anti-bot testing; the coherence validator rule set; **the NFR / SLO targets** (source for §15); release-gate → CI mapping |
| [`specs/observability-ops.md`](specs/observability-ops.md) | Logging/metrics/tracing/error-tracking; backend deployment; backups/DR; rate limiting + queues; desktop signing + auto-update; release process; monitoring/alerting; billing ops |

---

## 15. Non-functional requirements & SLO targets

The quality bar the product is held to, beyond features. Full detail + how each is measured is in
[`specs/qa-testing.md`](specs/qa-testing.md) §6–§7 and [`specs/observability-ops.md`](specs/observability-ops.md).

| Dimension | Target (v1 → mature) |
|---|---|
| **Profile launch time** | ≤ 3s p50, ≤ 6s p95 (cold engine cache excluded) |
| **Local density** | ≥ 25 concurrent profiles on a 16 GB machine; ≤ 250 MB desktop idle RSS |
| **Local automation API latency** | `start` ≤ 3s p95; `status`/`list` ≤ 50ms p95 |
| **Cloud API latency** | ≤ 200ms p95 for CRUD; sync push/pull ≤ 1s p95 for a typical profile blob |
| **Cloud availability** | 99.9% monthly uptime (SLO) with an error-budget + burn-rate policy |
| **Durability / DR** | Postgres PITR; **RPO ≤ 5 min, RTO ≤ 1 h**; quarterly restore drills; versioned + replicated blob store |
| **Anti-detect quality** | Sannysoft all-pass; CreepJS "trust" high / no lies; Pixelscan "consistent"; no WebRTC/DNS leak — enforced as a **blocking CI gate** |
| **Coherence** | 100% of the coherence validator rules pass for every generated profile |
| **Security** | Zero-knowledge profile blobs (server never sees plaintext); no secrets in repo (gitleaks gate); JWT hard-fail in prod; dependency + secret scans green |
| **Scale (cloud)** | Horizontal stateless backend behind autoscaling; per-key + per-IP rate limits; async queues for sync/metering/webhooks |

These are **acceptance-relevant**: fingerprint quality, coherence, security, and the launch/latency
budgets are gated in CI or the validation harness; the availability/DR/scale targets govern the cloud
deployment (Phase-graded — see §16).

---

## 16. Risk & gap register

An honest, prioritized view of the distance to a *perfect* product. This is the condensed register;
the narrative is in [`docs/GAP-ANALYSIS.md`](GAP-ANALYSIS.md), and each *planned* line is enumerated in
the spec named. **G-priority:** G0 = blocks Octo-class parity · G1 = needed for a complete v1 · G2 = depth/scale.

| # | Gap (today's reality) | Impact | Mitigation / where specified | G |
|---|---|---|---|---|
| R1 | **Lobium production proof incomplete** — dev build exists, but real-GPU CI, host calibration, multi-OS signed builds, and full native consumption remain open | The core moat + hardest-target stealth | Track F + RG/HC tasks → [`specs/lobium-build.md`](specs/lobium-build.md), [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md) | G0 |
| R2 | **Fingerprint breadth** — many cataloged fields are modeled/UI-visible before native Lobium consumes them | Detector coherence on strict targets | Full param model + native enforcement → [`specs/fingerprint-parameters.md`](specs/fingerprint-parameters.md), T-012 | G1 |
| R3 | **Security depth** — client-side crypto, key hierarchy, 2FA, SSO, session/device mgmt, API-key hashing not yet built | Enterprise trust; true zero-knowledge | Key hierarchy + auth upgrade path → [`specs/security.md`](specs/security.md); proxy-credential plaintext gap flagged in [`specs/data-model.md`](specs/data-model.md) | G1 |
| R4 | **Proxy depth** — SOCKS5-in-launcher, chaining, rotation, providers, leak-suite not built; geo-sync not live-tested | Real-world proxy coverage + no leaks | Type matrix + SOCKS fix + leak suite → [`specs/proxy.md`](specs/proxy.md), T-014 follow-up | G1 |
| R5 | **Cloud runtime unexercised** — Postgres path wired but unrun; billing metering minimal; RBAC coarse (admin/member) | Revenue + team/enterprise readiness | Data model + billing ops + RBAC matrix → [`specs/data-model.md`](specs/data-model.md), [`specs/security.md`](specs/security.md), [`specs/observability-ops.md`](specs/observability-ops.md) | G1 |
| R6 | **Desktop lifecycle** — no packaging/signing/notarization/auto-update/onboarding/i18n | Shippable installed product | Delivery + signing + updater → [`specs/observability-ops.md`](specs/observability-ops.md) §5 | G1 |
| R7 | **Observability / ops / deploy** — no logging/metrics/tracing/error-tracking/deploy pipeline/backups | Operable, reliable SaaS | Full stack → [`specs/observability-ops.md`](specs/observability-ops.md) | G1 |
| R8 | **Testing breadth** — strong unit/integration + one detector (Sannysoft); no CreepJS/live-anti-bot/load/perf/security tests | Confidence the quality bar holds | 7-layer pyramid + detector matrix + NFRs → [`specs/qa-testing.md`](specs/qa-testing.md) | G1 |
| R9 | **Browser data breadth** — cookies done; localStorage/IndexedDB, extensions, bookmarks, history, autofill not | Profile realism + parity | Enumerated in [`specs/feature-catalog.md`](specs/feature-catalog.md) §2 | G2 |
| R10 | **Android fingerprints** — catalog/coherence exists, launch path not started | Android multi-accounting segment | Android Lobium APK/device runner → [`specs/android.md`](specs/android.md), [`specs/lobium-build.md`](specs/lobium-build.md) §8 | G2 |
| R11 | **Automation breadth** — local API done; official SDKs (Py/JS/C#), MCP, cloud-run, human-like input not | Developer + enterprise reach | SDK + MCP surface → [`specs/api-reference.md`](specs/api-reference.md) §4–§5 | G2 |

**Priority read:** **R1 (Lobium production proof)** is the one true moat and the largest single effort.
**R2–R8 (G1)** are the complete product surface around that engine. **R9–R11 (G2)** are depth/scale for
later phases. This register is the backlog source for new tickets and is superseded in day-to-day work by
[`PROJECT-STATUS.md`](PROJECT-STATUS.md) and [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md).
