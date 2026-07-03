# Lobium hook points (the quilt series)

Each hook patch is a **small** diff into an existing Chromium file that routes a surface through
`lobium::LobiumFpConfig::Current()` (the reader in `../src/`). The insertion points + code are given
here so a build engineer finalizes them against the pinned checkout (`quilt push -f` → edit → `quilt
refresh`) — the exact line numbers shift per Chromium ref, which is why the series ships as intent +
code rather than frozen context diffs. Deep-surface hooks (canvas/WebGL/audio/TLS) are Phase 2.

## `core/build-gn.patch` — register the added module

`//third_party/lobium-fp/BUILD.gn` (added file) defines a `source_set("lobium_fp")` over
`lobium_fp_config.{h,cc}` (deps: `//base`). The hook adds that target to the deps of the components
that consume it (e.g. `//content/browser`, `//third_party/blink/renderer/core`), so the symbol links.

## `core/config-channel.patch` — accept the switch

Add `--lobium-fp-config` to the allowed switch list (`content/public/common/content_switches.cc` +
its header). No behavioral change on its own — `LobiumFpConfig::Current()` returns `nullptr` unless
the switch is present, so a stock launch is unchanged. The switch value is a path (0600 file the
sidecar wrote via `writeLobiumConfig`).

## `core/navigator-ua-ch.patch` — the first native surface (T-011 POC)

Route the navigator/UA-CH getters through the config. Illustrative hook in Blink's `NavigatorBase`
(`third_party/blink/renderer/core/frame/navigator_base.cc` and the UA-CH provider):

```cpp
// hardwareConcurrency:
unsigned NavigatorBase::hardwareConcurrency() const {
  if (const auto* cfg = lobium::LobiumFpConfig::Current();
      cfg && cfg->navigator.hardware_concurrency > 0) {
    return static_cast<unsigned>(cfg->navigator.hardware_concurrency);
  }
  return WebThreadScheduler::...;  // upstream default
}
// languages / platform / deviceMemory follow the same pattern; UA + Sec-CH-UA come from
// cfg->navigator.user_agent / ua_brands / ua_platform in the UserAgentMetadata provider.
```

Because these read the config **in C++**, there is no `Object.defineProperty` tell and no isolated-world
problem — the exact issue the interim (patchright) engine cannot solve. `screen`/`DPR` follow the same
shape (`fingerprint/screen-dpr.patch`).

## Verification (build machine)

After `build.sh --run`, launch with a config written by the sidecar and re-run
`ci/validation/run.mjs` against Lobium: `deepSurfaces.webgl.matchesClaim` flips to **true**, the
Sannysoft WebGL rows pass (drop `thresholds.sannysoft.maxFailed` 2 → 0), and CreepJS trust rises. That
harness is already wired (the detector matrix) so Lobium's arrival is objectively measurable.
