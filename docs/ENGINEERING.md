# Lobium Engineering — Anti-Detect Engine, Fingerprint Model & Roadmap

The single source of truth for how the browser hides, how fingerprints are modeled, and the plan to reach
top-1%. Updated 2026-07-21.

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

Lobium is a **Chromium 152.0.7928.0** fork. Custom code lives in `components/lobium_fp/` (config parser +
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
- **fonts**: isolated via a private font pack + `FONTCONFIG_FILE`, so the observable font set matches the
  persona OS instead of the host.
- **timezone / locale / geolocation**: applied natively; derived from proxy geo.
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

- **Software gate (runs anywhere).** Offline coherence + automation-tell + distinctness probes:
  `battle-test.mjs` (loopback coherence probe incl. cross-context worker), `deep-probe-50.mjs` (50
  pure-native personas: surface application + no-automation-tells + coherence + distinctness),
  `regression-gate.mjs` (orchestrates the software checks vs committed baselines).
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

### W4 — Chrome-version tracking cadence — PLANNED (tooling, no hardware)
`scripts/track-upstream.mjs` queries the Chromium stable feed and flags when the pinned version lags;
harden `lobium/rebase.sh` to apply the patch series onto the new ref and fail loudly on rejects;
`scripts/bump-engine-version.mjs` updates `ENGINE_CHROME` + UA pins in lockstep; a version-coherence test
asserts UA major == build major. The rebase/build step needs the build host; the tooling is buildable now.

### W5 — Continuous detection regression on real-GPU — IN PROGRESS (infra) / HW-GATED (run)
Software tier (`regression-gate.mjs`) runs everywhere and covers automation-tells + coherence + surface
application vs baselines. Real-GPU tier (`gate.mjs` via `.github/workflows/real-gpu-gate.yml`) is the
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
trusted Input.* / DOM command through CdpBrowserDriver ── observe again
```

- **Browser-use ideas:** rich browser tools, numbered text-first perception, human handoff, and optional
  vision are implemented behind the project-owned `BrowserDriver`; no browser-use code or runtime is
  embedded.
- **OpenClaw ideas:** progressive skill disclosure and strict separation between untrusted page content,
  trusted harness history, and local memory. Skills are short read-only procedures, never webpage-supplied
  executable code.
- **Codex/Claude Code ideas:** least privilege, explicit consequential-action confirmation, bounded tools,
  cancellation, recovery after invalid/repeated actions, and secrets that are not echoed into transcripts.

### Trust boundaries and guarantees

- Page text is delimited as untrusted data. URLs are limited to HTTP(S), private/local destinations are
  blocked by default, an optional domain fence is enforced on explicit navigation and post-action drift,
  and cross-domain moves default to human confirmation.
- Password/OTP/payment/token fields expose only `filled` state. `ask {sensitive:true,targetId}` sends the
  reply directly from the UI to the measured field; it is never added to model history, UI action events,
  or run memory. CAPTCHA is a human handoff—there is intentionally no bypass service.
- Provider keys are stored in the Rust-owned encrypted SQLite secret table. The React webview receives
  only a `stored` boolean. Run memory uses a separately generated per-profile AES-256-GCM key, authenticated
  files, 0600 permissions, atomic replacement, and one-time migration of legacy plaintext records.
- File uploads are disabled unless absolute roots are explicitly configured; paths are canonicalized and
  checked after symlink resolution. Upload path strings are redacted from events and memory.
- The action loop has hard step/token bounds, abortable provider calls with retry/backoff, repeated-action
  detection, validation of every tool payload, high-impact action gates, and fail-closed provider/base-URL
  selection. Managed LLM mode remains disabled until an authenticated metering proxy exists.

### Browser coverage

The driver supports clicks (left/right/double), hover, humanized text/key input, native selects and custom
combobox fallback, scrolling, drag/drop, restricted file inputs, back navigation, multi-tab create/list/
switch/close, popup adoption, extraction, and screenshots. Perception walks visible controls in the top
document, open shadow roots, and accessible same-origin frames; cross-origin frames and inaccessible custom
canvas widgets use the explicit vision/human fallback.
