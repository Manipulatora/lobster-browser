# Production Roadmap — Lobster Browser

> The detailed, phased plan from the current verified state to a **shippable, Octo-class, multi-OS
> anti-detect product**. Reads on top of [`PROJECT-STATUS.md`](PROJECT-STATUS.md) (current reality) and
> [`MASTER_PLAN.md`](MASTER_PLAN.md) (strategy). Every phase has an objective, a task list with IDs +
> acceptance criteria + effort, its dependencies, and the hardware/resources it needs. **Effort:** S <½d ·
> M ½–2d · L 2–5d · XL >1wk. **Owner:** Claude (engine/native/security/review) + Codex (UI/CRUD/tests).
>
> **Deployment model (decisive):** Lobster is a **desktop agent** — end users install it on their **own**
> Windows / macOS / Linux machines, each with its **own real GPU**. Profiles launch Lobium on the user's
> real hardware. This single fact drives the entire architecture below.

---

## 0. The architectural pivot: host-calibrated + farbled (read this first)

Because every profile runs on the **user's own real hardware**, the correct model is **not** "claim an
arbitrary device and synthesize its every signal" (Model B — what nobody fully achieves; you cannot make
an Intel iGPU render an RTX's exact pixels). It is:

> **Host-calibrated personas.** At setup, read the machine's *real* OS, GPU (renderer + caps + extension
> list), screen, cores, memory, fonts, timezone. Derive each profile's fingerprint **from that real host**,
> then apply the per-profile **farbling** (canvas/WebGL/audio noise) we already built. Every deep surface
> is coherent **by construction** — because it *is* the real machine — and unlinkable across profiles
> because the farbling seeds differ.

### Why this is the right model (and what it dissolves)

- **It eliminates the GPU-mismatch problem.** The WebGL renderer string, caps, extension list, and rendered
  pixels all describe one machine — the real one — so no cross-check can catch a "renderer says X, caps say
  Y" contradiction. The farbling makes each profile's pixel hash distinct + stable.
- **It dissolves ENG-8's hardest boundary.** We flagged "the extension list needs a per-GPU capture
  database." With host-calibration there is **no database** — we read the host's *actual* `getSupportedExtensions()`
  / precision / caps once and reuse them. The scalar-cap override I already built becomes a *normalizer*
  (round odd values to common ones), not a spoof.
- **It matches how the deep surfaces physically work.** Farbling perturbs a real render; it can't fabricate
  a foreign GPU's output. Host-calibration is the only coherent way to use farbling on real hardware.
- **It is how the incumbents actually operate.** Octo/Multilogin/AdsPower pin the deep/hardware surfaces to
  the host and vary the *safe* surfaces (UA/UA-CH/timezone/screen-window/languages) per profile. Unlinkability
  comes from farbling + the safe-surface variation, not from faking a different GPU.

### What each profile varies vs. inherits

| Surface | Per-profile (varies) | Host-inherited (calibrated) |
|---|---|---|
| Canvas / WebGL / Audio **pixel/DSP hash** | ✅ farbling seed (unlinkable, stable) | rendered on the real GPU |
| WebGL **renderer/vendor string** | — | the real host GPU (optionally masked to a common label) |
| WebGL **caps + extensions + precision** | — | the real host values (normalized) |
| **OS / platform / UA / UA-CH** | (must match host OS) | host OS + version |
| **Timezone / locale / languages / geo** | ✅ from the profile's **proxy exit IP** | — |
| **Screen** window size / DPR-window | ✅ plausible per-profile window | physical screen + real DPR/colorDepth |
| **Fonts** | ✅ subtract-only subset of the host's real set | host font set (OS-plausible) |
| hardwareConcurrency / deviceMemory | (bucketed) | host values |

**Consequence for the codebase:** the current `pools.ts` catalog (arbitrary Win/Mac/Linux device classes)
becomes the **fallback / reference** path — used when host-calibration can't run (e.g. a headless CI probe,
or a future "cloud profile"). The **primary** path becomes **host calibration** (new work, Phase 1). The
seed→coherent-persona machinery, coherence validator, config channel, and farbling all stay and are reused.

### The one honest limitation of this model

All profiles launched from **one physical machine** share that machine's GPU/OS/screen base (only the
farbling + safe surfaces differ). Two profiles from the same laptop are therefore *correlated at the GPU
class level* — plausible ("one person, many logins from their laptop"), but not "50 unrelated devices."
That is the **same trade-off every desktop anti-detect browser makes**, and it is acceptable for the target
market. True per-profile *distinct hardware* is only achievable with **cloud-run profiles** (Phase 5), where
each profile gets its own VM/GPU.

---

## 1. Current baseline (what's verified, from PROJECT-STATUS)

**Proven (on SwiftShader / this dev box):** from-source Chromium 152 fork; native config channel wired into
the product launcher; **surfaces:** navigator (UA/platform/hwc/deviceMemory/maxTouchPoints in all contexts
incl. workers), WebGL vendor/renderer + **pixel farbling** + **scalar caps override**, canvas farbling (4
readback paths), Web Audio farbling (offline + analyser **float + byte** + worklet/SPN), screen/DPR + macOS
availTop + colorDepth-30, native UA header + Sec-CH-UA metadata (arch/bitness/wow64), fonts via private
fontconfig (per-OS bundles). Coherence validator (arch⇔GPU, GPU-backend⇔OS, availTop, tz⇔locale, …). A live
detector gate + a 22/22-check battle-test. Local API hardened (default-deny + host-guard + constant-time).
**160+ unit/integration tests, 6 cargo tests.**

**Not yet real:** everything measured under `--enable-unsafe-swiftshader` (software render = a headless tell;
real hashes/caps/extensions unknown); no host-calibration; single-OS build (Linux); orchestrator largely
scaffolded (S3/Postgres stubs, GUI never run integrated, no packaging/signing, blobs plaintext); detector
matrix breadth + live anti-bot untested.

---

## 2. Target production architecture

```
END-USER MACHINE (Windows / macOS / Linux, real GPU)
┌──────────────────────────────────────────────────────────────────────┐
│  Lobster Desktop Agent (Rust/Tauri, signed installer, auto-update)     │
│   • Host Calibration Service  ── once per install ──▶ host profile     │
│       (real GPU renderer+caps+exts, OS, screen, cores, mem, fonts, tz) │
│   • Profile Store (SQLite, encrypted) + per-profile seed               │
│   • Proxy Manager (HTTP/SOCKS5, exit-IP geo)                           │
│   • Local Automation API (Axum, default-deny, keyed)                   │
│           │ JSON-RPC                                                    │
│   • Engine-runner sidecar (Node) ── derive persona = host ⊕ seed ⊕ geo │
│           │  writes lobium-fp.json + FONTCONFIG + --lobium-fp-config    │
│   • Lobium engine (per-OS signed build)  ◀── native farbling on the    │
│                                              machine's REAL GPU        │
└───────────────────────────┬────────────────────────────────────────────┘
                            │ HTTPS (auth, ENCRYPTED profile blobs, billing)
┌───────────────────────────▼────────────────────────────────────────────┐
│  Lobster Cloud (NestJS): auth · teams/RBAC · encrypted blob sync (S3)   │
│  · Stripe billing · audit · observability. Postgres + S3.               │
└─────────────────────────────────────────────────────────────────────────┘
```

The **new** production piece is the **Host Calibration Service**; everything else exists in some form today.

---

## 3. The validation lab (hardware you/we need)

Since end users span all three OSes, **each OS path must be validated on real consumer hardware** before it
ships. This is a *development/QA* requirement — production runs on users' own machines. Minimum lab:

| Machine | Purpose | Spec guidance |
|---|---|---|
| **Windows + consumer GPU** | Validate the dominant target (ANGLE D3D11 render, real caps/exts, detector scores) | Any real Windows 10/11 box with **Intel Iris Xe / UHD** *or* **NVIDIA GTX 1660 / RTX 3060**. A cheap Windows laptop is ideal (it *is* a real user machine). **Avoid** cloud data-center GPUs (Tesla T4/A10/A100/L4/V100) — instant tell. |
| **macOS (Apple Silicon)** | Validate the Metal path, arm64, P3 colorDepth, availTop | Any **M1/M2/M3** Mac (Mac mini M2 is the cheapest). |
| **Linux + consumer GPU** | Validate Mesa/ANGLE path; cheapest to rent | Vast.ai **RTX 3060 / GTX 1660** Linux instance (~$0.15–0.30/hr), or a local Linux box with a real GPU. This is also the primary **build/CI** host (it can build all three engines via cross-compile where supported, else one build box per OS). |

**Build note:** each OS needs its own Lobium build (Chromium cross-OS builds are impractical to fully
cross-compile). Plan: one build host per OS (or a CI matrix). First build ~6h/OS; incremental ~2min.

**Recommended order to acquire:** (1) the **Linux+RTX3060** box first — it unblocks real-GPU validation of
the engine + is the CI/build host; (2) a **cheap Windows laptop with an iGPU** — the dominant market; (3) a
**Mac mini M-series** — the Apple path. You can start Phase 1 with just #1.

---

## 4. Phased roadmap

Each phase is a shippable increment. Phases 1–2 are the engine's road to real-hardware-coherent; 3 is the
product; 4 is proof + hardening; 5 is scale. IDs prefixed `HC` (host-calibration), `RG` (real-GPU), plus the
existing ENG/FP/RUN/DSK/BE/PROX/QA/SEC/DOC from PROJECT-STATUS.

### Phase 0 — Validation lab + relink (days; needs: Linux+GPU box)

**Objective:** a real-GPU environment with the current engine running on it, so every later phase is measured
for real.

| ID | Task | Acceptance | Eff |
|---|---|---|---|
| RG-0 | Provision the Linux+RTX3060 box; clone repo; run `lobium/build.sh` (fetch Chromium 152 + apply patches + build) | `out/Lobium/chrome --version` OK; patches applied clean | M |
| RG-1 | Run the existing battle-test + detector gate on the **real GPU** (drop `--enable-unsafe-swiftshader`) | JSON report saved; record the true canvas/WebGL/audio hashes + WebGL caps/exts + CreepJS/Pixelscan baseline | M |
| RG-2 | Triage the delta vs SwiftShader: which tells vanish, which appear | a ranked findings list drives Phase 1 | S |

**Exit:** a committed, dated real-GPU baseline report. The "headless/software" signal is gone; we now know
the real numbers to iterate against.

### Phase 1 — Host-calibrated fingerprinting (the core engineering; 2–4 wks; needs: all 3 OS machines eventually, Linux to start)

**Objective:** profiles derive from the real host and are coherent-by-construction on real hardware, farbled
per profile. This is the heart of the pivot.

| ID | Task | Acceptance | Eff |
|---|---|---|---|
| HC-1 | **Host GPU probe**: launch the engine once (no spoof) at install/first-run and read the real `VENDOR/RENDERER/UNMASKED_*`, all overridden caps, `getSupportedExtensions()`, `getShaderPrecisionFormat()` buckets, `VERSION/SHADING_LANGUAGE_VERSION`; persist as the host GPU profile | on 3 machines the probe captures the real GPU identity; deterministic on repeat | L |
| HC-2 | **Host OS/screen/cores/mem/fonts/tz probe** (mostly OS APIs in the Rust core; fonts via the real fontconfig/queryLocalFonts; screen via the real `screen.*`) | captured host profile matches the machine on all 3 OSes | M |
| HC-3 | **Persona derivation from host**: rewrite `deriveFingerprint` so the **primary** path builds the persona from the host profile (GPU = host GPU, screen = host screen with a per-profile *window*, caps/exts = host, OS = host) ⊕ per-profile farbling seeds ⊕ proxy-geo. Keep `pools.ts` as the **fallback** (probe unavailable) | persona GPU/caps/exts == host; coherence validator passes; two profiles differ only in farbling + safe surfaces | L |
| HC-4 | **Extend the config channel + native** to carry the full captured GPU profile: real extension list + precision (new config fields), so `getSupportedExtensions`/`getShaderPrecisionFormat`/`VERSION`/`GLSL` are served from config (completes ENG-8 with *real* data, no database) | on real GPU: extension list + precision + version strings all == the host's real values, farbled pixels aside | L |
| HC-5 | **WebGL renderer masking policy**: decide per-OS whether to report the raw host renderer or a normalized common label (e.g. collapse driver-version/PCI-id noise) — validated against what real Chrome emits on that OS | renderer string byte-matches a real Chrome on the same GPU/OS (captured reference) | M |
| HC-6 | **Screen-window coherence**: per-profile the browser window is a plausible size within the host screen; `outerWidth/innerWidth/screenX/screenY/isExtended` all cohere with the persona screen (closes native audit L10) | window metrics never exceed the persona screen; `isExtended` persona-driven | M |
| FP-1 | Mobile/Android persona type (separate track; only if targeting mobile) | android emits `uaMobile:true`, mtp>0, mobile GPU; coherence passes | L |
| RG-3 | Re-run the battle-test on all 3 OS machines after HC-1..6 | 22/22 coherence checks pass **on real hardware**, all 3 OSes; extension list coherent | M |

**Exit:** on a real Windows/Mac/Linux machine, a launched profile is a coherent, farbled version of that
machine; the detector suite sees a real, self-consistent device with no software-render / mismatch tells.

### Phase 2 — Multi-OS engine builds, rebase, signing (2–4 wks; needs: build host per OS + code-signing certs)

**Objective:** signed, updatable Lobium binaries for Win/mac-Intel/mac-ARM/Linux, on a maintainable rebase.

| ID | Task | Acceptance | Eff |
|---|---|---|---|
| ENG-7a | Stand up a **build host per OS** (Win, mac, Linux); wire `build.sh`/`rebase.sh` on each | each produces `chrome` from the pinned ref + patch series | L |
| ENG-7b | **Prove the quilt rebase** on a real `.pc/`-managed checkout onto a newer Chrome ref | `rebase.sh` pops/refreshes/pushes; only hook patches ever reject | M |
| ENG-7c | **Cross-OS patch portability**: verify the config-channel + build-gn patches apply on all 3 OS Chromium trees (some hook files differ per platform) | patches apply (or per-OS variants captured) on all 3 | M |
| SEC-14a | **Code-signing**: Authenticode (Win) + Apple Developer ID + notarization (mac); Ed25519 updater signing | signed binaries pass SmartScreen/Gatekeeper on clean VMs | XL |
| ENG-7d | **Rebase automation** (CI): nightly attempt onto Chrome stable, report rejecting hooks | a bot PR/alert when a hook needs a human refresh | M |
| ENG-4/6b | Chrome branding parity check per OS (proprietary_codecs → `canPlayType` mp4; the "Google Chrome" brand already native) — enable `proprietary_codecs`/`ffmpeg_branding="Chrome"` if licensing permits | `canPlayType('video/mp4;…avc1…')` == "probably" like real Chrome | M |

**Exit:** a signed, notarized Lobium per OS, reproducible from the patch series, on an automated rebase.

### Phase 3 — Productization: make it a safe, installable product (3–5 wks; parallelizable, mostly no GPU)

**Objective:** the orchestrator around the engine becomes shippable + secure. These are the PROJECT-STATUS
P0/P1 product tasks; runnable in parallel with Phases 1–2.

| ID | Task | Acceptance | Eff |
|---|---|---|---|
| SEC-1 | **Client-side blob encryption** (AES-256-GCM, LBv1 envelope) — profiles are live sessions; today plaintext | wire/store bytes contain no cleartext cookie/domain (grep test); tamper fails decrypt | L |
| SEC-2 | **Key hierarchy + OS keychain** (Argon2id → wrapped team/profile keys; DPAPI/Keychain/Secret-Service) | two members unwrap the same team key; member-removal re-wraps | XL |
| SEC-12 | Local SQLite at-rest encryption (proxy creds today plaintext) | on-disk DB has no cleartext proxy password | L |
| DSK-1/2 | **Wire + first-run the desktop GUI** end-to-end (Launch button → sidecar → engine → CDP shown); first real integrated `tauri dev` on each OS; CI webview smoke | recording of Launch→running→Stop on real SQLite, all 3 OSes | M |
| DSK-5/11 | **Packaging + bundled sidecar + auto-update** per OS (MSI/NSIS, .dmg×2, .deb/.AppImage); resolve sidecar+engine from resources | clean-VM install launches with no system Node; updater verifies signature | XL |
| DSK-3 | Single-instance lock (tauri-plugin-single-instance) | 2nd launch focuses the 1st; no port/sqlite contention | S |
| BE-1 | **S3BlobStore** real impl (put/getLatest/head, atomic CAS) — today throws | MinIO: push→pull byte-identical; racing pushes → one 409; survives restart | L |
| BE-2 | **Prove Postgres/Prisma** path + CI Postgres service — never exercised | CI spins Postgres, migrate deploy, same e2e assertions pass vs Prisma | L |
| BE-3/4 | Persist `encryptedBlobRef` lifecycle + quota; **real Stripe** billing (raw-body webhook signature, Subscription write, plan-limit gate) | signed webhook flips tier + gate honors it; unsigned rejected | L |
| BE-5/7/9 | ApiKeyGuard wiring; member-removal/leave-team routes; Dockerfile + staging deploy | key-scoped routes 401 on revoke; staging serves `/health` | M |
| PROX-1/2/3/4 | **Cookie inject/export** into the launched context; expose `testProxy` to the UI; **SOCKS5 exit-geo** (today silent en-US) | cookie import → logged-in on a real site; UI proxy-test returns geo; SOCKS profile launches matching-exit locale | M×4 |
| PROX-8/7 | Proxy kill-switch (fail-closed) + DNS-leak/socks5h | proxy drop → no direct egress; DNS resolves only via proxy | L |
| RUN-2 | **Popup override gate** (`Target.setAutoAttach`+`waitForDebuggerOnStart`) — testable now on a **headful** machine (the reason it was deferred) | popup's first script sees the persona tz/locale, not host | M |
| SEC-6/7/8/9 | Observability (structured logs, `/metrics`, readiness, Sentry) + rate-limit/helmet | one JSON line/request; `/health/ready` 503 without DB in prod; forced 500 in Sentry | M |
| SEC-16/17 | Harden gitleaks (full-history + license + dep-audit); rotate the exposed PAT | fake `lb_live_` blocked; PAT confirmed rotated | S |

**Exit:** a signed installer that installs on a clean VM per OS, runs the GUI, launches a coherent profile
behind a proxy with encrypted sync — a real, safe product.

### Phase 4 — Prove it beats real detectors (2–4 wks; needs: residential proxies + anti-bot test tenants + all 3 OS machines)

**Objective:** an objective, trended Octo-class score against the systems that actually matter.

| ID | Task | Acceptance | Eff |
|---|---|---|---|
| QA-1 | Wire `lobium-detect.mjs` as a **blocking CI gate** on a self-hosted **real-GPU** runner per OS | non-zero exit on regression; JSON report archived | L |
| QA-3 | **E2E product-flow** CI: create→launch-behind-proxy→fingerprint-applied→WebRTC-egress==proxy-IP→external CDP connect→stop | one green job per OS | L |
| QA-4 | WebRTC no-leak behind a **live proxy** on real Lobium (srflx == proxy egress, v4+v6) | zero host-IP leak, gated | M |
| QA-5 | **Self-hosted detector breadth**: CreepJS trust/lies, Pixelscan "consistent", Iphey, browserleaks, FingerprintJS (visitorId stable-in-session / distinct-across / not-bot) | scored to `thresholds.json`, per OS | L |
| QA-6 | **Live anti-bot panel** (nightly): Cloudflare, DataDome, Akamai, Kasada, HUMAN — own-domain vendor targets behind residential proxies | trend **≥90% pass-rate per engine/OS**, alerting, kill-switch-gated | XL |
| QA-7 | Load/perf harness + NFR SLOs (cold-launch p50/p95, N concurrent/16GB, derive p99) | reports vs targets, nightly | L |
| FP-6/8 | Catalog/persona breadth for the **fallback** path + remaining navigator fields (vendor/oscpu/bitness/model) | fallback personas pass the same gates | M |

**Exit:** a dashboard showing ≥90% against ≥Cloudflare+DataDome per OS, trended — the defensible
"Octo-class" claim.

### Phase 5 — Beta → GA → scale (ongoing)

Private beta (dogfood + design partners) → public GA (signed installers, deployed backend, billing live) →
scale: **cloud-run profiles** (each profile its own VM/GPU — the only way to get *distinct hardware* per
profile), proxy marketplace/rotation, official SDKs (Py/JS/C#) + MCP server, granular RBAC/SSO, mobile
personas, human-input library, cookie warm-up/robot.

---

## 5. Critical path & sequencing

```
RG-0 (Linux+GPU box) ─▶ RG-1 real baseline ─▶ HC-1..6 host-calibration ─▶ RG-3 real-hardware coherence
                                                       │
   (parallel, no GPU) SEC-1/2 crypto · BE-1/2 durable · DSK-1/2 GUI · PROX-1/3/4 ─────────────┐
                                                       │                                       │
   ENG-7a..d multi-OS build + SEC-14 signing (needs certs + per-OS build hosts) ──────────────┤
                                                       ▼                                       ▼
                                   Phase 4 detector matrix + live anti-bot (needs proxies + tenants)
                                                       ▼
                                             Beta ─▶ GA ─▶ scale
```

**The one item that gates the most:** **HC-1..6 (host-calibration)** — it makes the engine coherent on real
hardware, which every detector claim depends on. It needs the Phase-0 GPU box. Start there.

**Longest procurement lead-times (start now, in parallel):** (a) the 3 OS validation/build machines, (b)
**code-signing certificates** (Authenticode + Apple Developer ID — days-to-weeks of identity verification),
(c) **residential proxies + anti-bot vendor test tenants** for Phase 4.

---

## 6. Risk register

| # | Risk | Sev | Mitigation |
|---|---|---|---|
| 1 | Host-calibration reveals a host surface we can't make coherent (e.g. an exotic GPU) | HIGH | Fallback to a normalized common GPU label for outliers; validate the top-N consumer GPUs first |
| 2 | Per-OS Chromium hook files differ → patch series forks per OS | HIGH | ENG-7c: capture per-OS patch variants; keep hooks minimal to limit drift |
| 3 | Code-signing identity/notarization delays ship | HIGH | Start cert acquisition in Phase 0; can dev/test unsigned, only GA needs it |
| 4 | Live anti-bots (Cloudflare/DataDome) block despite clean fingerprint (behavioral detection) | HIGH | QA-6 nightly + human-input library (Phase 5); behavior, not just fingerprint |
| 5 | Same-machine profiles correlate at GPU-class level | MED | Documented trade-off; cloud-run (Phase 5) for true per-profile hardware |
| 6 | Rebase treadmill: Chrome ships ~every 4 weeks | MED | ENG-7d automation; thin hooks; pin + rebase within days |
| 7 | Plaintext blobs/creds until SEC-1/2/12 | HIGH | Phase 3 P0; gate cloud sync behind encryption-present check |
| 8 | Real-GPU detector score unknown until RG-1 | HIGH | RG-1 is early + cheap; iterate from the real number, not assumptions |

---

## 7. Honest bottom line & what changes vs. the old plan

- The **hard part is genuinely built + proven** (native engine, farbling, coherence, config channel, launcher).
  The pivot to **host-calibration** makes it *coherent on real hardware* and **removes** the "need a per-GPU
  capture database" boundary — we read the real host instead.
- The distance to GA is now: **HC (real-hardware coherence)** → **multi-OS signed builds** → **productize
  (crypto, durable storage, packaging, GUI)** → **prove against real detectors**. None of it is blocked on
  unknown engineering; it's execution + a modest validation lab + certs + proxies.
- **Realistic timeline** with the current 2-agent setup + the lab: ~**Phase 1** 2–4 wks, **Phase 2** 2–4 wks
  (overlaps 1), **Phase 3** 3–5 wks (parallel), **Phase 4** 2–4 wks → a **credible private beta in ~2 months,
  GA in ~3–4 months**, given the machines/certs/proxies are procured up front.

**Immediate next actions:** (1) rent the **Linux + RTX 3060** box and do **RG-0/RG-1** (real baseline); (2)
start **code-signing cert** acquisition; (3) I begin **HC-1..3 host-calibration** (the primary Phase-1 work)
in parallel. Acquire the Windows laptop + Mac mini as Phase 1 progresses.
