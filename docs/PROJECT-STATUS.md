# Project Status & Operating Manual — Lobster Browser

> **The single authoritative source of truth for what is real, what is scaffolding, and what remains.**
> The phased plan from here to a shippable, multi-OS product is [`PRODUCTION-ROADMAP.md`](PRODUCTION-ROADMAP.md).
> Reconciles [`MASTER_PLAN.md`](MASTER_PLAN.md) (strategy) with the **actual verified state of the code**.
> Synthesized from a 9-lane deep code audit (not a doc review) and spot-verified against source. It does
> **not** soften the maturity assessment. Companion docs: [`DEPENDENCIES.md`](DEPENDENCIES.md) (critical
> path), the per-ticket board [`tickets/README.md`](tickets/README.md), native detail
> [`../lobium/patches/hooks.md`](../lobium/patches/hooks.md).
>
> **Last updated:** 2026-07-04, against `main` @ `12ad97f` (+ this audit). **Maturity legend:**
> **PROVEN** = validated by a real run / live test / integration test · **SCAFFOLDED** = compiles /
> typechecks / unit-tested in isolation, no end-to-end proof · **STUB / ABSENT** = not implemented.
> **Priorities:** P0 blocks a sellable v1 · P1 Octo-class parity · P2 depth/scale. **Effort:** S <½d ·
> M ½–2d · L 2–5d · XL >1wk / needs build-farm or real-GPU.
>
> ⚠️ **This doc previously over-claimed** ("works end-to-end", "6 surfaces", "live gate in CI"). Those
> are corrected below. The correction itself is the point: confidence comes from green gates, not prose.

---

## 1. Executive status (the honest truth)

**The hardest, most differentiating piece — the native Lobium anti-detect engine — is genuinely built
and far past "scaffolding," while the connective tissue that turns it into a sellable product is largely
unbuilt or unproven.** A from-source Chromium 152 fork compiles, links a 172 MB binary, and carries ~10
real Blink fingerprint hooks that are byte-for-byte in the tree with per-surface proof hashes. The
TypeScript orchestrator (fingerprint derivation, engine-runner, proxy WebRTC policy, backend
auth/teams/profiles) is real with ~160 green unit/integration tests.

**Three facts define the true distance to v1:**

1. **Every anti-detect proof ran on SwiftShader software rendering** — itself a headless/VM tell — so the
   *actual* CreepJS/Pixelscan/live-anti-bot score is **unknown**. No "Octo-class" claim is defensible
   until a real-GPU run exists (**ENG-2**).
2. **The native engine is not wired into the product launch path.** The runner/desktop/SDK launch
   *interim patched Chromium* with JS-only CDP overrides; **no launcher calls `writeLobiumConfig` or
   passes `--lobium-fp-config`** (verified). The moat is reachable only by a bespoke `ci/validation`
   script — real users never touch it (**RUN-1**).
3. **The "zero-knowledge" crown jewel is currently false.** Profile blobs (live authenticated sessions)
   transit and store as **base64 plaintext** — there is no client-side encryption anywhere in the source
   (verified: zero AES/Argon2/subtle-crypto) (**SEC-1/SEC-2**).

**The one task that gates the most is ENG-2 (real-GPU validation).** Provision a real-GPU machine now —
it is the long-pole and unblocks every anti-detect claim, all threshold numbers, and the QA matrix.
**The engine is ahead of schedule; the product around it is behind.** Spend cycles on the critical
chain (§4) before anything cosmetic.

---

## 2. Verified-DONE inventory

### 2.1 Native Lobium engine — the moat
| Item | Maturity | Evidence |
|---|---|---|
| From-source Chromium 152.0.7928.0 + `//components/lobium_fp` compiles | PROVEN (build) | `lobium_fp_config.o`/`lobium_farble.o`/`lobium_audio_farble.o`; 14 hook points match tree byte-for-byte |
| Config channel (browser→base64→renderer `Current()`, cached, 24 KB guard) | PROVEN (per-surface) | `render_process_host_impl.cc`; parse-once base64 decode |
| navigator hardwareConcurrency / deviceMemory (+header) / maxTouchPoints | PROVEN (per-surface, SwiftShader) | proof configs; hwc 7 vs host 12 |
| navigator.userAgent + platform native in **all** contexts incl. **workers** | PROVEN (per-surface) | `navigator_base.cc` shared base; gate asserts worker UA; CreepJS hard-headless 33%→0% |
| WebGL UNMASKED vendor/renderer (atomic pair) | PROVEN (SwiftShader) | both-non-empty guard; masked stays "WebKit" |
| Canvas 2D farbling (getImageData/toDataURL/toBlob/OffscreenCanvas, no double-farble) | PROVEN (per-surface) | hashes `461f6aa5→625d2eaf→2c485d78`; drawImage MATCH=true |
| Web Audio farbling (offline + analyser + worklet/SPN taps, playback-safe) | PROVEN (per-surface) | `41c67cf0→235885ed→7b006b3c`; interChannelMaxDiff 0 |
| screen geometry/colorDepth/DPR via devicePixelRatio **and** matchMedia | PROVEN (per-surface) | `screen.cc` + `media_values.cc`; closes 800×600 tell |
| TLS/JA3/JA4/HTTP2 coherence for **Chrome personas** | PROVEN by absence | `grep -rli lobium net/ boringssl/` = 0 → genuine Chrome 152 stack |
| Shipped binary contains ALL surfaces, re-validated end-to-end | **NOT PROVEN** | `chrome` launcher (01:28) older than `libblink_core.so` (14:12); component-build → probably current, **never re-validated** → ENG-1 |
| Any real-GPU anti-detect score | **NOT PROVEN** | 100% of proofs under `--enable-unsafe-swiftshader` → ENG-2 |
| `seeds.webgl` (WebGL pixel farbling) | **DEAD CONFIG** | emitted + parsed, **consumed by nothing** → ENG-3 |

### 2.2 Orchestrator & platform
| Subsystem | PROVEN | SCAFFOLDED / STUB / ABSENT |
|---|---|---|
| **fingerprint** | deterministic seed→fp (50-seed sweep); exhaustive coherence on every catalog entry; UA pinned to engine build; geo overlay is pure locale/tz rewrite; 41/41 tests | Mobile/Android ABSENT; catalog thin (18 desktop, dm=8 on 17/18, colorDepth always 24); Apple-Silicon arch tell (`Sec-CH-UA-Arch:x86` on M-series); no availTop/arch/font-vs-OS coherence rules |
| **engine-runner + SDK** | real patchright launch, `connectOverCDP`, webdriver≠true (581 ms live); startProfile derive→launch (308 ms); CompositeRunner status/stop; CDP masking; unit tests | **native Lobium launcher ABSENT** (RUN-1); `Target.setAutoAttach` not used → popups leak real navigator (RUN-2); single-instance lock never released on crash (RUN-3); SDK `headless` silent no-op, `pid` always 0; humanize has zero non-test callers |
| **desktop (Rust/Tauri)** | SQLite CRUD (3 tests); SidecarClient JSON-RPC; strict-lint clean | **`launch_profile`/`stop_profile` return `Err` unconditionally** (DSK-1); GUI **never run integrated**; single-instance lock **claimed done but ABSENT**; UI Proxies/Automation/Team/Settings are placeholder cards; zero frontend tests |
| **backend (NestJS)** | auth (bcrypt/JWT), teams+RBAC, profiles (team-scoped, plan-limit), API keys (sha256), audit log, optimistic-concurrency sync — **all in-memory**, 49 tests | **S3BlobStore throws** → no durable store (BE-1); **Postgres/Prisma path never exercised** by any test/CI (BE-2); **Stripe billing stub**, no webhook signature, profileLimit stuck at 5 (BE-4); ApiKeyGuard dead code; no member-removal routes |
| **proxy + cookies** | proxy parse/format (16), geo mapper, WebRTC suppression (live, no proxy), cookie parse/serialize (8) | **cookie injection into a browser ABSENT** (PROX-1); **testProxy unreachable** — no RPC/Tauri command (PROX-3); **SOCKS5 exit-geo hard-rejected → silent en-US locale** (PROX-4); no localStorage/IndexedDB/extensions; no kill-switch/DNS-leak |
| **QA / CI** | interim-engine sannysoft gate + WebRTC + engine-launch **blocking in CI** | **native Lobium gate never runs in CI** (QA-1); no E2E product flow (QA-3); no Pixelscan/Iphey/browserleaks/FingerprintJS; no live anti-bot; no load/perf |
| **security / ops** | bcrypt, JWT prod-hard-fail, sha256 keys, append-only audit, CORS allowlist, loopback API, gitleaks (diff-only) | **client-side blob crypto ABSENT** (SEC-1/2); **local API default-ALLOW** + non-constant-time compare (SEC-3); zero observability (no logs/metrics/tracing); no packaging/signing/updater (version 0.0.0); local SQLite plaintext (proxy creds) |

**Test figure:** `npm run test --workspaces` → **160 pass / 0 fail** + `cargo test` (desktop). Re-run to
reproduce; do not cite from memory.

---

## 3. Reconciliation — stale/over-claimed statements now corrected

The audit found **47 stale-doc claims**; the highest-impact (this doc + engine docs) are corrected here.
The full spec reconciliation is tracked as **DOC-1** (see §4).

| Where | Was claimed | Reality |
|---|---|---|
| PROJECT-STATUS (prev) | "anti-detect engine works end-to-end" | Engine proven **in isolation**; **not wired** into any product launch path (RUN-1) |
| PROJECT-STATUS (prev) | "six native surfaces" | The table + gate define **ten**; "6" was drift |
| PROJECT-STATUS (prev) | "live-detector CI gate launches the real binary" | **False** — CI runs only the interim `run.mjs`; `lobium-detect.mjs` never runs in CI (QA-1) |
| PROJECT-STATUS (prev) | "verdict=pass, 10/10 latest run" | **Not reproducible** — never relinked/re-validated after last surfaces; SwiftShader-only |
| hooks.md | surfaces "BUILT + PROVEN" | must read "PROVEN **on SwiftShader software rendering**" (ENG-2 pending) |
| hooks.md | `seeds.webgl` "in the config" | it is **dead config** — consumed by nothing |
| specs/lobium-build.md | "none of the native patches exist" | **Wrong** — Chromium 152 built, ~10 surfaces landed |
| specs/fingerprint-parameters.md | "Apify generator + 32-candidate pool"; "canvas/WebGL/audio not built" | Apify **removed** (9499136); native canvas/audio/WebGL **built**; only WebGL *pixel* + TLS remain |
| tickets (T-002/README) | "cloud sync encrypted"; "proxy test shipped"; "cookies built" | blobs **plaintext**; testProxy **unreachable**; cookies a **parse lib with zero consumers** |
| README.md | "Status: Day 0 — Foundations" | Orchestrator + Lobium built; badly stale |
| repo-wide | "known exposed GitHub token" | **not found** in repo/history/config/.env/memory — rotate regardless + document provenance (SEC-17) |

---

## 4. Master remaining-work register (deduped, prioritized)

**104 tasks across 9 lanes, deduped to canonical IDs.** Sorted by priority within area. Full detail
(acceptance criteria, files, deps) per task is preserved in the audit artifacts; the register below is
the authoritative task list. `→ID` = folded into that canonical task.

### ENG — Native engine
| ID | P | Eff | Task | Acceptance (short) |
|---|---|---|---|---|
| ENG-1 | P0 | S | Relink + re-validate current binary | binary newer than every `.o`; gate ≥3 seeds verdict=pass 10/10; report committed |
| **ENG-2** | **P0** | M | **Real-GPU validation (the keystone)** | rebuild w/o SwiftShader on real GPU; `webglMatchesClaim=true`; CreepJS trust recorded; "headless ~38%" gone |
| ENG-7 | P0 | XL | Signed build matrix (Win/mac×2/Linux) + notarization + `rebase.sh` on a real quilt sync | reproducible signed binary passes notarization; rebase pops/refreshes/pushes |
| ~~ENG-3~~ | ✅DONE | M | WebGL pixel farbling + Y-flip coherence (`seeds.webgl`) | **PROVEN** (3f15927): readPixels+toDataURL host-diff/stable/distinct; Y-flip coherence mismatch=0 |
| ~~ENG-4~~ | ✅RESOLVED | — | chrome.runtime / branding | **No chrome.runtime added** (Chrome 106+ hides it too → adding = a tell). Real "Google Chrome" brand delivered natively by ENG-5. Residual: `proprietary_codecs` off (canPlayType tell) — build-flag follow-up |
| ~~ENG-5~~ | ✅DONE | M | Worker HTTP User-Agent header + Sec-CH-UA metadata | **PROVEN** (3f15927): worker UA flips host→persona natively; userAgentData brands `[…Google Chrome…]` + platform in main+worker |
| ~~ENG-6~~ | ✅DONE | L | Fonts packaging (private fontconfig + launcher env) | **PROVEN** (29032a6): host fonts excluded, persona set only, stable metrics; via `FONTCONFIG_FILE` envFor hook. Fuller metric-clone bundle = follow-up |
| ~~ENG-8~~ | ✅DONE (scalar) | L | WebGL capability alignment | **PROVEN**: MAX_*/viewport/aliased-range overridden natively per GPU class (D3D11/Metal/GL), so caps agree with the renderer (`maxTex` 8192→16384; Metal `maxVUnif`=1024 vs D3D11 4096). **Residual (real-GPU boundary):** extension-list + shader-precision alignment needs per-GPU capture |
| ~~ENG-10~~ | ✅DONE | S | Audio byte paths farbled | **PROVEN**: getByte{Frequency,TimeDomain}Data = quantization of the farbled float (host-diff, per-seed distinct). WMA `getScreenDetails` still a P2 follow-up |

### FP — fingerprint
| ID | P | Eff | Task |
|---|---|---|---|
| FP-2 | P1 | S | Enforce availTop-vs-OS in validator (mac=25 / Win-Linux=0) |
| FP-3 | P1 | S | arch-vs-device; pin Apple-Silicon → `arm64` (kills `Sec-CH-UA-Arch:x86` tell) |
| FP-1 | P1 | L | Mobile/Android profile type (UA/Sec-CH/coherence branches) |
| FP-4/5/7 | P2 | M | font-vs-OS, GPU-backend-vs-OS (Metal/Mesa), DPR-vs-resolution coherence rules |
| FP-6 | P2 | M | Expand catalog: ≥15 devices/OS, ≥2 deviceMemory values, both colorDepths |
| FP-8 | P2 | M | Model remaining navigator fields (vendor/oscpu/bitness/model/WoW64) |

### RUN — engine-runner & SDK
| ID | P | Eff | Task |
|---|---|---|---|
| **RUN-1** | **P0** | L | **Native Lobium launcher in the runner** (resolve `LOBSTER_LOBIUM_BIN`, `writeLobiumConfig`, spawn `--lobium-fp-config`, still apply CDP, register for `'lobium'`, fall back to interim) |
| RUN-2 | P2↓ | M | `Target.setAutoAttach` + `waitForDebuggerOnStart` popup gate | **ASSESSED — severity downgraded for Lobium.** The native config channel forwards to EVERY renderer incl. popups, so a popup CANNOT leak the device identity (UA/platform/canvas/WebGL/audio/screen are all native-safe there — verified: main page fully spoofed with no CDP). Residual = only the CDP-only surfaces (timezone/locale/geo) have a brief pre-override window in a popup; the existing per-page handler applies them but doesn't gate. Full `waitForDebuggerOnStart` gate DEFERRED: it needs browser-level CDP that Playwright's persistent-context API doesn't cleanly expose + can't be verified here (headless popups don't fire the `page` event), so shipping it would risk the proven launch path. Still worth doing for the **interim** engine (all-CDP → higher severity). |
| RUN-3 | P1 | M | Release single-instance lock on close/crash |
| RUN-5 | P1 | S | Honor SDK `headless` flag end-to-end |
| RUN-10 | P1 | M | Coherence assertions in launch integration tests (page+worker UA, hwc, tz) |
| RUN-6/7 | P2 | S | Fix `pid=0` (or drop); remove dead `initScript` duplication |
| RUN-9 | P2 | XL | Official typed SDKs (Py/JS/C#) + MCP server + cloud-run |

### DSK — desktop
| ID | P | Eff | Task |
|---|---|---|---|
| **DSK-1** | **P0** | M | **Wire `launch_profile`/`stop_profile`** (currently unconditional `Err`) |
| DSK-2 | P0 | M | First real integrated GUI run + CI webview smoke |
| DSK-5 | P0 | XL | Packaging + signing + notarization + updater + build matrix |
| DSK-3 | P1 | S | Single-instance lock (claimed done, absent) |
| DSK-11 | P1 | L | Bundled/in-process sidecar (remove external `node` dependency) |
| DSK-10/12 | P1 | M | Crash reporting + React error boundary; frontend unit tests |
| DSK-8/9/13 | P2 | M–L | Onboarding; i18n; implement Proxies/Automation/Team/Settings sections |

### BE — backend
| ID | P | Eff | Task |
|---|---|---|---|
| **BE-1** | **P0** | L | **Implement S3BlobStore** (put/getLatest/head, atomic CAS) — currently throws |
| **BE-2** | **P0** | L | **Prove Postgres/Prisma path** + CI Postgres service (never exercised) |
| BE-4 | P1 | L | Real Stripe billing + raw-body webhook verification + Subscription write |
| BE-3 | P1 | M | Persist + lifecycle `encryptedBlobRef`; delete blobs on profile removal + quota |
| BE-5 | P1 | M | Wire `ApiKeyGuard` (verify() is dead code) |
| BE-7 | P1 | M | Member removal / team deletion / leave-team routes |
| BE-9 | P1 | M | Deploy pipeline: Dockerfile + staging |
| BE-8/11 | P2 | S–XL | Audit team/role events; session depth (revocation/refresh/reset/2FA/SSO) |

### PROX — proxy / cookies / data
| ID | P | Eff | Task |
|---|---|---|---|
| **PROX-1** | **P0** | M | **Cookie injection into launched context** (no `Network.setCookies` anywhere) |
| **PROX-3** | **P0** | M | Expose `testProxy` over RPC + Tauri + UI (implemented but unreachable) |
| **PROX-4** | **P0** | M | SOCKS5 exit-geo (currently rejected → silent en-US locale, a top bot signal) |
| PROX-2 | P1 | M | Cookie export (CDP `getAllCookies`) |
| PROX-5/7/8 | P1 | L | Authed-SOCKS5 shim; DNS-over-proxy (socks5h) + leak gate; kill-switch (fail-closed) |
| PROX-9 | P1 | L | localStorage / IndexedDB import-export |
| PROX-10/11/12/13 | P2 | M–XL | bookmarks/history/autofill; extension loading; rotation/chaining/pools; cookie warm-up |

### QA — validation / CI
| ID | P | Eff | Task |
|---|---|---|---|
| **QA-1** | **P0** | L | Wire `lobium-detect.mjs` into CI as a **blocking** gate (native gate never runs) |
| **QA-3** | **P0** | L | E2E product-flow CI: create→launch→proxy→connect→stop |
| **QA-4** | **P0** | M | Prove WebRTC no-leak behind a **real proxy on Lobium** (srflx == proxy egress) |
| QA-5 | P1 | L | Self-hosted detector breadth (Pixelscan/Iphey/browserleaks/FingerprintJS) |
| QA-6 | P1 | XL | Nightly live anti-bot panel (Cloudflare/DataDome/Akamai/Kasada) — the true Octo KPI |
| QA-7 | P1 | L | Load/perf harness + enforce NFR SLOs |
| QA-8 | P1 | M | Extend coherence validator (7→15 rules) |

### SEC — security / observability / release
| ID | P | Eff | Task |
|---|---|---|---|
| **SEC-1** | **P0** | L | **Client-side AES-256-GCM blob encryption** (blobs are plaintext today) |
| **SEC-2** | **P0** | XL | Key hierarchy + OS keychain (Argon2id UMK → wrapped team/profile keys) |
| **SEC-3** | **P0** | M | **Local-API default-deny** + constant-time compare + Origin/Host check + rate limit |
| SEC-14 | P0 | XL | Unified release signing/notarization/updater (folds DSK-5 + ENG-7) |
| SEC-6/7/8 | P1 | M | Structured logging + `/metrics` + readiness probes + Sentry |
| SEC-9/10/11 | P1 | M–L | Rate-limit + helmet; Dockerfile + MinIO compose + env validation; gated migrate deploy |
| SEC-12 | P1 | L | Local SQLite at-rest encryption (proxy creds plaintext today) |
| SEC-16/17 | P1 | S | Harden gitleaks (full-history + license + dep-audit); confirm/rotate suspected credential |
| SEC-13/15 | P2 | L–M | Refresh-token rotation + sessions + 2FA; backups/DR + S3 lifecycle |

### DOC — management docs
| ID | P | Eff | Task |
|---|---|---|---|
| DOC-1 | P0 | M | Reconcile all 9 specs (supersession banners + "Status vs target" rewrite) |
| DOC-2 | P0 | S | Fix repo README status + getting-started (still says "Day 0") |
| DOC-4 | P1 | M | **TRACEABILITY.md** — requirement→spec→ticket→test/proof matrix (biggest missing artifact) |
| DOC-5 | P1 | S | **DEPENDENCIES.md** — critical-path DAG (added this pass) |
| DOC-6 | P1 | M | ADR index + capture post-Day-2 decisions (Apify/Camoufox dropped, fonts=packaging, worker-UA native) |
| DOC-7 | P1 | M | DEVELOPING.md + ENVIRONMENT.md (build every layer, env/secrets/ports register) |
| DOC-3/8/9 | P1 | S | Ticket-board footer/columns; per-phase machine-checkable exit criteria; PROJECT-STATUS accuracy hygiene |
| DOC-10/11/12 | P2 | S–M | OWNERSHIP/RACI; SLO dashboard spec; GLOSSARY + CHANGELOG |

---

## 5. Critical path to a sellable v1

**ENG-2 gates the most.** Every anti-detect claim, all threshold numbers, and QA-1/4/5/6 depend on a
real-GPU score. Provision the GPU host now (long-pole procurement).

**Serial spine (each blocks the next):**
```
ENG-1 (relink+revalidate, S)
  → ENG-2 (real-GPU proof, M)         ← THE keystone; needs GPU hardware
  → RUN-1 (native launcher in runner, L)  ← makes the moat reachable by the product
  → DSK-1 (wire launch button, M)
  → QA-3 (E2E create→launch→proxy→connect→stop, L)
  → QA-1 (native gate blocking in CI, L)
```
Only after this chain is any "Octo-class" statement both **defensible** and **exercised by shipping
code**.

**Runs in parallel immediately (no GPU dependency):**
- **Security:** SEC-1 → SEC-2 (blob crypto — the plaintext launch blocker); SEC-3 (default-deny API — landable today).
- **Backend durability:** BE-1 (S3/MinIO) + BE-2 (Postgres CI).
- **Proxy/cookies:** PROX-1, PROX-3, PROX-4.
- **Fingerprint hygiene:** FP-2, FP-3 (small, high-value).
- **Docs:** DOC-1, DOC-2 first — stop the specs from actively misleading implementers.

Full DAG + blocks/blocked-by table: [`DEPENDENCIES.md`](DEPENDENCIES.md).

---

## 6. Phased roadmap with measurable exit criteria

### Phase A — Prove the moat (make the anti-detect claim true and measured)
**Tasks:** ENG-1, ENG-2, RUN-1, DSK-1, QA-1, QA-4, RUN-10, FP-2, FP-3.
**Exit (all must hold):** (1) `out/Lobium/chrome` newer than every `.o`; gate on a **real-GPU host
without SwiftShader** = verdict pass, 10/10, `webglMatchesClaim=true`. (2) CreepJS trust ≥ threshold set
from that run; "like headless ~38%" gone. (3) A profile launched **through CompositeRunner** writes
`lobium-fp.json` (0600) + passes `--lobium-fp-config` + passes the gate. (4) `lobium-detect.mjs` is a
**blocking CI job** with archived JSON report. (5) Lobium behind a live proxy: every public ICE candidate
== proxy egress IP.

### Phase B — Make it a safe product (no plaintext, authenticated, durable)
**Tasks:** SEC-1/2/3, BE-1/2/3, PROX-1/3/4, QA-3, SEC-6/7.
**Exit:** (1) synced-blob wire/store bytes contain **no cleartext cookie/domain** (grep test); tamper
fails decryption. (2) Two members unwrap the same team key + decrypt a shared profile. (3) Release-build
local API → 401 on every non-`/health` when no key; foreign Origin rejected; constant-time compare.
(4) S3BlobStore round-trips MinIO, 409 on racing writes, survives restart; Postgres integration suite
green in CI. (5) QA-3 E2E green. (6) Cookie import → logged-in session on a real site; testProxy usable
from the UI.

### Phase C — Ship it (signed, updatable, observable)
**Tasks:** ENG-7, DSK-5/11/2/3/12, SEC-14/8/9/10/11, BE-4/9.
**Exit:** (1) Signed+notarized installers (Win/mac×2/Linux) install+launch on **clean VMs**, find bundled
sidecar+engine, open the profiles window. (2) `spctl -a` passes; Windows Authenticode valid; updater
verifies Ed25519 before applying. (3) `rebase.sh` cleanly refreshes the quilt series onto a newer Chrome
ref. (4) Backend behind a Dockerfile with JSON logs, `/metrics`, `/health/ready` = 503 without Postgres
in prod; a **signed** Stripe webhook flips tier + the profile-limit gate honors it. (5) Second app launch
focuses the first; CI webview smoke fails if IPC breaks.

### Phase D — Beat real adversaries (Octo-class KPI) + scale
**Tasks:** QA-5/6/7/8, ENG-3/4/5/6/8, FP-1, PROX-5/7/8/9, SEC-12/13/15, SEC-16/17, DOC lane.
**Exit:** (1) Nightly live panel **≥90% pass-rate per engine** vs Cloudflare/DataDome/Akamai/Kasada
behind residential proxies, trended with alerts. (2) FingerprintJS visitorId stable-in-session /
distinct-across / not-bot. (3) Load harness confirms NFR SLOs (cold launch ≤3s p50, ≥25 concurrent/16 GB,
derive ≤5 ms, local API ≤20 ms p95) — or targets revised to measured reality. (4) WebGL pixel farbling
Y-flip-coherent; worker HTTP UA shows persona; SOCKS5 keeps geo coherence; kill-switch fail-closed.
(5) TRACEABILITY matrix: every pillar + gap cites a test/gate; no "done" without evidence.

---

## 7. Risk register (ranked, HIGH first)

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 1 | Zero real-GPU validation — every "proven" number is SwiftShader (a headless/VM tell); true score **unknown** | HIGH | ENG-2 before any Octo-class claim |
| 2 | Native moat **unreachable through the product** (runner/desktop launch interim Chromium) | HIGH | RUN-1 + QA-3 |
| 3 | Shipped binary never re-validated end-to-end after last surfaces | HIGH | ENG-1 relink + dated report |
| 4 | Profile blobs (live sessions) are **base64 plaintext**; "zero-knowledge" is false | HIGH | SEC-1/2; gate sync behind encryption-present check |
| 5 | Local API **default-allow** + non-constant-time compare — any local process/page can drive sessions + read proxy creds | HIGH | SEC-3 default-deny + Origin/Host + rate limit |
| 6 | Cloud sync has **no durable store** (S3 throws) — all synced data lost on restart | HIGH | BE-1 + readiness check |
| 7 | Postgres/Prisma path **never exercised** — SQL bugs surface only in prod | HIGH | BE-2 integration suite + CI Postgres |
| 8 | Popup/child pages briefly expose real surfaces before async override | ~~HIGH~~→MED | **Downgraded (RUN-2 assessed):** Lobium's native config reaches popup renderers, so device identity is native-safe there; only CDP-only tz/locale/geo have a brief popup window. Full gate deferred (see RUN-2) |
| 9 | WebRTC-behind-proxy proven only on interim/no-proxy | HIGH | QA-4 srflx==egress with live proxy |
| 10 | No desktop release maturity (0.0.0, unsigned, no updater) → SmartScreen/Gatekeeper | HIGH | DSK-5 + ENG-7 + SEC-14 |
| 11 | GUI **never run integrated**; core Launch action is a stub | HIGH | DSK-1 + DSK-2 + CI smoke |
| 12 | Only sannysoft enforced; **no live anti-bot tested** — could ship green-CI and be blocked in prod | HIGH | QA-5 + QA-6 |
| 13 | Zero observability — a prod incident is undebuggable; silent sidecar-spawn failure disables the API | HIGH | SEC-6/7/8; surface sidecar failure |
| 14 | Billing stub with no webhook signature — spoofing flips tiers if naively enabled | HIGH | BE-4 raw-body + constructEvent before enabling |
| 15 | SOCKS5 profiles launch **silent en-US** (geo unsupported) — strong bot signal | HIGH | PROX-4 + loud UI warning until then |
| 16 | Deep-surface coverage shallower than narrative (WebGL string-only; pixel dead; worker HTTP UA leaks) | MED | ENG-3/5; pin personas to host GPU class |
| 17 | `rebase.sh` "track Chrome in days" never actually run (no `.pc/` in checkout) | MED | ENG-7 exercise quilt once |
| 18 | No kill-switch / DNS-leak protection | MED | PROX-8 + PROX-7 |
| 19 | Single-instance lock never releases (runner) / absent (desktop) | MED | RUN-3 + DSK-3 |
| 20 | Fail-open config — bad base64 → renderer reports **host** fingerprint silently | MED | launch-time CDP coherence self-check, abort on mismatch |
| 21 | Thin catalog (low entropy) + Apple-Silicon arch tell | MED | FP-6 + FP-3 |
| 22 | Local SQLite plaintext (proxy creds); non-revocable 7-day JWTs | MED | SEC-12 + SEC-13 |
| 23 | Docs actively mislead new implementers; two "source of truth" docs | MED | DOC-1 + DOC-2 |
| 24 | gitleaks weaker than documented; "exposed token" unlocated (may be a CI secret / sibling tree) | MED | SEC-16 + SEC-17 rotate regardless |
| 25 | PROJECT-STATUS itself has no enforced update cadence | MED | DOC-9 + agent-protocol rule (update in the same PR that moves a ticket) |
| 26 | CI WebRTC gate silently degrades to no-op when STUN unreachable | MED | annotate + fail where network expected |

---

## 8. Doc-management model (how to run this project deeply)

**Source-of-truth split (state it everywhere):** MASTER_PLAN = strategy/scope · **PROJECT-STATUS = live
status / what's-done (authoritative for maturity)** · specs = build-to reference · TRACEABILITY = proof
map. Companion docs to add (tracked as DOC-1..DOC-12 above): **TRACEABILITY.md** (the single most
valuable artifact — every pillar/gap → test/gate/file:line or "none"), **DEPENDENCIES.md** (added),
**DEVELOPING.md + ENVIRONMENT.md**, an **ADR index** for post-Day-2 decisions, **OWNERSHIP.md**,
**GLOSSARY.md + CHANGELOG.md**.

**Process guardrail (prevents re-staleness):** *PROJECT-STATUS.md must be updated in the same PR that
moves a ticket's state; specs' "Status vs target" and TRACEABILITY rows are reconciled whenever a
surface/feature lands.* This is the rule that stops the exact drift this audit had to correct.
