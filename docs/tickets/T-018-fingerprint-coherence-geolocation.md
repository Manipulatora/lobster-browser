# T-018 — Fingerprint coherence & geolocation-application hardening

**Pillar:** 1 · Profiles & Fingerprints (crown jewel) · **Assignee:** Claude · **Status:** done
**Closes:** the audit gap flagged in [`../GAP-ANALYSIS.md`](../GAP-ANALYSIS.md) (R2) that geolocation was
computed but never applied; hardens the coherence engine toward the rule set in
[`../specs/fingerprint-parameters.md`](../specs/fingerprint-parameters.md) §3.

## Goal

Make every JS-safe surface our model carries actually apply on a live page, coherently, and make the
coherence validator catch more real tells — without introducing any new detectability tell.

## What changed

1. **Geolocation is now applied (bug fix).** `applyCdpFingerprint` sends `Emulation.setGeolocationOverride`
   with the profile's coordinates when present, completing the geo-coherence cluster (timezone + locale +
   languages + geolocation all from the proxy exit IP). It was computed in `buildCdpEmulation` but never sent.
2. **`navigator.languages` is now clean.** The CDP UA override is given the clean comma-joined language list
   (`languages.join(',')`) rather than the q-weighted Accept-Language value, because Chromium derives
   `navigator.languages` from that string by a naive comma-split — a q-weighted value leaked `"de;q=0.9"`
   into `navigator.languages`. (Follow-up: restore a q-weighted **HTTP header** via a separate channel.)
3. **Init script hardened.** `buildFingerprintInitScript` now owns only the residual JS-only surfaces
   (`deviceMemory`, `maxTouchPoints`) with each override wrapped in try/catch. Previously it also tried to
   redefine `hardwareConcurrency`/`platform`/`languages` — which CDP pins **non-configurable**, so the
   `defineProperty` threw and **aborted the whole script**, silently leaving `deviceMemory` unset.
4. **Coherence engine hardened** (`validateFingerprintCoherence`), new rules: Sec-CH-UA brand major ↔ UA
   Chrome major; `uaFullVersion` major ↔ UA; `Sec-CH-UA-Platform` ↔ OS; `uaMobile` ↔ `maxTouchPoints`;
   `deviceMemory` on the spec ladder (capped at 8 — 16/32 is a hard tell); `hardwareConcurrency` 1–128;
   `colorDepth` ∈ {24,30}; `devicePixelRatio` 1–4; and **Windows NT < 10 cannot run Chrome ≥ 110**
   (kills the impossible "Windows 7 + Chrome 122" combo the generator emits).
5. **Generator normalization.** `deviceMemory` snapped onto the spec ladder, `colorDepth` snapped to 24/30,
   desktop `maxTouchPoints` forced to 0 (honest: the launched engine has no touch). Fallback pool RAM capped ≤ 8.
6. **Validation harness upgraded.** Derives → applies a Berlin proxy geo → grants geolocation permission →
   asserts the full geo cluster including a live `navigator.geolocation.getCurrentPosition` round-trip.

## Historical harness reality (honest)

patchright neutralizes main-world JS injection for stealth, so `deviceMemory`/`maxTouchPoints` are
best-effort in the old harness and become authoritative only when **Lobium** consumes them natively. The
harness reports `deviceMemory` but does not gate on it. Production must not rely on this CDP path.

## Acceptance criteria — all met

- [x] `Emulation.setGeolocationOverride` sent when (and only when) the profile carries coordinates.
- [x] `navigator.languages` is a clean ordered list (no q-values) that matches the profile.
- [x] The init script never aborts; CDP-owned surfaces are not re-defined from JS.
- [x] New coherence rules do not reject real generator data (50-seed × OS × engine sweep stays coherent; 300-seed Windows scan shows 0 impossible combos).
- [x] Deterministic: same seed + code → byte-identical fingerprint.

## Adversarial review round (multi-agent, 4 lenses × verify)

A workflow of independent reviewers (detectability / coherence-correctness / determinism / test-coverage),
each finding adversarially verified, surfaced **10 confirmed** issues (3 refuted) — all now fixed:

- **[HIGH] `deviceMemory: 0` → 0.25 GB.** The generator emits `deviceMemory === 0` for a slice of desktop
  samples; `?? 8` doesn't catch `0` (not nullish), so `normalizeDeviceMemory(0)` returned 0.25 (256 MB) —
  and the new ladder rule *laundered* it. Fixed: treat non-positive as unknown + floor desktops at 4 GB
  (`DESKTOP_MIN_DEVICE_MEMORY`), plus a coherence rule rejecting desktop `deviceMemory < 4`.
- **[HIGH] `HeadlessChrome` Sec-CH-UA brand accepted.** ~1/3500 profiles shipped `Sec-CH-UA: "HeadlessChrome"`
  authoritatively. Fixed: reject any foreign/automation brand + require a real Chrome/Chromium brand (kept
  permissive enough for legit Chromium-only Linux samples so the candidate pool doesn't starve).
- **[MED] Production never granted geolocation permission** (only the harness did) → `getCurrentPosition`
  would be denied in real launches. Fixed: the patchright launcher now grants it when the profile has geo.
- **[MED] `hardwareConcurrency` ceiling was OS-agnostic** (shipped 90+ cores on macOS). Fixed: OS-aware cap (macOS 56).
- **[MED/LOW] Test gaps:** behavioral init-script isolation test (real regression guard for the abort bug),
  `deriveFromPools` fallback-coherence test, clean-`acceptLanguage` assertion, desktop-RAM invariant.
- **[LOW] `devicePixelRatio < 1` wrongly rejected** real fractional-scaling/zoomed displays → allow `(0,4]`.
- **[LOW] False "100% of seeds" docs** corrected; the generator-path test now asserts *dominance* (≥90%),
  honest about the rare Linux fallback.

## Verification

- **94 unit tests** green (fingerprint 28, engine-runner 17, proxy 14, cookies 8, backend 27); build + typecheck + prettier clean.
- **Live gate** (`xvfb-run node ci/validation/run.mjs`) → `verdict: pass`: geolocation, clean languages,
  timezone, UA, hardwareConcurrency, webdriver all applied; 2 WebGL fails (native surface, Lobium — expected).
- **Generation quality scans:** 0 impossible OS/Chrome combos and 0 sub-4 GB desktops across 300+ derives.

## Follow-ups

- **T-018a:** q-weighted `Accept-Language` **HTTP header** (keep clean `navigator.languages`) via a header channel.
- **T-012 / Android:** Android device class (`uaMobile=true`, touch > 0, mobile platform) — the coherence
  rules already branch on form factor.
- **Lobium:** make `deviceMemory`/`maxTouchPoints` (and the deep surfaces) native + authoritative.
