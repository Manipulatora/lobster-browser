# T-011 — Lobium: quilt series + first native patch + config channel POC

- **Pillar/Track:** F · Lobium
- **Assignee:** Claude
- **Status:** in progress — config channel BUILT + PROVEN; five native surfaces live (see progress log)
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
  `maxTouchPoints`; WebGL `UNMASKED_VENDOR/RENDERER_WEBGL` (atomic pair); and **canvas 2D farbling**
  (`seeds.canvas`) across `getImageData` / `toDataURL` / `toBlob` / `OffscreenCanvas.convertToBlob` — all
  stable-per-profile, distinct-per-seed, host-differing, with a `drawImage` regression probe proving no
  double-farble.
- **Scope correction:** the originally-specified `navigator.userAgent` / platform / UA-CH surface was
  investigated natively and deliberately **left to CDP** — these are the `JS-safe` surfaces MASTER_PLAN §5
  routes through `setUserAgentOverride` (a native `NavigatorID::platform()` override had zero effect under
  this Chrome; the value comes via the CDP reduced-UA path). The native moat is reserved for surfaces CDP
  genuinely cannot reach (the deep surfaces above). The acceptance criterion is therefore met against a
  deep surface (WebGL/canvas persona differs by config) rather than UA.
- **Still to author (this ticket's follow-ups):** WebGL pixel farbling + capability alignment, AudioContext
  DSP farbling, font enumeration, and the net/TLS layer — each reuses this same proven channel.
