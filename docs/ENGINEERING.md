# Lobium Engineering — Anti-Detect Engine, Fingerprint Model & Roadmap

The single source of truth for how the browser hides, how fingerprints are modeled, and the plan to reach
top-1%. Updated 2026-08-10.

## 1. Principles

1. **Spoof at the source.** Every observable fingerprint surface is set inside the engine (C++ / Blink),
   not by JavaScript injection or CDP overrides. JS/CDP spoofing is itself detectable; native spoofing is
   not.
2. **First-party orchestration.** The sidecar drives the browser through its own raw-DevTools WebSocket
   client (`packages/engine-runner/src/cdp-client.ts`) which never calls `Runtime.enable`/`Page.enable`.
   No third-party automation fork (patchright/Playwright) is in the product; patchright is a **dev-only**
   test dependency, not bundled.
3. **Coherence over quantity.** A fingerprint is only as good as its internal consistency: GPU ↔ OS ↔ UA ↔
   UA-CH ↔ screen ↔ fonts ↔ cores/memory must all agree. Every persona is validated for coherence.
4. **Never fake what we can't verify.** Deep-GPU surfaces and the real-GPU detection gate require real
   hardware; we do not claim a pass on software-rendered evidence.

## 2. The native engine (Lobium)

Lobium is a **Chromium 152.0.7977.42** fork (see §5 W4 for the version-pin contract; the previously
pinned 152.0.7928.0 was a canary nightly). Custom code lives in `components/lobium_fp/` (config parser +
appliers) and a small quilt patch series (`lobium/patches/series`). The launcher passes one JSON file per
profile via `--lobium-fp-config`; `LobiumFpConfig` parses it and applies each field at the relevant Blink
surface. Notable surfaces:

- **navigator**: userAgent, platform, hardwareConcurrency, deviceMemory, maxTouchPoints, languages,
  vendor, and full UA-Client-Hints (brands incl. GREASE, platform, platformVersion, mobile, fullVersion,
  model) — applied natively and coherently across main frame, iframes, and workers.
- **screen**: width/height/avail rect/colorDepth/devicePixelRatio.
- **WebGL**: unmasked vendor/renderer + deep caps (`MAX_*`, VERSION, SHADING_LANGUAGE_VERSION, extensions,
  shaderPrecision), intersected/clamped to the live backend so the reported surface is coherent. The
  masked `VENDOR`/`RENDERER` stay Chrome's constants ("WebKit"/"WebKit WebGL").
- **canvas / audio**: deterministic per-seed farbling (stable within a profile, distinct across profiles).
- **fonts**: isolated so the observable font set follows the persona OS rather than the host, through
  a different mechanism per platform. Linux uses a private font pack + `FONTCONFIG_FILE`. Windows has
  no fontconfig, so the engine filters font lookups natively in the browser process — the
  FontDataService family/local-font/enumeration entry points plus the DirectWrite proxy — and
  sideloads the same pack into its DirectWrite collection. Filtering can only subtract, so the pack is
  what supplies families the host lacks; see `lobium/hooks.md`.
  **Metric fidelity is partial and is a known tell.** The pack carries
  ~33 open faces, and a claimed family is aliased onto a metric clone where one exists (Arial→Liberation
  Sans, Times New Roman→Liberation Serif, Courier New→Liberation Mono, Calibri→Carlito,
  Cambria→Caladea). Everything else falls back to its serif/sans/mono class face, so on a Windows
  persona ~358 of 435 claimed families resolve to Liberation Sans and therefore report identical
  advance widths — where real Windows gives Verdana, Tahoma, Segoe UI, Trebuchet MS, Impact and Comic
  Sans MS six different ones. A width-probing detector can see that. Closing it needs metric-compatible
  faces in the pack for those families, not another mapping rule; `packages/engine-runner/src/fonts.ts`
  emits no alias it cannot back with a physically present face.
- **timezone / locale / geolocation**: applied natively; derived from proxy geo. Timezone is applied
  inside the engine (`TimeZoneController::OnTimeZoneChange`), not through the `TZ` environment
  variable: `TZ` is POSIX-only and ICU ignores it on Windows, where it reads the registry instead —
  so the environment route silently applied nothing on the Windows target.
- **WebRTC**: policy controls prevent local-IP leaks.
- **device emulation** (mobile profiles): a native device-frame view renders a phone/tablet; scrolling a
  zoomed device clips it under the toolbar (no chrome overlap).

The per-profile identity also rides the leading omnibox chip (the `--lobium-profile-name` switch) on
**every** page, while real security warnings still take precedence.

### Config channel

`--lobium-fp-config=<path>` → a JSON object whose top-level keys mirror the surfaces above. The sidecar
builds it from the profile's `Fingerprint` (`buildLobiumConfig`). Build capability probing
(`probeLobiumBuildCapabilities`) asserts the binary supports the required fields before launch.

## 3. The fingerprint model (`packages/fingerprint`)

`deriveFingerprint(seed: string, { os, engine: 'lobium', arch?, browserVersion? }): Fingerprint` is the
deterministic entry point (FNV-1a(seed) → mulberry32 RNG). The generated `Fingerprint` carries `navigator`,
`screen`, `webgl`, `locale`, `fonts`, `os`, `arch`.

- **Device catalog.** A large, coherent catalog backs derivation. Real renderer strings live in
  `catalog.generated.ts` (~1.8k Windows / ~1.6k Linux / ~200 macOS presets). `device-tiers.ts` classifies
  each renderer into a tier and pairs it with tier-plausible cores/memory/screen; `deriveCoherentDevice`
  seed-picks a coherent bundle. `derive.ts` blends ~85% generated / ~15% curated flagship classes from
  `pools.ts`. Result: **thousands** of distinct, coherent device classes per OS (verified: ~3,900 Win /
  ~1,840 mac / ~3,870 Linux distinct classes over 5,000 seeds), up from ~21.
- **Coherence.** `coherence.ts` (`validateFingerprintCoherence`) asserts GPU↔OS, DPR↔screen, tier↔hardware.
  `applyGeoToFingerprint` rewrites locale/timezone/languages from the resolved proxy geo.
- **Host calibration.** `deriveFingerprintFromHost` + `capture-host-calibration.ts` capture the real host
  GPU deep surfaces (via `cdp-client.ts`, no automation fork) so two profiles on one host share real
  hardware facts but keep distinct farbling — removing the deep-GPU cross-check tell on real hardware.
- **Android.** `deriveAndroidFingerprint` + `ANDROID_TEMPLATE` model real Google-Play devices; mobile
  profiles run under native touch/device emulation (no APK/ADB).
- **Version pinning.** `ENGINE_CHROME` (`pools.ts`) is the single source of the Chrome version; the UA and
  `fullVersionList` are pinned to the running build so a persona never claims a version the binary isn't.

## 4. Validation (`ci/validation`)

Two tiers:

- **Software gate (runs anywhere).** `regression-gate.mjs`: in-process coherence, per-OS device-class
  diversity floors, and the fingerprint unit contracts. No browser, no baseline file, no tell probe.
- **Engine gate (needs the native binary).** `battle-test.mjs` (per-persona surface application incl.
  cross-context worker coherence and the deep-GPU host-leak check) and `deep-probe-50.mjs` (50
  pure-native personas: surface application + no-automation-tells + distinctness, reading
  `ci/validation/fixtures/fp-probe.html`). Both launch Lobium, so neither belongs to the tier that runs
  anywhere; on a software renderer `battle-test.mjs` correctly reports the deep-GPU tell described in W1.
- **Agent browser gate (needs an engine, no model).** `ci/validation/e2e/agent-browser-e2e.mjs` drives the
  production loop and CDP driver against a real browser and a deterministic fixture origin whose answers
  are minted per boot. It reports which engine it ran on: the shipping Lobium binary is Gate-B evidence,
  an interim Chromium is browser-integration evidence only.
- **Real-GPU gate (release blocker, hardware-gated).** `gate.mjs` enforces "real-GPU, headless, zero lies";
  `detector-matrix.mjs` + `detector-matrix.json` grade 15 external tools (CreepJS, Sannysoft,
  BrowserLeaks, FingerprintJS, Pixelscan, IPHey, AmIUnique, BrowserScan, …) under an evidence policy that
  **forbids software renderers**. `creepjs-battle.mjs` / `lobium-detect.mjs` run the live battles.

The evidence policy deliberately rejects SwiftShader results, so a genuine detection pass requires real
GPU hardware.

## 5. Top-1% roadmap (five workstreams)

Legend: **DONE** · **IN PROGRESS** · **PLANNED** · **HW-GATED** (needs a real-GPU host).

### W1 — Real-GPU deep surfaces for preset renderers — PLANNED / HW-GATED
The engine already *applies* deep WebGL surfaces from config and *captures* the real host surfaces in host
mode. The gap is **data**: preset personas (claiming a GPU different from the host) need that GPU's real
deep surfaces. Build `scripts/capture-gpu-catalog.mjs` to capture `{renderer → {extensions, version, glsl,
precision, caps}}` across a real-GPU matrix and merge into `catalog.generated.ts`; derivation already
spreads `device.webgl`, so populated entries flow through with no further code. Capture needs real
hardware; the pipeline/schema are buildable and dry-runnable on SwiftShader now.

### W2 — Bigger coherent device catalog — DONE (verified)
Implemented as §3: thousands of coherent classes via `device-tiers.ts` + `deriveCoherentDevice`, blended
in `derive.ts`, guarded by coherence + distinctness tests. This was the biggest quality gap and is closed.

### W3 — TLS JA3/JA4 + HTTP/2 fingerprint — PLANNED (baseline already coherent)
Because Lobium **is** real Chromium 152, its ClientHello (BoringSSL cipher/extension order + GREASE) and
HTTP/2 SETTINGS/pseudo-header order already equal real Chrome 152 — the JA3/JA4/H2 hashes match by
construction, and the loopback proxy adapter tunnels TLS rather than terminating it. Work is therefore
**verification + lock**, not a rewrite: add `ci/validation/tls-fingerprint.mjs` to assert JA3/JA4/H2 == the
reference Chrome per release and gate on it. Per-persona rotation within Chrome-legal space is a later,
high-risk BoringSSL enhancement, only if a detector ever forces it.

### W4 — Chrome-version tracking cadence — DONE (tooling) / REBUILD PENDING (2026-08-14)
The tooling exists and is wired into CI:

- `scripts/track-upstream.mjs` — online. Compares the pin to the latest stable **and verifies channel
  membership** against the Chrome version-history API. Runs non-blocking in `ci.yml`.
- `ci/validation/version-coherence.test.mjs` — offline, blocking on every PR. Asserts
  `build.sh CHROMIUM_REF == ENGINE_CHROME.full`, that `major`/`reduced` follow it, that the pin has no
  `.0` patch component, and that `engine-manifest.json` either matches or carries an explicit
  `rebuildPending` declaration within the same milestone.
- `scripts/bump-engine-version.mjs` — moves all three pins in one command; refuses an unreleased build
  and refuses to touch the manifest without a real tarball digest.
- `lobium/rebase.sh` delegates the pin edit to that script, so a rebase can no longer desync the UA.

**Ordering matters more than freshness.** The pin was `152.0.7928.0` — a **canary nightly**. Because
canary is numerically ahead of stable, the old `behind = cmp(latest, pinned) > 0` check reported
"UP TO DATE" and exited 0, so version drift into an unreleased build was invisible to the tool built to
catch it. A canary build is a worse fingerprint than a stale one: `fullVersionList` returns the real
build, so a nightly nobody runs is close to a globally unique identifier, and its `.0` patch component
advertises it as a branch-point build. Both halves are now checked.

Current pin is `152.0.7977.42` (M152 beta-frozen; beta @ 100%, stable @ 0.5%, M152 scheduled stable
2026-08-25). The published engine tarball is still the old build — `engine-manifest.json` declares that
as `rebuildPending` and is finalized by re-running the bump script with `--tarball` after the build.

### W5 — Continuous detection regression on real-GPU — IN PROGRESS (infra) / HW-GATED (run)
Software tier (`regression-gate.mjs`) runs everywhere and covers coherence + catalog-diversity floors +
the fingerprint unit contracts. It does **not** cover automation-tells, surface application, or a
committed baseline — it reads no baseline file and launches no browser. Those live in the engine tier
below, which needs the native binary; wording claiming otherwise was wrong. Real-GPU tier (`gate.mjs` via `.github/workflows/real-gpu-gate.yml`) is the
release blocker; wire it to a self-hosted `real-gpu` runner on relevant PRs + a nightly schedule, persist
results, and fail on any new lie / renderer downgrade / headless-rating regression.

### Sequencing
W2 (done) → W4 + W5-software (tooling, now) → W3 baseline verify + W1 pipeline scaffold (now) → W1
real-GPU capture, W3 native rotation, W5 real-GPU gate (after real-GPU host access).

## 6. Environment ceiling

The current build/dev host has **no real GPU** (SwiftShader only) and no default proxy. W1 data capture and
the W5 live detection gate cannot execute here — only their code/schema can. Everything else (the catalog,
coherence, trackers, verification harnesses, CI definitions) is built and tested in software CI.

## 7. Web agent (`packages/agent`)

The agent is a bounded control loop, not a second automation framework:

```text
task + trusted local memory
        ↓
compact DOM/shadow/frame observation ── optional, explicit screenshot fallback
        ↓
forced structured `act` tool call (Anthropic/OpenAI/OpenRouter/xAI/Google)
        ↓
policy + risk gate ── human confirmation / secret handoff when required
        ↓
deterministic executor preflight
        ↓
durably journal dispatch immediately before first effect
        ↓
trusted Input.* / DOM command through CdpBrowserDriver ── fresh browser observation
```

- **Browser-use ideas:** rich browser tools, numbered text-first perception, human handoff, and optional
  vision are implemented behind the project-owned `BrowserDriver`; no browser-use code or runtime is
  embedded.
- **Claw Code ideas:** progressive skill disclosure and strict separation between untrusted page content,
  trusted harness history, and local memory. Skills are short read-only procedures, never webpage-supplied
  executable code. Learned procedures are scoped to a canonical site boundary and are not disclosed on
  unrelated hosts.
- **Codex/Claude Code ideas:** least privilege, bounded tools, cancellation, recovery after invalid or
  repeated actions, and secrets that are not echoed into transcripts. Commit-capable and consequential
  actions require a fresh, action-bound human approval in both autonomy modes; `confirm` additionally
  pauses before ordinary browser mutations.

### Trust boundaries and guarantees

- Page text and prior action-result details are delimited as untrusted data; page-derived labels, URLs,
  and refusal reasons never become harness instructions. Full URLs receive an in-memory opaque identity so
  approval and action freshness can distinguish resources whose redacted URLs look identical. Navigation
  URLs are limited to HTTP(S), private/local destinations are blocked by default, and an optional domain
  fence is enforced on explicit navigation and post-action drift. Domain fences use the ICANN and private
  Public Suffix List, so a scope such as `co.uk` or
  `github.io` is rejected instead of accidentally authorizing every tenant. Direct routes also resolve a
  destination before top-level navigation and reject the whole answer set if any address is non-public.
  Proxy routes skip a misleading local DNS check; hard isolation there requires an enforcing upstream
  exit-side ACL, which this agent layer does not currently prove.
  Cross-domain handling follows the run's autonomy: `confirm` gates a cross-domain move on a human, while
  `auto` allows it. A domain fence can bound an `auto` run. The panel persists and sends
  `allowedDomains`, `autonomy`, and `tokenBudget` through the bridge (all validated there); new installs
  default to review-before-changes and a 100,000-token ceiling, with an explicitly unrestricted domain
  field until the user supplies a fence.
- Password/OTP/payment/token fields expose only `filled` state. `ask {sensitive:true,targetId}` sends the
  reply directly from the UI to the measured field; it is never added to model history, UI action events,
  or run memory. Credential-shaped task text is rejected before model/storage access, and a model cannot
  place credential-shaped text through an ordinary typing action. CAPTCHA is a human handoff—there is
  intentionally no bypass service.
- Provider keys are stored in the Rust-owned encrypted SQLite secret table. The React webview receives
  only a `stored` boolean. Run memory uses a separately generated per-profile AES-256-GCM key, authenticated
  files, 0600 permissions, atomic replacement, strict wrong-key reads, and credential-scrubbing migration
  of legacy plaintext/encrypted records. A wrong-key append cannot overwrite the last known-good file. A
  path-authenticated encrypted run journal records only non-executable action digests and fsyncs a dispatch
  boundary after deterministic preflight and immediately before effects. Mutating browser actions then
  require a fresh readable observation with matching full-URL identity; this confirms current browser
  state, not semantic business success. Unexpected denied/rejected navigation uses a separately journaled,
  verified rollback. On restart, clean/pending/read-only checkpoints are closed without replay; ambiguous
  writes, consequential actions, failed navigation reconciliation, and unfinished sensitive handoffs block
  the next run. There is not yet a supported operator UI/API that can record a verified resolution and
  unblock admission; filesystem inspection alone is not a product-level recovery workflow.
- Encrypted thread history is authoritative, but the panel currently keeps a bounded, heuristically
  redacted plaintext availability/migration fallback in extension local storage (and standalone
  `localStorage`) when the encrypted thread cannot be verified. It is removed only after an exact encrypted
  counterpart is observed. This preserves a terminal result through transient failure, but it is not an
  encryption or arbitrary-PII confidentiality boundary and can persist if core thread persistence never
  succeeds.
- File uploads are disabled unless absolute roots are explicitly configured; paths are canonicalized and
  checked after symlink resolution. The filesystem root, user home, and equivalent dot/symlink aliases are
  rejected, and complete file contents are streamed through the credential/private-key detector before
  dispatch. Upload path strings are redacted from events and memory.
- The action loop has hard step/token bounds, a conservative per-request input reserve, dynamic output
  caps, provider-usage overage quarantine, abortable provider calls with retry/backoff, repeated-action
  detection, validation of every tool payload, blocked-action escalation, context-overflow recovery, and
  fail-closed provider/base-URL selection. Token accounting is a safety budget, not billing-grade local
  tokenization; provider-reported usage remains authoritative when returned. Managed LLM mode is
  IMPLEMENTED and is what the side panel
  uses: the sidecar talks to the backend `agent/llm` proxy, which holds the OpenRouter key server-side,
  authenticates every call with a Bearer token (`AgentProxyGuard`), pins the model to an allowlist, caps
  output tokens, and meters usage. The sidecar never sees a provider credential.
- **Confirmation, precisely.** Every commit-capable activation requires a fresh human approval in both
  autonomy modes: semantic and coordinate clicks (including right-click), keys, selects, drags, submits,
  uploads, and durable memory/skill writes. Actions additionally classified CONSEQUENTIAL — purchases,
  sends, deletions, account creation, permission changes, and site-data erasure — remain gated even when
  their UI shape is unusual (`actionRisk` in `policy.ts`). `auto` skips routine progress pauses; it never
  authorizes an externally visible commit. The line is COMMIT, not COMPOSITION: text may be entered only
  into a browser-verified text-entry control, while the activation that sends it is gated. Approval is
  bound to the exact action, page, semantic target, and (for coordinate actions) screenshot, then checked
  again immediately before dispatch.
  A gate is only safe because the pause can end: `waitForInput` has a timeout, and a panel-origin run
  with no panel attached fails immediately rather than waiting for an answer nobody can give.
- **Session isolation and retry safety.** One run per profile is enforced across manager instances and
  sidecar processes with an exclusive filesystem lease; only a provably dead owner is reclaimed. The
  panel-to-sidecar token travels in `x-lobee-token`, including the event stream, rather than in the URL.
  `/run` and `/input` carry body-bound request ids so one lost HTTP response can be retried without
  duplicating the run or human input. A transient missing bridge registry file does not erase the last
  authenticated profile identity, while a genuinely rotated identity terminates the stale run visibly.
  The extension token and memory directory are staged before browser launch so `bridge.json` can be loaded;
  the memory key and network route are committed only after launch succeeds. A successful owned stop revokes
  the registry entry. An out-of-band browser close currently evicts the runner handle but can leave that
  entry until a later successful relaunch-and-stop or sidecar restart.

### Browser coverage

The driver supports clicks (left/right/double), hover, humanized text/key input, native selects and custom
combobox fallback, scrolling, drag/drop, restricted file inputs, back navigation, multi-tab create/list/
switch/close, popup adoption, extraction, and screenshots. Perception walks visible controls in the top
document, open shadow roots, and accessible same-origin frames; cross-origin frames and inaccessible custom
canvas widgets use the explicit vision/human fallback.

The direct-navigation DNS preflight is defense in depth, not a browser-wide egress sandbox: redirect
chains, subresources, page-initiated navigation, service workers, DNS rebinding after the preflight, and
the proxy's eventual exit address remain browser/process or upstream-network enforcement work. These gaps
stay release-visible in `docs/LOBEE_AGENT_ROADMAP.md` rather than being described as solved by the agent
loop.

Perception and some semantic target checks currently evaluate DOM code in the page's main world. A hostile
page can monkeypatch those APIs; an isolated-world or browser-native accessibility extraction boundary is
future work. Likewise, a fresh post-effect observation is not an action-specific receipt: consequential
tasks still need task-local assertions or external receipts before Lobee can claim semantic completion.

The deterministic suites and grader tests establish contract and safety behavior, not live model/browser
capability. No paid self-hosted capability battery was run in this hardening pass; capability remains
unverified until that protected gate runs with the shipping browser and approved provider cohort.
