# MASTER PLAN — Lobster Browser (Anti-Detect Browser & SaaS)

> **Product & project name:** **Lobster Browser**
> **Owner:** dkangevworld.wang1@gmail.com
> **Builders:** Claude (lead architect / integrator / reviewer) + OpenAI Codex (primary implementer). All engineering, coding, and review is done by these agents.
> **License posture:** Lobster ships **open source**, so we **freely fork, import, and adapt** any open-source code (any license). Donut Browser and other projects are used as **reference/inspiration only** — we own our full codebase. Legal & licensing are maintained by the owner separately.
> **Timeline:** a complete, demoable product **v1 in 10 days** on our orchestrated engines, with the **dedicated Lobster Chromium kernel** built on a parallel track that matures into the flagship engine.
> **Status of this doc:** authoritative — the single source of truth for both agents. Any change to scope, stack, or the working rules is edited here first.

---

## 0. Context — what we're building and why

We are building **Lobster Browser**: a **production-grade anti-detect browser + SaaS**, feature-comparable to **Octo Browser** and its peers (Multilogin, AdsPower, GoLogin, Dolphin{anty}, Kameleo). Managing many isolated, real-looking browser identities for affiliate marketing, e-commerce multi-accounting, ad verification, market research, web QA/automation, and privacy.

Each **profile** gets a **coherent, stable, real-system-based device + network identity** (fingerprint), fully isolated from every other profile and consistent enough to sail through modern anti-bot systems (Cloudflare, DataDome, Akamai, HUMAN/PerimeterX, Kasada). Our value: (1) genuine native fingerprint fidelity, (2) a beautiful fully-custom UI/UX for profile/proxy/team management, and (3) a first-class automation API — as a slick desktop agent + cloud SaaS.

### Our winning strategy — own the kernel, own the experience

The deepest, most durable stealth comes from **native, engine-level fingerprinting**. So the moat is a **dedicated Lobster Chromium kernel** — our own patched Chromium build (the Octo model) — and a **fully custom UI/UX** on top. We build both, and we move fast by standing on open source everywhere it helps (open-source project → no license friction).

**Three engines, one product:**
1. **Lobster Kernel (flagship)** — our own Chromium-based build with native fingerprint patches (canvas/WebGL/audio/TLS/JA4 + 50+ configurable parameters). This is the moat. It's a multi-week build+patch effort, so it runs on a **parallel track** starting now and progressively becomes the default engine.
2. **Chromium (default, interim)** — prebuilt ungoogled-chromium driven by patchright for the broad Chrome-family footprint, so the product is fully usable from day one while the kernel matures.
3. **Camoufox (High-Stealth)** — a genuine native-patched engine for the hardest targets in the interim.

Donut Browser is a **reference only** for orchestrator design — we implement our own Rust+Tauri core (already scaffolded in Day 0).

**Result:** a complete, usable product in 10 days on engines (2) + (3) with a fully custom UI and rich fingerprinting; the Lobster Kernel then takes over as the flagship, delivering Octo-class native stealth.

---

## 1. Product vision & scope (the Octo-class feature set)

The full target — and where each piece lands.

| Capability | v1 (10-day) | Kernel track / beyond |
|---|---|---|
| **Dedicated Chromium-based kernel** | Build pipeline + first native patches + per-profile config channel (POC) | Full native 50+ param coverage + TLS/JA4 + multi-OS, becomes default engine |
| **Real-system fingerprints** | Real-device datasets drive generated profiles; coherent + stable per profile | Kernel presents them natively (no JS tell) |
| **50+ configurable fingerprint parameters** | Full parameter model + editor UI over safe/interim surfaces | All params enforced natively by the kernel |
| **Android / mobile fingerprints** | Mobile fingerprint profiles (UA/screen/touch/GPU/deviceMemory) at config level | Mobile kernel variant / device emulation |
| **Profile export / import / transfer** | JSON/CSV export/import + encrypted transfer package | Cross-account transfer + org migration |
| **Encrypted cloud storage** | AES-encrypted profile blobs in S3; versioned sync | Zero-knowledge / per-team KMS keys |
| **Team roles** | Admin/member roles enforced end-to-end | Granular RBAC (tag-scoped, per-profile perms) |
| **Action logs** | Audit log of profile/team/API actions | Full immutable audit + export |
| **API automation** | Local REST/WS API (Selenium + CDP endpoints) + SDKs | Official SDKs, MCP server, cloud-run |
| **Subscription tiers** | Stripe billing metered on profile count | Higher-scale tiers: seats, API RPM, annual |
| **Fully custom UI/UX** | Our own React/TS design system + flows (not derived from any other product) | Continuous UX polish |
| **Proxy management** | Per-profile HTTP/SOCKS5, test, geo/timezone auto-sync | Proxy marketplace / rotation pools |

**Posture:** v1 is a real, polished, sellable product with a fully custom interface and rich, real-system fingerprints running on the orchestrated engines; the Lobster Kernel is the flagship engine we bring online to reach full Octo-class native depth.

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
│                              │  • launch+control     │  ← patchright/camoufox   │
│                              └──┬───────────┬────────┴──┬────────────────────┐  │
│                    ┌────────────▼┐   ┌──────▼──────┐  ┌─▼──────────────────┐ │  │
│                    │ Lobster      │   │ Camoufox    │  │ ungoogled-Chromium │ │  │
│                    │ KERNEL ★     │   │(High-Stealth)│  │ (default, interim) │ │  │
│                    │ (our build)  │   └─────────────┘  └────────────────────┘ │  │
│                    └──────────────┘                                            │  │
└───────────────────────────────────┬─────────────────────────────────────────────┘
                                     │  HTTPS (auth, encrypted profile blobs, billing)
┌────────────────────────────────────▼────────────────────────────────────────────┐
│  LOBSTER CLOUD SaaS  (TypeScript / NestJS)                                         │
│  Auth+JWT · Teams/roles · Encrypted profile blob store (S3) · Sync · Action logs · │
│  Stripe billing/metering · Admin        Postgres · S3-compatible object storage    │
└────────────────────────────────────────────────────────────────────────────────┘
   ★ Lobster Kernel is built on a parallel track (see §10 Track F) and becomes the default engine as its native patches land.
```

### Control-plane rule
The **Rust desktop core is the single privileged control plane**: it owns the profile store, proxy attach, auth, and the local automation API, and delegates engine launch/control to the Node sidecar over a stable stdio JSON-RPC contract. The sidecar drives whichever engine a profile selects — **Lobster Kernel**, Camoufox, or Chromium — behind one interface, so the kernel drops in transparently as it matures.

---

## 3. Fixed tech stack (agents: keep to this unless this section is edited)

| Layer | Decision | Rationale |
|---|---|---|
| Desktop shell | **Rust + Tauri 2**, React + TypeScript + Vite, **our own design system** | Small binary; strong system control; fully custom UI/UX (Donut = reference only). |
| Local store | **SQLite** (rusqlite), AES-encrypted blobs | Local profile metadata + cookie/storage cache. |
| Local automation API | **Rust Axum** HTTP+WS on a fixed loopback port | Single privileged control plane; Bearer API-key auth + rate limit. |
| Engine runner (sidecar) | **Node/TS**; patchright (Chromium/Kernel) + camoufox-js (Camoufox); Playwright base | JS-first velocity; patchright keeps CDP clean. Python fallback for Camoufox behind the same IPC. |
| **Lobster Kernel** | **Chromium fork** via `depot_tools` + GN/ninja; a **quilt/series patch pipeline** (ungoogled model); native fingerprint patches + BoringSSL TLS/JA4 + a per-profile config channel | Our moat: native, tell-free fingerprinting with 50+ params, like Octo. Built on a dedicated build machine/CI (long compiles → ccache/reclient). |
| Fingerprint generation | **Apify fingerprint-suite** + **real-device datasets** (real-system fingerprints) | Statistically-real, internally-coherent values from real devices; the kernel enforces them natively. |
| Interim engines (pinned) | **Camoufox** (High-Stealth) + **ungoogled-chromium** (default) | Full stealth + broad coverage while the kernel matures. |
| Proxy tooling | Per-profile HTTP/SOCKS5; **mitmproxy** for header/geo canonicalization | Timezone/locale/Accept-Language derived from exit IP. |
| Backend | **TypeScript + NestJS**, Postgres (Prisma), S3-compatible storage | Fast CRUD; shared types with front; Stripe SDK. |
| Billing | **Stripe** | Tiered, metered on profile count. |
| CI/CD | **GitHub Actions**: build/lint/typecheck/test + **fingerprint validation gate**; separate kernel build pipeline | See §7–§8. |

**Languages: Rust + TypeScript** (Python only as a Camoufox fallback; the kernel is C++/GN Chromium). Each has one clear role behind documented contracts so both agents build in parallel without collisions.

---

## 4. Product pillars (v1 feature spec)

### Pillar 1 — Profiles & Fingerprints (crown jewel, P0)
- Profile CRUD + **clone** + **bulk-create** + **import/export/transfer** (JSON/CSV + encrypted transfer package) with tags/folders.
- **Real-system fingerprints**: values sourced from real-device datasets; per-profile **seed** → deterministic, **coherent, stable** fingerprint persisted with the profile.
- **50+ configurable parameters** exposed in a **fully custom fingerprint editor UI** (navigator/UA-CH, screen, WebGL, fonts, hardware, locale/timezone, audio, WebRTC policy, and more).
- **Android / mobile fingerprint profiles** (mobile UA, touch, screen, GPU, deviceMemory).
- Per-profile **persistent user-data-dir**; cookie/localStorage/session persistence; **single-active-instance locking**.
- Engine selectable per profile: **Lobster Kernel** (as it comes online) / **Chromium** (default) / **Camoufox** (High-Stealth).

### Pillar 2 — Proxy Management (P0)
- Per-profile **HTTP/SOCKS5 (+auth)**; proxy **test / IP-check**.
- **Auto-derive & apply** timezone, locale, `navigator.languages`, `Accept-Language`, geolocation **from the proxy exit IP** — the top coherence rule.
- **WebRTC leak protection** (ICE public IP == proxy IP): native in Camoufox/Kernel; policy on Chromium.

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

### Pillar 5 — Lobster Kernel (flagship engine, parallel track — see §10 Track F)
- Own Chromium build with a quilt patch series; native control of **all** deep surfaces (canvas/WebGL/audio/fonts/WebRTC) + **BoringSSL TLS/JA3/JA4 + HTTP/2** matching.
- A **per-profile fingerprint config channel** so the orchestrator injects all 50+ params natively (no JS tell).
- v1 milestone: build pipeline + first patches + config channel POC; then progressive native coverage until it's the default engine.

### Pillar 6 — QA / Anti-Detect Validation (P0, cross-cutting)
- Self-hosted detector suite as an **objective CI gate**: **CreepJS**, **Pixelscan**, **Sannysoft**, **Iphey**, **browserleaks**, **FingerprintJS** — plus WebRTC-leak and coherence checks. Regressions fail the build.

---

## 5. Fingerprint engine spec — real-system, 50+ params, native-by-kernel

**Governing principle:** *coherence beats coverage.* Every surface describes one plausible **real** machine, drawn from real-device datasets, **stable per profile**. The **Lobster Kernel enforces the deep surfaces natively** (no JS tell); until it's online, Camoufox provides native depth and Chromium uses clean CDP for the safe surfaces.

**Method legend:** `kernel-native` (our build, target) · `native` (Camoufox interim) · `JS-safe` (clean patchright value-substitution) · `network` (proxy/header layer).

| Surface (50+ params grouped) | Method | Priority |
|---|---|---|
| TLS JA3/JA4 + HTTP/2 SETTINGS/header order + TCP/IP OS FP | `kernel-native` (BoringSSL/net) · Camoufox genuine stack interim | **P0** |
| Canvas 2D toDataURL/getImageData + text metrics | `kernel-native` farbling (seeded) · Camoufox interim | **P0** |
| WebGL/WebGL2 vendor/renderer/params/extensions + pixel hash | `kernel-native` · Camoufox interim | **P0** |
| AudioContext DSP hash + sampleRate/baseLatency | `kernel-native` · Camoufox interim | **P0/P1** |
| WebRTC IP behind proxy (no leak) | `kernel-native`/`network` | **P0** |
| navigator/UA/UA-CH/Sec-CH-UA (platform, mobile, version, GREASE) | `kernel-native` · `JS-safe` interim + `network` | **P0** |
| Timezone/locale/languages/Accept-Language/geolocation (from proxy IP) | `kernel-native` · `JS-safe` interim + `network` | **P0** |
| Fonts enumeration + metrics matched to OS | `kernel-native` · Camoufox OS font sets interim | **P1** |
| screen/window/DPR/matchMedia/color depth | `kernel-native` · `JS-safe` interim | **P1** |
| hardwareConcurrency/deviceMemory/maxTouchPoints/platform | `kernel-native` · `JS-safe` interim | **P1** |
| Mobile/Android set (mobile UA, touch, mobile GPU, orientation) | `kernel-native` (mobile variant) · `JS-safe` profile interim | **P1** |
| WebGPU adapter/limits/features | `kernel-native` | **P2** |
| Battery/Sensors/speech voices/codecs/permissions shape | `kernel-native` · `JS-safe` interim | **P2** |
| Human-like input (mouse non-linearity, timing) | automation-layer | **P1** |

### Rules (both agents)
1. **Deep surfaces go native.** On the kernel they are native by design; on interim engines rely on Camoufox's native layer and **never** spoof canvas/WebGL/audio/TLS from JS/CDP.
2. **CDP only for JS-safe value substitution** (UA/UA-CH, timezone, locale, geo, viewport, hardware) via patchright isolated contexts — never enable global Runtime/Console.
3. Fingerprints are **seeded, stable per profile**, sourced from **real-device data**, and **coherent** across every surface.
4. Deep-surface reads are **stable within a session** (no per-call noise variance).
5. The **50+ params** share one config model (`@lobster/shared-types`) consumed identically by the editor UI, the sidecar, and the kernel config channel.

---

## 6. Anti-bot coherence bar (what we validate in CI)
- **One device story:** UA ↔ OS ↔ WebGL ↔ canvas ↔ screen/DPR ↔ hardware all describe one plausible real machine.
- **Geo cluster:** timezone + locale + languages + Accept-Language + geolocation all match the **proxy exit IP**.
- **Version alignment:** engine version matches the UA-claimed version.
- **Coherent network story:** TLS/HTTP2 matches the claimed browser (kernel-native target; Camoufox genuine interim).
- **No WebRTC/DNS leak; clean CDP** (no automation artifacts).
- **CI gate:** CreepJS trust / Pixelscan "consistent" / Sannysoft pass, as an objective threshold.

---

## 7. Agent operating model & rules

### 7.1 Roles
- **Claude — Lead Architect / Integrator / Reviewer.** Owns this plan, specs/ADRs, the Rust desktop core, the fingerprint-coherence model, security-sensitive code, the **Lobster Kernel** build+patch pipeline, engine integration, and the validation harness. **Blocking** review authority on P0/security/engine/kernel PRs.
- **OpenAI Codex — Primary Implementer.** React/TS UI + design system, NestJS CRUD + data models, proxy utilities, local-API handlers, SDK examples, tests, docs.
- Both write tests; every PR is cross-reviewed by the other agent.

### 7.2 Unit of work = a Ticket
`docs/tickets/T-XXX-*.md`: **goal · spec · files · acceptance · tests · assignee · pillar**. No code without a ticket. No ticket spans >1 pillar.

### 7.3 Git
Trunk-based, one PR per ticket, squash merge, Conventional Commits + co-author trailer. Small PRs.

### 7.4 Definition of Done (ALL hold)
1. Meets acceptance criteria. 2. Tests written + green. 3. `typecheck`/`lint`/`build` green for affected packages (`cargo fmt`/`clippy` for desktop; kernel builds via its pipeline). 4. Fingerprint-surface/engine work: **validation gate green**. 5. Cross-reviewed + approved (Claude blocking on P0/security/engine/kernel). 6. No secrets committed.

### 7.5 Working rules
- **Import freely.** The project is open source — fork/import/adapt any OSS that helps (patchright, fingerprint-suite, Camoufox, ungoogled-chromium, mitmproxy, and reference from Donut/others). Keep attribution files.
- **Own the kernel & the UI.** The engine is our **own Lobster Kernel** (Donut = reference only); the UI/UX is our **own design system**.
- **Deep surfaces native; safe surfaces via clean CDP.** Keep CDP artifact-free.
- Fingerprints: **real-system, per-profile stable, coherent, proxy-geo-derived**.
- **No secrets in the repo.** **Report faithfully** — green gates over assertions.
- **Protect the v1 milestone.** The kernel track runs in parallel and must not derail the 10-day product; the product stays fully usable on the interim engines throughout.

### 7.6 Handoff
`ticket · what changed · files · how verified (tests + gate) · follow-ups` → reviewer replies `APPROVE` or blocking comments.

---

## 8. Repository structure & CI gates

```
/apps
  /desktop            # Rust + Tauri core + React/TS custom UI + Axum local API
  /backend            # NestJS cloud SaaS (auth, teams, sync, logs, billing)
/packages
  /engine-runner      # Node/TS sidecar: launch/control Kernel + Camoufox + Chromium
  /fingerprint        # seed→coherent fp, 50+ param model, real-device data, coherence rules
  /proxy              # proxy test, exit-IP geo derivation
  /shared-types       # shared types incl. the 50+ param fingerprint config model
  /local-api-sdk      # JS + Python API clients
/kernel               # Lobster Kernel: build scripts, GN args, quilt patch series, config channel
/engines              # download-on-first-run scripts for interim engines (binaries NOT committed)
/docs                 # this plan, ADRs, contracts, tickets, agent protocol
/ci                   # fingerprint validation harness
/tests                # e2e / integration / detector validation
```

**CI gates (block merge):** build/lint/typecheck/unit tests · integration (launch → connect via local API) · **fingerprint validation gate** · secret scan (gitleaks). The **kernel build** runs in its own long-running pipeline (not on every PR).

---

## 9. Success factors — how we win

| # | Focus | How we win |
|---|---|---|
| S1 | **The kernel is the moat** | Build our own Chromium kernel with native fingerprinting + TLS/JA4; start now, bring it online progressively as the flagship engine. |
| S2 | **Usable from day one** | Ship on Camoufox (High-Stealth) + ungoogled-Chromium so the product is complete and demoable while the kernel matures — no waiting. |
| S3 | **Real-system realism** | Drive fingerprints from real-device datasets; 50+ coherent params; stable per profile. |
| S4 | **Always-passing quality bar** | Detector matrix wired into CI as an objective gate from day one. |
| S5 | **Own experience** | Fully custom UI/UX design system — a distinctive, polished product, not a clone. |
| S6 | **Clean automation** | patchright isolated contexts; artifact-free CDP; kernel-native beyond that. |
| S7 | **Solid data foundation** | Encrypted profile blobs at rest + in transit; versioned sync; action logs; single-instance isolation. |

---

## 10. The plan (parallel tracks + milestones)

`[C]` Claude · `[X]` Codex · `[C+X]` paired. Claude reviews all P0/engine/kernel PRs.
**Track A** Desktop Core · **Track B** Engine runner & Fingerprint · **Track C** Backend/SaaS · **Track D** Automation API + SDK · **Track E** QA/Validation · **Track F** Lobster Kernel (parallel, longer horizon).

### Day 0 — Foundations `[C]` ✅ done
Repo, npm workspaces, foundational packages (`shared-types`, `fingerprint`, `proxy`, `engine-runner`), app scaffolds, CI skeleton, docs/ADRs/agent-protocol, engine download scripts, validation stub. Verified: core packages build; fingerprint engine deterministic + coherent.

### Day 1
- A `[X]`: Tauri shell boots; custom UI shell + design-system foundation.
- B `[C+X]`: sidecar IPC live; integrate fingerprint-suite + real-device data behind `deriveFingerprint`; expand to the 50+ param model.
- C `[X]`: NestJS + Prisma migrate (User/Team/Profile/ApiKey/Subscription).
- E `[C]`: host CreepJS/Sannysoft + score scraper.
- **F `[C]`: stand up the kernel build environment (depot_tools, fetch Chromium), kick off the first Linux build.**

### Day 2
- B `[C]`: launch Camoufox with a coherent real-system fingerprint; persistent user-data-dir.
- A `[X]`: profile CRUD + single-instance lock; fingerprint editor UI (first params).
- C `[X]`: JWT auth + accounts.
- **F `[C]`: first Chromium build succeeds; init the quilt patch series.**

### Day 3
- B `[C]`: launch ungoogled-Chromium via patchright; inject JS-safe surfaces; clean CDP.
- Proxy `[X]`: per-profile HTTP/SOCKS5 + test + geo/timezone auto-sync.
- A `[X]`: profile UI (create/clone/list/delete, tags/folders); mobile fingerprint profile type.
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
- **F `[C]`: wire one fingerprint param end-to-end through the kernel config channel (POC).**

### Day 6
- C `[X]`: share profiles; roles enforced; action logs; API-key UI.
- D `[X]`: SDK examples + connect docs.
- A `[C]`: 50+ param editor coverage + profile status/lock robustness.

### Day 7 — stealth polish
- E `[C]`: full detector matrix; tighten coherence across all params + mobile.
- **F `[C]`: canvas/WebGL farbling patch prototype in the kernel.**

### Day 8 — packaging
- A `[C+X]`: desktop installer (Windows first; macOS if time); bundle sidecar; engine download-on-first-run; signing setup.
- Security pass; C `[X]`: backend to staging.

### Day 9 — QA & docs
- E `[C+X]`: full E2E QA + real anti-bot targets; bug bash; perf. Docs (user/API/SDK/admin). Feature freeze.

### Day 10 — launch candidate `[C]`
- Installer + staging backend; demo script; **kernel status + roadmap**. Acceptance vs §7.4 + §4. Retro.

### Track F beyond Day 10 — kernel to flagship
Full native coverage of all 50+ params, TLS/JA3/JA4 + HTTP/2 matching, audio/WebGPU, multi-OS signed builds (Win/mac-Intel/mac-ARM/Linux), continuous upstream-rebase automation, then **make the kernel the default engine**.

---

## 11. Roadmap beyond v1

1. **Lobster Kernel to production**: complete native 50+ param enforcement, BoringSSL TLS/JA4 + HTTP/2, canvas/WebGL/audio/WebGPU farbling across frames/workers/OffscreenCanvas; make it the default engine.
2. **Multi-OS signed kernel builds** + notarization + auto-update; continuous Chrome-stable rebase.
3. **Mobile kernel / Android emulation** for true mobile fingerprints.
4. **Granular RBAC** (tag-scoped, per-profile perms) + full immutable audit.
5. **Cloud-run profiles** (browser in the cloud), simultaneous-launch metering, cloud phones.
6. Proxy marketplace / rotation; official SDKs (Py/JS/C#); **MCP server**; disposable profiles; cookie collector / warm-up; human-like input library; higher-scale billing (seats, API RPM, annual).

---

## 12. Decisions to confirm (defaults chosen; override anytime)
1. **Kernel base** — default: fork Chromium via depot_tools with an ungoogled-style quilt patch series. (Alt: patch on top of ungoogled-chromium directly.)
2. **Kernel build infra** — needs a dedicated build machine/CI (large, long compiles). Confirm where it runs (self-hosted runner / cloud build).
3. **Interim engine mix** — Chromium (default) + Camoufox (High-Stealth), until the kernel is the default.
4. **Proxy sourcing** — default bring-your-own in v1; reseller later.
5. **Target OS priority** — Windows first, macOS second, Linux for headless/kernel builds.

---

## 13. Verification — how we prove it works (end-to-end)
1. **Fingerprint fidelity:** a Camoufox profile behind a residential proxy → CreepJS trust high/no lies, Pixelscan "consistent", Sannysoft all-pass, no WebRTC leak, timezone/locale match proxy geo.
2. **Coherence & params:** UA ↔ UA-CH ↔ platform ↔ WebGL ↔ fonts ↔ screen agree; all 50+ params round-trip UI → sidecar → engine.
3. **Automation:** `POST /start` → Playwright `connectOverCDP` + Selenium `debuggerAddress` drive the same profile → `POST /stop`.
4. **Persistence/isolation:** cookies survive restart; profiles never share state; single-instance lock holds.
5. **SaaS:** sign up → create/sync profile → invite teammate → shared profile opens → action logs recorded → Stripe tier gates profile count.
6. **Kernel POC:** a Lobster Kernel build launches and honors at least one fingerprint param from the config channel.
7. **Packaging:** clean install on a fresh Windows machine → engine download → launch works.

**v1 is accepted** when 1–5 + 7 pass and every §4 pillar has a working end-to-end path; the kernel POC (6) proves the flagship track is real and on course.
