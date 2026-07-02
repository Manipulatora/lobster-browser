# SPEC — Lobium build & native-patch plan

> **Scope:** the detailed build pipeline, GN configuration, native fingerprint **patch series**, the
> per-profile **config channel** wire protocol, build **infrastructure**, multi-OS packaging/signing,
> **rebase automation**, the **mobile** variant, and per-patch **verification** for **Lobium** — our
> own Chromium-based engine ("Lobium", formerly "kernel").
> **Read first:** [MASTER_PLAN](../MASTER_PLAN.md) (§5 fingerprint model, §10 Track F),
> [ADR-0003](../adr/ADR-0003-engine-strategy.md) (two-engine strategy),
> [ADR-0004](../adr/ADR-0004-lobium.md) (Lobium decision),
> [`lobium/config-channel.md`](../../lobium/config-channel.md),
> [`lobium/patches/README.md`](../../lobium/patches/README.md).
> **Companion source:** `packages/shared-types/src/fingerprint.ts` (the `Fingerprint` model this whole
> engine consumes), `packages/engine-runner/src/runners/types.ts` (the launcher contract Lobium plugs
> into), `docs/contracts/sidecar-ipc.md` (`launch`/`startProfile`).

**Honest status up front.** Today `lobium/` contains a *scaffold*: a dry-run `build.sh`, an example
`gn-args.gn.example`, an **empty** `patches/series`, and prose specs (`config-channel.md`,
`patches/README.md`). No Chromium tree has been fetched, no patch has been written, no binary exists.
The interim `chromium` engine (ungoogled + patchright) carries the product today, and the `lobium`
engine kind is served by that same patched Chromium until this plan is executed. This document is the
**target** design plus the concrete first steps (tickets **T-010**, **T-011**). Every subsection is
tagged **status: done / partial / planned**.

---

## 0. Terminology & conventions

| Term | Meaning |
|---|---|
| **Lobium** | Our own Chromium fork + native patches. Flagship engine. Formerly "kernel". |
| **Chromium (interim)** | Prebuilt ungoogled-chromium driven via patchright. Everyday engine, also serves `lobium` until the native build ships. |
| **Farbling** | Deterministic, seed-driven perturbation of a fingerprint surface (Brave's term), used here for canvas/WebGL/audio. |
| **Config channel** | The native mechanism carrying the per-profile `Fingerprint` into the C++ engine (§4). |
| **Pinned ref** | The exact upstream Chromium git revision Lobium is built from (`CHROMIUM_REF`). |
| **Detector matrix** | CreepJS · Pixelscan · Sannysoft · Iphey · browserleaks · FingerprintJS + WebRTC/coherence, wired into CI (`ci/validation/`). |

Source-area references use upstream Chromium paths relative to `src/`, e.g. `third_party/blink/renderer/…`,
`net/…`, `media/…`. These are stable enough to plan against; exact line anchors are pinned per ref in
each patch header.

---

## 1. Base + pipeline

**status: partial** (scaffold `build.sh` dry-run exists; real fetch/sync/patch/gn/ninja lands in T-010).

### 1.1 Toolchain

| Component | Choice | Notes |
|---|---|---|
| Source manager | `depot_tools` (`fetch`, `gclient`, `gn`, `autoninja`) | Pinned to a known-good commit; vendored PATH entry on the build host. |
| Base tree | Upstream Chromium via `fetch --nohooks chromium` | We fork upstream directly (not ungoogled-chromium) and *borrow* ungoogled's patch **discipline** (quilt series), per ADR-0004 §Decision and MASTER_PLAN §12.1. |
| Patch model | **quilt** (`series` + numbered/foldered `.patch` files) | ungoogled-style; human-reviewable; rebasable. |
| Build | GN + `autoninja` (`ninja` + reclient wrapper) | §2 GN args. |
| Compiler | Chromium-bundled clang/lld toolchain (`//tools/clang`) | Do **not** use system clang; matches upstream ABI + PGO. |

### 1.2 Pinned Chromium ref + rebase cadence

- **`CHROMIUM_REF`** is pinned in `lobium/build.sh` (currently the placeholder `CONFIRM_IN_T-010`).
  Pin an exact **tag** matching a Chrome **stable** release, e.g. `refs/tags/131.0.6778.86`, recorded
  in `lobium/BASELINE.md` (new file, T-010) with: tag, upstream commit SHA, `chrome_version`, date,
  and the `depot_tools` commit used.
- **The moat is cadence.** Target: **rebase to the new Chrome stable within 3 business days** of its
  public release (Octo/Multilogin operate on a similar window). Rebase automation in §7 makes this
  routine, not heroic.
- Rebasing = re-pin `CHROMIUM_REF`, `gclient sync`, `quilt push -a` against the new tree, fix rejects,
  rebuild, run the detector matrix, ship. Every patch header records the ref it was last verified on.

### 1.3 Pipeline stages (what `build.sh --run` will do — T-010)

```
0. ensure depot_tools on PATH; ensure disk (≥120 GB) + RAM (≥32 GB) available
1. fetch chromium              # first time only; ~100 GB checkout + history
2. gclient sync --revision src@$CHROMIUM_REF --with_branch_heads --with_tags
3. (cd src && quilt push -a)   # apply lobium/patches/series onto the pinned tree
4. gn gen out/Lobium --args="$(cat lobium/gn-args.$OS.gn)"
5. autoninja -C out/Lobium chrome            # (+ chrome_sandbox, chromedriver as needed)
6. lobium/scripts/package.$OS.sh out/Lobium  # rebrand + zip/dmg/msi (§6)
7. lobium/scripts/smoke.sh out/Lobium/chrome # headless --version + config-channel POC probe
```

Guardrails already in the scaffold: refuses `--run` while `CHROMIUM_REF` is a `CONFIRM*` placeholder;
dry-run by default. Keep both.

### 1.4 Directory layout (target)

```
lobium/
  BASELINE.md              # pinned ref + toolchain versions (new, T-010)
  build.sh                 # driver (scaffold today; real in T-010)
  gn-args.gn.example       # generic example (exists)
  gn-args.linux.gn         # per-OS arg files (new)
  gn-args.win.gn
  gn-args.mac.gn
  config-channel.md        # wire-protocol prose (exists) — schema formalized in §4
  patches/
    series                 # ordered apply list (exists, empty)
    README.md              # conventions (exists)
    core/                  # config channel + plumbing patches
    fingerprint/           # per-surface farbling/spoof patches
    net/                   # BoringSSL/TLS/HTTP2 patches
    branding/              # rebrand (name/icons/version) — non-fingerprint
  scripts/
    rebase.sh              # §7 automation
    package.<os>.sh        # §6
    sign.<os>.sh           # §6
    smoke.sh               # §9 boot + config probe
  third_party/
    lobium-fp/             # our C++ helper lib (seeded PRNG, config parser) added via GN
```

The C++ we add lives in a **new component** `third_party/lobium-fp/` (a GN `source_set`) so most of
our logic is *added files*, not edits to upstream files — this minimizes rebase-time rejects. Patches
into upstream files are kept to **call-site hooks** that delegate into `lobium_fp::…`.

---

## 2. GN args (concrete release set)

**status: partial** (`gn-args.gn.example` has the skeleton; the full set below is the target).

Release build (`gn-args.linux.gn`, adapt per OS):

```gn
# --- Release / official ---
is_debug = false
is_official_build = true
is_component_build = false
symbol_level = 0
blink_symbol_level = 0
dcheck_always_on = false

# --- Strip Google entanglement (ungoogled posture, our own build) ---
google_api_key = ""
google_default_client_id = ""
google_default_client_secret = ""
enable_hangout_services_extension = false
enable_remoting = false
enable_reporting = false
safe_browsing_mode = 0
enable_mdns = false
use_official_google_api_keys = false

# --- Media / codecs (Chrome-family footprint must match the UA claim) ---
proprietary_codecs = true
ffmpeg_branding = "Chrome"
enable_widevine = false          # revisit for DRM sites; off for v1

# --- Fingerprint-relevant toggles ---
enable_nacl = false
blink_enable_generated_code_formatting = false
# WebGL/WebGPU/Audio stay ON — we patch their *values*, not disable them:
#   (no use_dawn=false; WebGPU adapter is spoofed natively, §3.13)

# --- Build speed (see §5) ---
use_remoteexec = true            # reclient; else set cc_wrapper = "ccache"
# cc_wrapper = "ccache"          # local fallback when reclient unavailable
chrome_pgo_phase = 0             # skip PGO for iteration builds; = 1/2 for release-grade
thin_lto_enable_optimizations = true

# --- Target ---
target_cpu = "x64"               # "arm64" for Apple Silicon / ARM Linux
# target_os inferred by host; set explicitly for cross builds
```

Per-OS deltas: Windows adds `is_clang = true`, `use_lld = true`; mac adds
`mac_deployment_target`, `use_system_xcode = false`; Apple-Silicon sets `target_cpu = "arm64"`.
Release-grade artifacts flip `chrome_pgo_phase = 2` (needs a profiling run) — kept off for
iteration builds to protect compile budgets (§5).

**Rule:** we never *disable* a fingerprint surface to hide it (that itself is a tell). Every
surface stays enabled and returns a **coherent spoofed value**.

---

## 3. The patch series

**status: planned** (series is empty; T-011 lands the first two: `core/config-channel` +
`fingerprint/navigator-ua-ch`). Ordered exactly as `lobium/patches/series` will list them.

Each patch: small, one domain, header comment naming (a) the surface, (b) the upstream source area,
(c) how it reads the per-profile config via `lobium_fp::Config` (§4), (d) the detector(s) that verify
it (§9), (e) the ref last verified on. Apply order matters: `core/` first (config must exist before any
consumer reads it), then `fingerprint/`, then `net/`, then `branding/`.

### 3.0 Series (apply order)

```
core/00-config-channel.patch
core/01-seeded-prng.patch
fingerprint/10-navigator-ua-ch.patch
fingerprint/11-screen-dpr.patch
fingerprint/12-timezone-locale.patch
fingerprint/13-fonts.patch
fingerprint/14-hardware-concurrency-memory.patch
fingerprint/15-canvas-farbling.patch
fingerprint/16-webgl-vendor-renderer-params.patch
fingerprint/17-webgl-pixel-hash.patch
fingerprint/18-audiocontext-dsp.patch
fingerprint/19-webgpu-adapter.patch
net/20-webrtc-ip.patch
net/21-boringssl-tls-ja3-ja4.patch
net/22-http2-settings-priority-header-order.patch
branding/30-rebrand.patch
```

### 3.1 `core/00-config-channel` — the plumbing everything depends on

**status: planned (T-011).** Adds `third_party/lobium-fp/` (config parser + a process-wide
`lobium_fp::Config` singleton), a command-line switch `--lobium-fp-config=<path>` registered in
`chrome/common/chrome_switches.*`, and propagation of the parsed config to renderer/GPU/utility
processes. See §4 for the wire format and per-process delivery. **No fingerprint patch reads config
until this lands.**

### 3.2 `core/01-seeded-prng` — deterministic noise source

**status: planned.** A tiny, header-only `lobium_fp::Prng` (e.g. SplitMix64/xoshiro) seeded from
`config.seed` mixed with a per-domain salt (`"canvas"`, `"audio"`, `"webgl"`). Every farbling patch
draws from this so a profile is **stable across restarts** and **stable within a session** (no
per-call variance — MASTER_PLAN §5 rule 4), yet each surface is decorrelated. Mirrors the JS-side
`packages/fingerprint/src/prng.ts` contract so native and JS-safe layers agree.

### Patch table

| # | Patch | Surface (params) | Source area | Approach | Reads from config |
|---|---|---|---|---|---|
| 10 | navigator-ua-ch | `navigator.userAgent/platform/vendor/appVersion`, `navigator.userAgentData` (Sec-CH-UA brands + GREASE, mobile, platform, platformVersion, fullVersion) | `content/browser/…/user_agent`, `third_party/blink/renderer/core/frame/navigator*.cc`, `components/embedder_support/user_agent_utils.cc`, `services/network/…` for request headers | Override the UA string builder + the `UserAgentMetadata` struct at its source so `navigator.*`, the `User-Agent` header, and every `Sec-CH-UA*` request header derive from **one** config-driven value (no JS, no divergence). | `navigator.userAgent`, `uaBrands`, `uaPlatform`, `uaPlatformVersion`, `uaMobile`, `uaFullVersion`, `platform` |
| 11 | screen-dpr | `screen.width/height/availWidth/availHeight/colorDepth`, `window.devicePixelRatio`, `matchMedia` resolution/color-gamut | `third_party/blink/renderer/core/frame/screen.cc`, `.../local_dom_window.cc`, `display/` via `ScreenInfo` | Feed a synthetic `ScreenInfo`/`display::Display` from config so screen + DPR + `matchMedia` are internally consistent and independent of the host monitor. | `screen.*`, `screen.devicePixelRatio` |
| 12 | timezone-locale | `Intl` timezone, `Date` offset, `navigator.language(s)`, `Accept-Language` | `third_party/blink/renderer/core/timezone/…`, `third_party/icu` timezone default, `third_party/blink/.../navigator_language.cc`, ICU locale default | Set the process ICU default timezone + locale from config so `Intl`, `Date`, and `navigator.languages` all agree — native equivalent of the CDP `setTimezoneOverride`/`setLocaleOverride` we use on interim Chromium, but tell-free. | `locale.timezone`, `locale.locale`, `navigator.languages`, `locale.acceptLanguage` |
| 13 | fonts | Font enumeration + metrics (`document.fonts`, canvas text metrics, CSS font matching) | `third_party/blink/renderer/platform/fonts/…`, platform `FontCache` (`font_cache_{win,mac,linux}.cc`), skia font manager | Filter the platform font enumeration to the config's allow-list matched to the claimed OS, and block probing of unlisted fonts (fallback deterministically). Prevents an OS-mismatched font set from betraying the UA. | `fonts[]`, `os` |
| 14 | hardware-concurrency-memory | `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `navigator.maxTouchPoints` | `third_party/blink/renderer/core/frame/navigator_concurrent_hardware.cc`, `.../navigator_device_memory.cc`, `.../navigator.cc` (touch), also worker global scopes | Return config values from the getters in **all** contexts (window + workers), so a worker can't leak the real core count. | `navigator.hardwareConcurrency`, `navigator.deviceMemory`, `navigator.maxTouchPoints` |
| 15 | canvas-farbling | 2D `toDataURL`/`toBlob`/`getImageData`, `measureText` metrics | `third_party/blink/renderer/modules/canvas/…` (`canvas_rendering_context_2d.cc`, `base_rendering_context_2d.cc`), `platform/graphics/…`, `OffscreenCanvas` module, worker/iframe globals | Seeded per-pixel perturbation applied at readback (Brave-style farbling): near-imperceptible, deterministic per profile+session, applied uniformly in **main frame, iframes, dedicated/shared/service workers, and OffscreenCanvas**. Text metrics get a matching seeded jitter. | `seed` (canvas salt) |
| 16 | webgl-vendor-renderer-params | `UNMASKED_VENDOR_WEBGL`, `UNMASKED_RENDERER_WEBGL`, `getParameter`/`getShaderPrecisionFormat`/extension list | `third_party/blink/renderer/modules/webgl/webgl_rendering_context_base.cc`, GPU info in `gpu/config/…`, `services/…/gpu` | Override the strings + the numeric/param/extension surface from config so the GPU story matches the claimed device (not the host GPU). | `webgl.vendor/renderer/unmaskedVendor/unmaskedRenderer`, plus a device profile keyed off them |
| 17 | webgl-pixel-hash | `readPixels` / `toDataURL` of a WebGL scene (the rendered-hash vector) | same modules as 16 + `gpu/command_buffer/…` readback path | Seeded perturbation on WebGL readback analogous to canvas farbling, so the rendered-image hash is stable-per-profile but not host-identifying. | `seed` (webgl salt) |
| 18 | audiocontext-dsp | `AudioContext`/`OfflineAudioContext` DSP fingerprint, `sampleRate`, `baseLatency` | `third_party/blink/renderer/modules/webaudio/…`, `media/…` audio params | Seeded micro-perturbation in the audio DSP output path + config-driven `sampleRate`/`baseLatency`, deterministic per profile. | `seed` (audio salt), audio device profile |
| 19 | webgpu-adapter | `GPUAdapter` name/vendor, `requestAdapterInfo`, `limits`, `features` | `third_party/blink/renderer/modules/webgpu/…`, `third_party/dawn` adapter info | Report a config-driven adapter identity + coherent limits/features (must match the WebGL device story). P2 — lands after core surfaces. | webgpu device profile (derived from `webgl` device) |
| 20 | webrtc-ip | ICE candidate IPs (mDNS/host/srflx) so the public IP == proxy exit IP, no local-IP leak | `third_party/blink/renderer/modules/peerconnection/…`, `third_party/webrtc`, `content/browser/…/webrtc` | Force the effective ICE policy natively (proxy-only / default route hidden) so WebRTC never leaks the real or local IP behind the proxy. Native equivalent of the interim policy. | WebRTC policy flag + proxy awareness |
| 21 | boringssl-tls-ja3-ja4 | TLS ClientHello shape → **JA3/JA4** (cipher list/order, extensions/order, curves, sig-algs, ALPN, GREASE) | `net/socket/ssl_client_socket_impl.cc`, `net/ssl/…`, `third_party/boringssl` | Pin the ClientHello assembly to reproduce the exact JA3/JA4 of the claimed Chrome build (extension ordering, GREASE placement, supported_groups). Config selects the TLS profile keyed to the UA-claimed version. | TLS profile (derived from claimed Chrome version) |
| 22 | http2-settings-priority-header-order | HTTP/2 `SETTINGS` values/order, PRIORITY/stream-dependency behavior, pseudo-header + request-header **order** | `net/spdy/…`, `net/http/http_network_transaction.cc`, `net/third_party/quiche` | Emit the SETTINGS frame, priority tree, and header ordering that match the claimed Chrome build's network signature. | HTTP/2 profile (derived from claimed Chrome version) |
| 30 | rebrand | Product name/icons/version strings (non-fingerprint) | `chrome/app/theme/…`, `chrome/browser/…`, version files | Rebrand to "Lobium" for distribution. **Must not** alter any fingerprint-visible string that a site reads (UA version stays Chrome-coherent — driven by patch 10, not here). | — |

**Design invariants across all fingerprint patches:**
1. **One config, one machine story** — every patch reads the *same* `Fingerprint`, so surfaces can't
   contradict each other (MASTER_PLAN §6 coherence bar).
2. **All execution contexts** — main frame, iframes, and workers (dedicated/shared/service) each apply
   the same values; a surface leaking in a worker is a top detector tell (CreepJS checks this).
3. **Seeded, session-stable** — deep surfaces perturb deterministically from `seed`; no per-call RNG.
4. **Value-substitution, not feature-removal** — surfaces stay present and plausible.

---

## 4. The config-channel wire protocol

**status: planned (mechanism chosen in T-011).** How the 50+ params reach C++.

### 4.1 Mechanism (decision)

**Primary: a launch-time config file referenced by a command-line switch** —
`--lobium-fp-config=<abs-path-to-json>` — with the file readable only by the current user
(0600). Rationale:
- **Size:** the full `Fingerprint` (fonts list, UA-CH brands, WebGL params) exceeds a comfortable
  single-switch length; a file sidesteps command-line length limits and keeps the value off the
  process list (`ps`/Task Manager), where a raw switch would leak the fingerprint.
- **Simplicity + testability:** the sidecar already writes a per-profile `userDataDir`; it writes
  `userDataDir/lobium-fp.json` next to it and passes the path. No socket lifecycle to manage at launch.
- **Rejected alternatives:** raw `--switch=<json>` (leaks via process list, length-limited); env var
  (leaks to child processes, visible in some tooling); a live IPC socket (needed only for *runtime*
  re-config, which v1 doesn't require — the fingerprint is fixed for a session).

**Future (P2): an optional local IPC** (a mojo endpoint / unix socket) for **runtime** updates
(e.g. rotating WebRTC policy without relaunch). Not in v1.

Delivery to child processes: the browser process parses the file once into `lobium_fp::Config`, then
propagates the parsed struct to renderer/GPU/utility processes via the existing command-line +
mojo plumbing (patch `core/00`), so each process constructs its own `Config` without re-reading the
file. Renderers get only the subset they need (deep-surface seeds + navigator values), never proxy
credentials.

### 4.2 Schema

Serialized directly from `@lobster/shared-types` `Fingerprint` (see `packages/shared-types/src/fingerprint.ts`)
plus a small Lobium envelope. The **param model does not fork** — Lobium consumes the same object the
editor UI and sidecar use (MASTER_PLAN §5 rule 5; `config-channel.md` "Contract stability").

```jsonc
{
  "version": 1,                     // envelope version; bump on breaking schema change
  "profileId": "uuid",
  "seed": "deadbeef…",              // FingerprintSeed (hex) — drives all seeded farbling
  "fingerprint": {                  // === @lobster/shared-types Fingerprint, verbatim ===
    "os": "windows",                // OsFamily
    "arch": "x86_64",               // CpuArch
    "navigator": {
      "userAgent": "Mozilla/5.0 …",
      "platform": "Win32",
      "languages": ["en-US", "en"],
      "hardwareConcurrency": 8,
      "deviceMemory": 8,
      "maxTouchPoints": 0,
      "uaBrands": [{ "brand": "Chromium", "version": "131" }, { "brand": "Not_A Brand", "version": "24" }],
      "uaPlatform": "Windows",
      "uaPlatformVersion": "15.0.0",
      "uaMobile": false,
      "uaFullVersion": "131.0.6778.86"
    },
    "screen": { "width": 1920, "height": 1080, "availWidth": 1920, "availHeight": 1040,
                "colorDepth": 24, "devicePixelRatio": 1 },
    "webgl": { "vendor": "Google Inc. (NVIDIA)", "renderer": "ANGLE (NVIDIA, …)",
               "unmaskedVendor": "Google Inc. (NVIDIA)", "unmaskedRenderer": "ANGLE (NVIDIA GeForce RTX 3060 …)" },
    "locale": { "timezone": "America/New_York", "locale": "en-US",
                "acceptLanguage": "en-US,en;q=0.9",
                "geolocation": { "latitude": 40.71, "longitude": -74.0, "accuracy": 50 } },
    "fonts": ["Arial", "Calibri", "Segoe UI", "…"]
  },
  "net": {                          // Lobium-only extension, NOT in the JS Fingerprint yet (§4.3)
    "tlsProfile": "chrome-131",     // selects the JA3/JA4 ClientHello template (patch 21)
    "http2Profile": "chrome-131",   // selects SETTINGS/priority/header-order (patch 22)
    "webrtcPolicy": "proxy-only"    // ICE policy (patch 20)
  }
}
```

Notes:
- `fingerprint` is **byte-for-byte** the resolved `Fingerprint` the sidecar already produces
  (`LaunchContext.fingerprint`, `runners/types.ts`) — Lobium adds no transformation.
- `net` is an **additive Lobium envelope** for surfaces the JS layer can't express (TLS/HTTP2/WebRTC).
  These are *derived* from the claimed Chrome version, so they need only a profile key, not raw bytes.
- Deep-surface farbling (canvas/webgl/audio) needs no explicit fields beyond `seed` — the seed +
  per-domain salt fully determines the perturbation.

### 4.3 Relationship to `@lobster/shared-types`

- The `fingerprint` block is the existing exported `Fingerprint` interface — **no drift**. Any change
  goes through a shared-types ticket first (agent-protocol §7; `config-channel.md`).
- The `net` block is the **one addition** Lobium needs. Plan: add an optional `NetFingerprint`
  (`tlsProfile`, `http2Profile`, `webrtcPolicy`) to `fingerprint.ts` when patch 21/22 land, so the UI
  can eventually expose it too. Until then it's a Lobium-side envelope the sidecar fills from the
  claimed engine `version` (`EngineDescriptor.version`, `engine.ts`).
- A JSON Schema (`lobium/config.schema.json`, new) is generated from the TS types and validated in CI
  so a malformed config fails fast rather than silently mis-fingerprinting.

### 4.4 Sidecar integration

The Lobium launcher (a `Launcher` in `packages/engine-runner/src/runners/`) will, on `launch`:
1. Serialize `ctx.fingerprint` + derived `net` block → `${userDataDir}/lobium-fp.json` (0600).
2. Spawn the Lobium binary with `--lobium-fp-config=<path>` + `--user-data-dir` + proxy switches.
3. Return `{ pid, ws, debuggerAddress }` (`LaunchHandle`) — same contract as the interim runner, so
   Lobium drops in transparently behind `sidecar-ipc.md` `launch`/`startProfile`.
Because deep surfaces are now native, the Lobium path **skips** the CDP init-script/emulation that the
interim path uses (`cdp-fingerprint.ts`) for those surfaces — no JS tell.

---

## 5. Build infrastructure

**status: planned.** Chromium compiles are large; this is real infra, not a laptop job.

| Concern | Plan |
|---|---|
| **Build host** | A dedicated Linux builder: ≥ 32 (ideally 64) vCPU, ≥ 64 GB RAM, ≥ 250 GB SSD (checkout ~100 GB + out-dir). Self-hosted GitHub Actions runner or a cloud VM (e.g. a large c-family instance) spun up per build. |
| **Cache** | **reclient** (`use_remoteexec=true`) against a remote-execution/CAS backend for distributed compile + shared cache; **ccache** (`cc_wrapper="ccache"`) as the local fallback. Persist the cache volume across builds (biggest lever on rebuild time). |
| **Compile budget** | Cold build (no cache): several hours single-host; with reclient/warm cache, incremental rebuilds after a rebase target **< ~30–60 min**. Track wall-clock per build in CI; alert on regressions. Skip PGO (`chrome_pgo_phase=0`) for iteration builds; run PGO only for release artifacts. |
| **Isolation** | Builds run in a clean container/VM with pinned `depot_tools` + toolchain; no host state leaks into artifacts (reproducibility). |
| **CI placement** | Lobium's build is a **separate long-running pipeline**, NOT on every PR (MASTER_PLAN §8). Triggers: (a) new pinned ref / rebase, (b) patch-series change, (c) nightly, (d) manual. PR CI only lint-checks the patch series (apply-cleanly + header-present), never compiles. |
| **Artifact hosting** | Signed, versioned artifacts (per OS/arch) uploaded to S3-compatible object storage (same infra family as the SaaS profile blobs, MASTER_PLAN §3), served to desktop clients via the download-on-first-run mechanism (mirrors `/engines` for interim Chromium; **binaries never committed to git**). Each artifact carries a manifest: `{ engine:"lobium", version, os, arch, chromiumRef, sha256, signed:true, notarized? }`. |

---

## 6. Multi-OS matrix + signing + auto-update

**status: planned.** Target the four desktop targets; Windows first (MASTER_PLAN §12.4).

| Target | `target_cpu` / host | Signing | Notes |
|---|---|---|---|
| Windows x64 | `x64`, Windows or cross | **Authenticode** (EV or OV code-signing cert) on the exe + installer | First priority; MSI/NSIS installer. SmartScreen reputation builds with an EV cert. |
| macOS Intel | `x64`, mac host | Apple **codesign** (Developer ID) + **notarization** (`notarytool`) + **stapling** | Hardened runtime; entitlements minimal. |
| macOS Apple Silicon | `arm64`, mac host | same as Intel | Ship a **universal2** or per-arch dmg. |
| Linux x64 | `x64`, Linux | Detached GPG signature over the tarball/AppImage (no OS-mandated signing) | Also the canonical **build** host for the others where cross-building is viable. |

**Signing pipeline (`scripts/sign.<os>.sh`):**
- Windows: `signtool sign /fd sha256 /tr <timestamp> …` the browser exe + installer.
- macOS: `codesign --options runtime --deep` all binaries → zip → `xcrun notarytool submit --wait`
  → `xcrun stapler staple`. Fail the build if notarization is rejected.
- Secrets (certs, App Store Connect key) live in CI secret storage, **never** in the repo
  (MASTER_PLAN §7.5); injected at sign time only.

**Auto-update:**
- Chromium's Google update (Omaha/Sparkle) is stripped. Lobium ships a **custom updater**: the desktop
  agent polls a Lobium **update manifest** (`{ channel, latestVersion, perOS: {url, sha256, sig} }`)
  on the artifact host, verifies the signature + hash, downloads, and swaps the engine on next launch.
- Channels: `stable` (tracks Chrome stable per §7) and `canary` (fresh rebases for internal detector
  validation before promotion).
- The updater reuses the SaaS auth/download path; engine binaries are per-user, not system-wide, so no
  elevated privileges are needed for updates.

---

## 7. Rebase automation + version cadence (the Octo moat)

**status: planned.** Staying within days of Chrome stable is the durable competitive edge.

**`scripts/rebase.sh` (nightly + on Chrome-stable release):**
1. Query the Chromium release feed for the newest **stable** tag; diff against `BASELINE.md`.
2. If newer: create a `rebase/<new-version>` branch, re-pin `CHROMIUM_REF`, `gclient sync`.
3. `quilt push -a` the series; on the **first reject**, stop and open a "rebase needs hands" issue
   with the failing patch + reject hunks attached (patches are small precisely to make this rare).
4. On clean apply: full build → run the **detector matrix** (§9) → compare scores against
   `ci/validation/thresholds.json` baseline.
5. If green: promote to `canary`, then to `stable` after a soak; update `BASELINE.md`, publish
   artifacts (§6), bump the update manifest (§6).
6. If red: block promotion, file the regressing surface.

**Cadence targets:**
- **Rebase to new Chrome stable ≤ 3 business days.** The UA version Lobium claims (patch 10) is bumped
  in lockstep so `EngineDescriptor.version` always matches a currently-shipping Chrome (MASTER_PLAN §6
  "version alignment"). A stale engine claiming a fresh Chrome version is itself a tell — this loop
  prevents that.
- Security-critical Chrome releases can be fast-tracked (rebase within 1 day).

**Why small, foldered, header-documented patches (§3):** they survive upstream churn with minimal
rejects, which is what makes a ≤3-day cadence sustainable by two agents rather than a large team.

---

## 8. Mobile / Android Lobium variant

**status: planned (post-desktop, MASTER_PLAN Roadmap §3; ADR-0004 "Mobile").** Follows once the
desktop build + patch series are solid.

- **Base:** Chromium's Android build (`target_os = "android"`, `target_cpu = "arm64"`), same
  `depot_tools`/GN/ninja pipeline + the **same patch series** — most fingerprint patches are
  Blink/net-level and OS-agnostic, so they apply to Android too. OS-specific reworks: fonts (patch 13
  → Android font manager) and screen/DPR/touch defaults (patch 11/14 → mobile ranges,
  `uaMobile:true`, non-zero `maxTouchPoints`).
- **Fingerprint config:** the same `Fingerprint`/config-channel — mobile profiles just carry mobile
  values (`os` variant, mobile UA/UA-CH, touch, mobile GPU string, orientation). The JS-side mobile
  profile type already exists at config level (MASTER_PLAN §1 "Android/mobile").
- **Packaging:** APK, signed with an Android keystore; distributed via the same artifact host + update
  manifest.
- **Deferral rationale:** Android adds an OS/build target and a device-emulation surface (orientation,
  DeviceMotion/Orientation sensors, touch event model) that only pays off after the desktop moat is
  proven. Not v1.

---

## 9. Verification — validating each patch against the detector matrix

**status: partial.** The CI harness exists (`ci/validation/run.mjs`, `thresholds.json`, T-005) and
today grades the **interim** Chromium; the *same* harness grades Lobium builds as each patch lands.

### 9.1 The gate

`ci/validation/thresholds.json` (current, real):
```json
{ "sannysoft": { "maxFailed": 2 }, "creepjs": { "minTrustScore": 60, "maxLies": 0 },
  "webrtc": { "requireIcePublicIpEqualsProxyIp": true }, "coherence": { "maxIssues": 0 } }
```
The `sannysoft.maxFailed: 2` allowance exists **because** WebGL vendor/renderer are still host values
on the interim engine (see the `//` note in the file). **When Lobium's WebGL patches (16/17) land, that
allowance drops to 0** — that tightening is the objective proof the native patch worked.

### 9.2 Per-patch acceptance (each patch is "done" only when its detector check passes)

| Patch | Primary verification |
|---|---|
| 10 navigator/UA-CH | Launch two profiles → two different `navigator.userAgent`, set natively with **no JS override present** (T-011 acceptance); UA ↔ Sec-CH-UA ↔ `navigator.platform` coherent (CreepJS, Iphey). |
| 11 screen/DPR | Sannysoft screen row consistent; `matchMedia`/DPR agree; independent of host monitor. |
| 12 timezone/locale | browserleaks timezone == proxy-geo timezone; `Intl`/`Date`/`languages` agree (coherence gate). |
| 13 fonts | browserleaks fonts list == claimed-OS set; no OS-mismatched font leaks (CreepJS lie check). |
| 14 hardware | `hardwareConcurrency`/`deviceMemory` match config in **window and workers** (the interim JS-only path failed exactly this in a worker — see `cdp-fingerprint.ts` note; native must pass it). |
| 15 canvas | CreepJS/Pixelscan canvas hash **stable per profile**, **differs across profiles**, not host-identifying; identical across iframes + workers + OffscreenCanvas. |
| 16/17 WebGL | Sannysoft WebGL rows pass → drop `maxFailed` to 0; unmasked vendor/renderer == config; pixel hash stable-per-profile (browserleaks WebGL, CreepJS). |
| 18 audio | browserleaks/CreepJS audio hash stable-per-profile, differs across profiles. |
| 19 WebGPU | adapter/limits coherent with the WebGL device story (CreepJS WebGPU). |
| 20 WebRTC | `requireIcePublicIpEqualsProxyIp` holds; no local-IP candidate leak (browserleaks WebRTC). |
| 21 TLS | Measured **JA3/JA4** == the claimed Chrome build's (external JA4 echo service in the harness). |
| 22 HTTP/2 | SETTINGS/priority/header-order == claimed Chrome (h2 fingerprint echo). |

### 9.3 Cross-cutting checks (every Lobium build, every rebase)

- **Coherence gate** (`coherence.maxIssues: 0`): one device story across UA ↔ OS ↔ WebGL ↔ canvas ↔
  screen/DPR ↔ hardware ↔ fonts (MASTER_PLAN §6).
- **Config round-trip:** the `Fingerprint` in → the surfaces out match exactly (T-011 acceptance:
  "config round-trips from shared-types → sidecar → Lobium unchanged").
- **No-JS-tell audit:** confirm deep surfaces are native (no `addScriptToEvaluateOnNewDocument` for
  canvas/WebGL/audio on the Lobium path).
- **Cross-profile decorrelation:** N profiles → N distinct deep-surface hashes, each stable across
  restart.
- **Regression guard:** a rebase that lowers any detector score below baseline **blocks promotion**
  (§7 step 6).

---

## Status vs target

**Where we are:** the Lobium track is a **documented, scaffolded design, not yet a running engine.**
Concretely built today: the dry-run `build.sh`, an example GN arg set, an empty quilt `series`, and the
prose specs — plus the crucial *shared* pieces this engine depends on that already exist and work: the
`Fingerprint` model in `@lobster/shared-types`, the sidecar `launch` contract Lobium will plug into, and
the CI detector harness (`ci/validation/`) that already grades the interim engine and will grade Lobium
unchanged. The `lobium` engine kind currently resolves to the interim patched Chromium via patchright.

**Where we're going:** execute **T-010** (pin ref → real fetch/sync/patch/gn/ninja → first launchable
build) then **T-011** (init the series → `core/config-channel` + `fingerprint/navigator-ua-ch` → one
param native end-to-end, POC). From there the patch series (§3) fills in surface by surface, each
gated by its detector check (§9), with rebase automation (§7) holding Lobium within days of Chrome
stable — the moat. Multi-OS signing (§6) and the Android variant (§8) follow once the desktop patch
series is proven. The product stays fully usable on the interim Chromium throughout (MASTER_PLAN §7.5:
protect the v1 milestone); Lobium becomes the **default engine** as native coverage lands.

**Honest bottom line:** none of the native fingerprint patches exist yet — the moat is designed and
sequenced but unbuilt. The nearest concrete proof point is the T-011 POC (two profiles → two native
UAs, no JS tell). Everything past that is planned work on the critical path described above.
