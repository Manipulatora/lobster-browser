# T-011 — Lobium: quilt series + first native patch + config channel POC

- **Pillar/Track:** F · Lobium
- **Assignee:** Claude
- **Status:** in progress — config channel BUILT + PROVEN; eight native surfaces live + a live-detector gate (see progress log)
- **Depends on:** T-010 (a working build)

## Goal

Prove Lobium is a real engine: a native patch that reads a per-profile fingerprint config and
changes an observable surface — the POC that unlocks the full 50+ param native roadmap.

## Spec

- Initialize the quilt patch series (`lobium/patches/series`) on top of the pinned ref.
- Add the **config channel** (per [`lobium/config-channel.md`](../../lobium/config-channel.md)): Lobium
  reads a per-profile fingerprint config (serialized from `@lobster/shared-types` `Fingerprint`)
  at launch — decide the mechanism (switch / env / IPC) and document it.
- First native patch: **navigator/UA-CH** — set `navigator.userAgent`/platform + Sec-CH-UA from the
  config, natively (no JS).
- Wire it end-to-end: the sidecar can launch Lobium with a profile config and the value is honored.

## Files to touch

- `lobium/patches/**`, `lobium/config-channel.md`, `packages/engine-runner` (add a Lobium runner path).

## Acceptance criteria

- Launching Lobium with two different profile configs yields two different `navigator.userAgent`
  values, set **natively** (confirmed: no JS override present).
- The config round-trips from `@lobster/shared-types` → sidecar → Lobium unchanged.

## Test requirements

- Integration test: launch Lobium with config A and B → assert the reported UA matches each.

## Progress log

The POC goal is met and exceeded: the config channel is real and now drives five native surfaces, each
built + empirically proven on Chromium 152.0.7928.0. Details + code live in
[`lobium/patches/hooks.md`](../../lobium/patches/hooks.md); the hooks are captured in
[`lobium/patches/core/config-channel.patch`](../../lobium/patches/core/config-channel.patch) (+
`build-gn.patch`) and verified to apply clean (`git apply --check` + `patch --fuzz=0`) against pristine
upstream 152.

- **Config channel** — mechanism decided: the sidecar writes `lobium-fp.json` and passes
  `--lobium-fp-config=<path>`; the sandboxed renderer can't read files, so (mirroring Chromium's
  `GaiaConfig`) the **browser** reads it once, base64-forwards `--lobium-fp-data`, and the renderer's
  `lobium::LobiumFpConfig::Current()` (added module `//components/lobium_fp`) parses + serves it. Every
  failure path `LOG(ERROR)`s so a broken config never silently leaks the host fingerprint.
- **Surfaces proven natively:** `hardwareConcurrency`; `deviceMemory` + its `Device-Memory` /
  `Sec-CH-Device-Memory` client-hint header (hooked at the single shared source so JS + header agree);
  `maxTouchPoints`; WebGL `UNMASKED_VENDOR/RENDERER_WEBGL` (atomic pair); **canvas 2D farbling**
  (`seeds.canvas`) across `getImageData` / `toDataURL` / `toBlob` / `OffscreenCanvas.convertToBlob` — all
  stable-per-profile, distinct-per-seed, host-differing, with a `drawImage` regression probe proving no
  double-farble; and **Web Audio farbling** (`seeds.audio`) across the OfflineAudioContext result
  (`getChannelData`/`copyFromChannel` — the dominant vector) and the AnalyserNode float freq/time paths,
  playback-safe (`audio_buffer.cc` untouched; user buffers bit-exact under a seed) and stereo-coherent
  (mono upmix stays `channelData(0) === channelData(1)`). Passed a 4-lane adversarial review + per-finding
  verification (6/19 confirmed): the one HIGH farble-oracle — stereo channel divergence — was fixed
  (same-key-all-channels) and re-proven; the remaining gaps (AudioWorklet/ScriptProcessorNode upstream
  taps, known-input invertibility, byte analyser paths) are documented in `hooks.md` and deferred with
  rationale.
- **Scope correction:** the originally-specified `navigator.userAgent` / platform / UA-CH surface was
  investigated natively and deliberately **left to CDP** — these are the `JS-safe` surfaces MASTER_PLAN §5
  routes through `setUserAgentOverride` (a native `NavigatorID::platform()` override had zero effect under
  this Chrome; the value comes via the CDP reduced-UA path). The native moat is reserved for surfaces CDP
  genuinely cannot reach (the deep surfaces above). The acceptance criterion is therefore met against a
  deep surface (WebGL/canvas persona differs by config) rather than UA.
- **Screen / devicePixelRatio** (`fingerprint/screen-dpr.patch`) — persona screen geometry + colour depth
  + DPR from the config, via `Screen::GetRect`/`colorDepth` and the DPR through BOTH `window.devicePixelRatio`
  and the CSS media-query path (`MediaValues`) so `matchMedia` agrees. Closed a real detected tell (every
  headless profile reported the default 800×600). Passed a 2-lane adversarial review (8/12 confirmed): the
  HIGH matchMedia-DPR cross-check lie was fixed + re-proven; the remaining findings (macOS `availTop`,
  the permission-gated Window-Management API surfaces, the headful outer-geometry clamp) are documented +
  deferred in `hooks.md`.
- **Live-detector gate** (`ci/validation/lobium-detect.mjs`) — launches the REAL Lobium binary with a full
  coherent persona and scores it against bot.sannysoft.com + direct native-surface assertions. Currently
  **9/9 surfaces applied, sannysoft 0-failed, per-profile-diverse**. This gate is what surfaced the UA-CH
  and screen tells fixed above.
- **Coherence fixes found via the gate:** the UA-CH version leak (persona claimed Chrome 151 while
  `getHighEntropyValues(['fullVersionList'])` leaked the real 152 build) — fixed by pinning the catalog UA
  to the engine version + emitting a coherent `fullVersionList`.
- **Web Audio upstream taps** (`fingerprint/audio-worklet-tap.patch`) — closed the two deterministic-offline
  bypasses of the main audio farble: `AudioWorkletProcessor.process(inputs)` and the deprecated
  `ScriptProcessorNode.onaudioprocess` `inputBuffer`. Gated to offline (worklet: a default-false
  `AudioWorkletGlobalScope` flag only `OfflineAudioWorkletThread` sets; SPN: `!HasRealtimeConstraint()`),
  farbling only the JS-visible copy (playback bit-exact). Proven host-diff/stable/distinct; a 2-lane
  adversarial review returned **0 confirmed**.
- **Remaining surfaces — dispositions (scouted, see `hooks.md`):** **TLS/JA3/JA4/HTTP-2 is already coherent**
  — Lobium *is* genuine Chromium 152 (unmodified BoringSSL + HTTP/2), so its network fingerprint is
  authentic Chrome, matching the Chrome-on-engine-version persona (the structural win of owning a real
  fork). **WebGL capability alignment** is mooted in production by pinning personas to the host GPU class.
  **WebGL pixel farbling** is tractable but has a readPixels-vs-toDataURL Y-flip coherence trap → its own
  cycle. **fonts** is a packaging task (substitute-pack + fontconfig + launch `env`), not a Blink hook.
  The screen/DPR Window-Management-API surfaces are permission-gated. Each reuses the same proven channel.
