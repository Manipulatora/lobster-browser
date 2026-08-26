# Windows agent — understanding document (Phase 0)

Written on the Windows build host, 2026-08-26, in response to
[`2026-08-26-windows-agent-brief.md`](2026-08-26-windows-agent-brief.md).

Every claim below is either cited to `file:line` in this repo or was measured on this machine and is
marked **[measured]**. Where I could not establish something I say so rather than filling the gap.
Several claims in the brief turn out to be wrong about this machine or this platform; they are in
[§6](#6-corrections-to-the-brief), and two of them change what Phases 1–3 can achieve.

---

## 1. How a profile's fingerprint becomes a running browser

The chain is: **stored profile → persona resolution → launch context → argv + a JSON file on disk →
browser process → base64 on each renderer's command line → a Blink hook that reads it, or falls back
to the host.**

### 1.1 UI → sidecar

The desktop app is a Tauri 2 Rust core with a React UI; it spawns the Node sidecar
(`packages/engine-runner`) and talks to it over line-delimited JSON-RPC on stdio
(`README.md:31-38`). The relevant call is `startProfile(StartProfileParams) → { profileId, pid, ws,
debuggerAddress }` (`docs/OPERATIONS.md:472-477`).

### 1.2 Persona resolution — the only place identity is decided

`startProfile` resolves the persona and is the sole decision point for fingerprint and GPU identity
(`packages/engine-runner/src/start-profile.ts`). A persona is a **pure function of (seed, os, arch)**:
one FNV-1a hash of the seed string seeds a `mulberry32` PRNG, and every device choice is a draw from
that single stream (`packages/fingerprint/src/derive.ts`, `packages/fingerprint/src/prng.ts`).
Nothing else is random, which is what makes a profile stable across launches.

Two details matter more than they look:

- `arch` is a **property of the picked GPU, not of the caller's request** — `Apple M<n>` in the
  renderer string implies `arm64`, everything else `x86_64` (`packages/fingerprint/src/derive.ts:215`).
- The Chrome version is deliberately **not** seed-diverse; it is pinned to the running engine build.
  A seed-diverse version would make each profile close to uniquely identifiable via
  `getHighEntropyValues(['fullVersionList'])` — the same reasoning that made the old
  `152.0.7928.0` canary pin a defect (`docs/STATUS.md:66-72`).

`startProfile` **fails closed on nine distinct conditions** before anything spawns: seed, engine, OS,
renderer policy, host-calibration mismatch, proxy reachability, geolocation, coherence, and
capabilities.

### 1.3 Launch context → argv

`CompositeRunner` builds a `LaunchContext`; `createLobiumLauncher` spawns the binary
(`packages/engine-runner/src/runners/lobium-launcher.ts`). Two functions build the command line:

- `buildLaunchOptions` — the non-Lobium half: `--no-first-run`, `--no-default-browser-check`,
  `--lang`, `--window-size`, `--webrtc-ip-handling-policy`, `buildGpuArgs()`, `--disk-cache-size`,
  proxy hardening.
- `buildNativeLobiumProcessArgs` — the final `chrome.exe` argv in a fixed order of 17 groups. The
  Lobium-specific flags are `--lobium-fp-config`, `--lobium-profile-name`,
  `--lobium-profile-initials/-word/-tint`, and — for a mobile persona only —
  `--lobium-device-frame` / `--lobium-device-screen`
  (`packages/engine-runner/src/runners/lobium-launcher.ts:504-522`).

The profile-mark flags carry a Unicode reduction computed in TypeScript, so the engine derives
nothing itself.

### 1.4 The native config file, and the renderer projection

`buildLobiumLaunchArgs` writes `<userDataDir>/lobium-fp.json` mode `0600` and returns
`--lobium-fp-config=<path>` (`packages/engine-runner/src/runners/lobium-launcher.ts:70,384`).

The browser process reads that file once and forwards a base64 copy as `--lobium-fp-data` to **every
renderer, workers included** (`lobium/patches/core/config-channel.patch`; `lobium/patches/series`).

This is where the subtlest constraint in the product lives. The renderer copy rides on a child
**command line**, and the engine enforces `kMaxLobiumFpDataBytes` = 28 KiB. Exceeding it makes the
browser **skip `--lobium-fp-data` entirely** — every renderer then silently reports host values,
which is a total spoofing failure that still launches successfully. So the sidecar refuses before
spawn instead (`packages/engine-runner/src/lobium-config.ts:34,325-332`).

The renderer copy is a **projection**: `rendererConfigProjection()` deletes exactly the four
browser-only keys (`fonts`, `fontPackDir`, `fontAliases`, `fontFallbackFamilies`) that the native
`StripBrowserOnlyKeys` also removes, and the size guard measures **that projection**, not the file
(`packages/engine-runner/src/lobium-config.ts:59,325`). Sizing the full document previously refused
25 of 50 personas — every macOS and every Linux one — because `fontAliases` carries one entry per
claimed family.

`validateLobiumConfig` is an explicit fail-closed gate inside `buildLobiumConfig`, and it exists
**because the native parser fails open**: a missing field leaves the host value in place.

### 1.5 The Blink hook

Each surface is a separate patch that routes one upstream call through
`lobium::LobiumFpConfig::Current()` and **falls back to the real host value when the config is
absent** (`lobium/patches/series:5-11`). Almost all logic lives in the *added* module
`//components/lobium_fp/` (staged from `lobium/src/`), so an added directory never conflicts on an
upstream rebase and the patches stay minimal.

**Worked example — `screen.colorDepth`:** `derive.ts:234` sets
`colorDepth = deviceArch === 'arm64' ? 30 : 24` → written into `lobium-fp.json` → base64 to the
renderer → read by the hook in `fingerprint/screen-dpr.patch` at
`third_party/blink/renderer/core/frame/screen.cc:100` (`Screen::colorDepth`) → the page reads 30.

---

## 2. The capability contract

### 2.1 What it is

The binary itself declares which hooks it contains. `chrome.exe --lobium-fingerprint-capabilities`
prints a versioned JSON manifest **before browser startup** and exits (`lobium/patches/series`,
`core/capability-contract.patch`). The source of truth is `lobium/src/lobium_capabilities.cc:22`,
which sits beside the hooks it describes, so it cannot claim a hook that was never compiled.
`packages/engine-runner/src/lobium-capabilities.ts:19` mirrors it for type-checking only and is
explicitly *not* the authority; `ci/validation/patch-series.test.mjs` fails the build if the two
lists diverge.

**[measured]** On this host, the packaged `152.0.7977.42` runtime reports:

```
contractVersion 3, product "Lobium", 20 capabilities
config-channel-v1, navigator-ua-ch, navigator-webdriver, navigator-languages,
network-accept-language, process-locale-timezone, native-geolocation, webrtc-policy,
webgl-deep, webgl2-deep, screen-metrics, mobile-persona, canvas-farbling, webgl-farbling,
audio-farbling, client-rects, media-devices, webgpu-adapter, native-timezone, font-isolation
```

19 portable + `font-isolation`, which is `BUILDFLAG(IS_WIN)`-gated
(`lobium/src/lobium_capabilities.cc:72-80`), matching `docs/STATUS.md:25-26` ("19 capabilities on
Linux and 20 on Windows").

**Superseded the same day:** `device-frame` was added to the contract (§5.2), guarded to Linux and
Windows, so a current build prints **21 on Windows and 20 on Linux**.

### 2.2 What happens on disagreement — fail closed, in all three forms

`probeLobiumBuildCapabilities` executes **the exact binary that will be spawned**, under a 5-second
timeout and a 64 KiB buffer, caching on `path:size:mtimeMs`
(`packages/engine-runner/src/lobium-capabilities.ts:100-124`). Filename and version claims are
deliberately not trusted.

Three ways to disagree, all fatal:

| Disagreement | Where | Result |
|---|---|---|
| Wrong `contractVersion`, wrong product, or an unknown capability name | `lobium-capabilities.ts:77-86` | throws "incompatible native capability contract" |
| Binary does not answer / times out / prints non-JSON | `lobium-capabilities.ts:114-120` | throws "cannot prove native fingerprint capabilities" |
| Answers, but lacks a required hook | `lobium-capabilities.ts:187-196` | throws "Lobium build lacks required native fingerprint hooks: …" |

**There is no degrade path and no warn path anywhere in the codebase.** The sidecar throws and never
spawns. The gate runs **twice** per product launch — once in `start-profile` against the resolved
policy, once inside the launcher against the exact bound binary.

`requiredLobiumCapabilities` demands 13 hooks unconditionally and adds the rest conditionally:
`native-geolocation` if geolocation is configured, `mobile-persona` for an emulated Android persona,
`font-isolation` only on `win32`, `device-frame` for a mobile persona on win32 or linux, and one per
enabled hardware-noise seed (`packages/engine-runner/src/lobium-capabilities.ts:126-185`).

### 2.3 Why it is designed this way

Because **every fingerprint hook in the fork fails open by construction.** An unreadable,
unparseable or too-old config produces a browser that silently reports host values. The comments say
what that looks like from outside — for `navigator-ua-ch`:

> "a build that has the config channel but not this hook accepts the persona, launches successfully,
> and then reports the HOST's identity on the surfaces every detector reads first — a failure that
> looks exactly like a working profile until the account is banned."
> — `packages/engine-runner/src/lobium-capabilities.ts:126-129`

So the contract is the **one place the product converts a silent, invisible, catastrophic failure
into a loud one before any traffic is generated**. A leaked profile is worse than a profile that
will not start: the user finds out about the first when the account is banned, and about the second
immediately. That asymmetry is the whole design rationale.

Two consequences worth stating plainly:

1. `webgl2-deep` is required *alongside* `webgl-deep`, not instead of it — a build with only the
   WebGL1 hooks lets a WebGL2 context report the host's extension list while WebGL1 reports the
   persona's, so two contexts on one page disagree. That is worse than neither being spoofed
   (`lobium-capabilities.ts:139-142`).
2. The contract covers **fingerprint hooks only**. It does not cover branding, the device frame, or
   anything else. See [§5.2](#52-the-device-frame-is-invisible-to-the-only-mechanism-that-could-have-caught-it).

---

## 3. Which surfaces are hooked, and which are still the host

### 3.1 Hooked natively (19 fingerprint patches + 5 core patches)

| Surface | Patch | Notable |
|---|---|---|
| UA, UA-CH brands, platform, `hardwareConcurrency`, `deviceMemory`, `maxTouchPoints` | `core/navigator-ua-ch` | all contexts incl. workers |
| `navigator.webdriver` | `fingerprint/navigator-webdriver` | answered in Blink, *not* by `--disable-blink-features` — the flag raised Chromium's "unsupported flag" infobar and named itself on `chrome://version`: two tells bought to hide one |
| `navigator.language(s)`, ICU locale, configured geolocation | `fingerprint/locale-geolocation` | |
| Canvas 2D + OffscreenCanvas readback | `fingerprint/canvas-farbling` | `seeds.canvas` |
| WebGL vendor/renderer, scalar caps, pixel farbling | `fingerprint/webgl-surfaces` | chain head |
| WebGL version / SLVersion / extensions / shader precision | `fingerprint/host-gpu-profile` | needed on real GPUs: extensions + precision leaked the host while `UNMASKED_RENDERER` was already spoofed |
| Never advertise a cap the backend cannot execute | `fingerprint/webgl-runtime-safety` | |
| Two bypass routes closed | `fingerprint/webgl-bypass-closures` | a no-op `PACK_ROW_LENGTH` switched readback farbling off; the WebGL1 extension list collapsed on a WebGL2 context |
| WebGL2 uniform/varying COMPONENT counts | `fingerprint/webgl2-surfaces` | ANGLE derives these as exactly 4× the WebGL1 VECTOR limits |
| `navigator.gpu` adapter identity | `fingerprint/webgpu-adapter` | derived from the same GPU WebGL names |
| Web Audio (offline result + Analyser float **and** byte paths) | `fingerprint/audio-context` | |
| `AudioWorkletProcessor.process` / `ScriptProcessorNode` input tap | `fingerprint/audio-worklet-tap` | the sample a page can read *before* the farbled result |
| `screen.*`, `devicePixelRatio`, CSS device-size media values | `fingerprint/screen-dpr`, `fingerprint/media-values-device-size` | |
| `getClientRects` | `fingerprint/client-rects` | |
| `mediaDevices.enumerateDevices` | `fingerprint/media-devices` | HMAC-SHA256 keyed on the requesting **origin**, mirroring Chrome's real construction |
| WebRTC policy (4 observable modes) | `fingerprint/webrtc-policy` | enforced in the candidate callbacks, never by throwing from the constructor |
| Timezone, inside the engine | `fingerprint/native-timezone` | `TZ` is POSIX-only and ICU ignores it on Windows, so the env route silently did nothing there |
| Android parity (desktop PDF plugin suppression) | `fingerprint/mobile-persona` | |
| Windows font-set isolation via DirectWrite + font-pack sideload | `fingerprint/windows-font-isolation` | Windows-only by nature; the one **fail-closed** hook in the fork |

### 3.2 NOT hooked — still the real host value

Confirmed by grep across every patch and every `lobium/src/` file (zero hits):

- **CSS `(color:)`, `(color-gamut:)`, `(dynamic-range:)`.** `media_values.cc` is touched by exactly
  two patches, and only three functions in it are hooked: `CalculateDevicePixelRatio`,
  `CalculateDeviceWidth`, `CalculateDeviceHeight`. **[measured]** — verified at the hunk headers
  `lobium/patches/fingerprint/screen-dpr.patch:62` and
  `lobium/patches/fingerprint/media-values-device-size.patch:12,30`.
- **EME / Widevine.** No patch touches it. The position is a *build-configuration* one: neither
  `lobium/gn-args.gn.example` (the file `lobium/build.sh` feeds to `gn gen`) nor
  `lobium/gn-args-windows.gn` sets `enable_widevine`, so it defaults
  false and is compiled out. **[measured]** — grep returns nothing in either file.
- **`canPlayType` / codec reporting, incl. Dolby Vision.** Not hooked anywhere; the answer is a pure
  function of the GN args of the build that produced the binary. "Dolby Vision" appears nowhere in
  the fork.
- **TLS JA3/JA4 ClientHello ordering** — named in the series as unwritten
  (`lobium/patches/series`, `net/tls-ja3-ja4.patch`). No patch touches `net/` or BoringSSL.
- **HTTP/2 SETTINGS and pseudo-header ordering** — same status, same line.
- **`Accept-Language` header.** The capability manifest advertises `network-accept-language`, but the
  header comes from a pre-start profile preference written by the launcher, not from a binary hook.
  The capability name overstates what the binary does.

`navigator.gpu` **is** hooked, but narrowly: `webgpu-adapter.patch` touches exactly one upstream file
(`gpu_adapter.cc`), so `GPU.requestAdapter`, `GPUDevice` and the WGSL language surfaces sit outside
it.

---

## 4. Where the engine comes from at runtime

### 4.1 Resolution order

There is exactly **one** place that chooses the engine: `ensure_lobium_env`, called once from the
Tauri `setup` hook before the sidecar is spawned (`apps/desktop/src-tauri/src/lib.rs:1300`).

| # | Candidate | Condition |
|---|---|---|
| 0 | inherited `LOBSTER_LOBIUM_BIN` | short-circuits everything; the documented developer override (`lib.rs:1329`) |
| 1 | `<resources>/lobium/chrome.exe` | `lib.rs:1332` |
| 2 | `<resources>/engines/lobium/chrome.exe` | `lib.rs:1333` |
| 3 | `%LOCALAPPDATA%\lobster\lobium` | **only** if its `.lobium-engine-version` stamp byte-matches the manifest entry (`lib.rs:1337-1342`, `engine_provision.rs:180`) |

**There is no download inside this function.** Candidate 3 is gated on an exact version + archive
digest, not on the mere presence of `chrome.exe` — so a stale or foreign runtime in the cache is
*unreachable*, not merely deprioritised. `explicit_lobium_bin()` also deliberately reports `None` for
a path this process itself published as managed (`lib.rs:508,531`), so the managed runtime is always
re-judged against the manifest rather than being trusted as an override.

`engine_status` is a **reporting** view with its own separate order, not the resolver
(`lib.rs:546-573`).

### 4.2 What changed on 2026-08-26

**The installer stopped carrying the engine — a reversal of a change made the day before.**

| Commit | Date | Effect |
|---|---|---|
| `511481d` | 2026-08-25 | *"the installer carries the browser engine, so there is no download step"* — staged the runtime into `resources/lobium`, added `"resources/lobium": "lobium"` to `bundle.resources`, and replaced `EngineGate`'s download UI with a damaged-install check |
| `0e0831d` | 2026-08-26 | *"a 53 MB installer, and a first-run screen that says nothing"* — **reverted that**: the engine is downloaded on first run again |

**[measured]** `apps/desktop/src-tauri/tauri.windows.conf.json` now declares no `resources` key at
all; the base `tauri.conf.json:44-49` ships only `sidecar`, `node`, `lobee` and
`engine-manifest.json`. Candidates 1 and 2 above therefore still exist in the Rust code but are **not
populated by the bundle** — they remain a working path for a developer, or for a future re-embed.

The second change is the **origin**: artifacts are no longer published to GitHub but served from
`lobrowser.com` (`/var/www/lobster-downloads/download/`), engines under `download/engine/`
(`engine-manifest.json:3`).

**[measured] I verified both endpoints from this host:**

```
https://lobrowser.com/download/engine/lobium-linux-x64-152.0.7977.42.tar.gz
    HTTP 200, 270,688,368 bytes, nginx/1.24.0 (Ubuntu)
https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip
    HTTP 404
```

So the Linux half of the new distribution path is live and the Windows half is not — exactly as the
manifest's own `stale` note says. One wrinkle: nginx serves that 404 with `Content-Type:
application/zip` and a 10-byte `Not found.` body. A downloader checking only the content type would
write a 10-byte "archive". `engine_provision.rs:222` does check `!resp.status().is_success()` first,
so the product fails closed correctly — but the trap is there for anything else that fetches these
URLs.

---

## 5. Three things I believe are wrong or risky

### 5.1 The device frame is Linux-only in source, so Phase 3's rebuild cannot fix it

**This is the most consequential finding in this document, and it contradicts the brief.**

The brief and `docs/qa/2026-08-26-windows-engine-rebuild.md` both describe the missing Android phone
stage on Windows as a **stale binary** — fix by rebuilding. It is not.

**[measured]** Every integration point in `branding/device-frame.patch` is compiled out on Windows:

```
lobium/patches/branding/device-frame.patch
  BUILDFLAG(IS_LINUX) : 11 occurrences
  BUILDFLAG(IS_WIN)   :  0 occurrences
```

The guards sit on every call site, not on some optional extra — the include, the member declaration,
construction in `BrowserView::BrowserView`, the destructor, `OnActiveTabChanged`, `AddedToWidget`,
`AcceleratorPressed`, the `BrowserViewLayoutViews` struct field, and
`browser_view_tabbed_layout_impl.cc` (patch lines 9, 19, 32, 42, 55, 65, 102, 135, 149, 162, 186).
`lobium_device_frame_view.cc/.h` *are* added unconditionally to the `ui` static_library
(`lobium/patches/core/build-gn.patch:51-52`), so the class compiles on Windows — it is simply never
instantiated or laid out.

`lobium/hooks.md` already describes the patch as Linux-only; the rebuild doc treats that as stale
because the *link* failure was fixed. Those are two different things: the link gap was closed, the
platform gap was not.

**Consequence:** rebuilding the Windows engine *as the series stood* would have produced a binary
that still had no device frame. The brief lists this as the rebuild's headline release blocker, so
rebuilding first and discovering it afterwards would have cost the whole build.

**Fixed, 2026-08-26.** The view itself is 406 lines of `views`/`gfx`/`content` code with no
platform-specific includes at all — no X11, Wayland, Ozone, GTK, Aura or Win32 — and
`lobium_device_frame_view.{cc,h}` are already added *unconditionally* to the chrome `ui` target by
`core/build-gn.patch:51-52`. So the port was the guards, not the implementation: all 11
`#if BUILDFLAG(IS_LINUX)` lines in `branding/device-frame.patch` are now
`#if BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_WIN)`. The edit changes line content only, so every hunk
header stays valid, and the whole 33-patch series re-applied from a reset tree with no fuzz and
`gn gen` produced 32,075 targets. Whether the frame actually *renders* on Windows is a runtime
question the rebuild will answer; it could not even be asked before.

### 5.2 The device frame is invisible to the only mechanism that could have caught it

The capability contract exists precisely to stop a binary that is behind the sidecar from launching
(§2.3), and it is well built — fail-closed in all three forms, probing the exact binary, never
trusting a filename. But it covers **fingerprint hooks only**.

**[measured]** `device-frame` appears in neither `lobium/src/lobium_capabilities.cc` nor
`packages/engine-runner/src/lobium-capabilities.ts`. Meanwhile the launcher unconditionally emits
`--lobium-device-frame` and `--lobium-device-screen` for a mobile persona
(`packages/engine-runner/src/runners/lobium-launcher.ts:521-522`), and Chromium **silently ignores
unknown switches**.

So a binary with no device-frame code passes every gate, launches normally, and reports success while
the feature is simply absent. That is exactly how this regression shipped and went unnoticed for
days.

**Fixed, 2026-08-26.** `device-frame` is now a declared capability, guarded to the two platforms that
compile the BrowserView call sites: `lobium/src/lobium_capabilities.cc:110-128`, mirrored at
`packages/engine-runner/src/lobium-capabilities.ts:48`. `requiredLobiumCapabilities` demands it for
an emulated Android launch on win32 and linux (`lobium-capabilities.ts:177-179`), and both the
packager and the independent verifier refuse a runtime without it
(`scripts/package-lobium-runtime.ps1:278`, `scripts/verify-lobium-runtime.mjs:37`). A build missing
the frame is now unpackageable rather than shippable, and a stale one refuses a mobile launch instead
of quietly degrading it.

**[measured] I confirmed the published binary's state directly**, which also produced a better test
than the one the brief specifies:

```
dist-win/lobium-runtime-152.0.7977.42/   (sha256 of its zip = 1c9c95a6… = the published manifest entry)
  chrome.exe     4,273,664 bytes  — launcher stub; contains no Lobium strings at all
  chrome.dll   297,368,576 bytes  — 11 of 13 lobium switch strings present
                                    MISSING: lobium-device-frame, lobium-device-screen
```

Those two missing switches are exactly the ones `branding/device-frame.patch` owns, and every other
Lobium switch is present. The brief's conclusion is right; §6.2 explains why its stated *check* would
not have shown this.

**Correction to my own first reading of that evidence.** I initially took the two missing strings as
proof the patch had not been applied to that build. It is not proof, and it was not the cause.
Inspecting the Chromium checkout at `C:\lobium-build\src` shows the tree **was** patched —
`components/lobium_fp/` holds its 19 staged files and
`chrome/browser/ui/views/frame/lobium_device_frame_view.cc` is present — and the built `chrome.dll`
in `out/Lobium` *still* has zero occurrences of either switch. The real mechanism is §5.1: the switch
constants (`kDeviceFrameSwitch`, `kDeviceScreenSwitch`) are defined in an anonymous namespace inside
`lobium_device_frame_view.cc`, and every use of that class is behind `#if BUILDFLAG(IS_LINUX)`, so on
Windows nothing references the translation unit, the linker drops the whole object out of the
`ui` static_library, and the strings go with it.

That makes the absence of those two strings a correct test for "does this Windows binary have a
working device frame" — which is what §6.2 recommends — while being a *wrong* test for "was the patch
applied". The two questions had the same answer here only by coincidence.

### 5.3 Every hook fails open, and the one harness written to catch that is wired into no gate

`lobium/patches/series:5-11` states the design: each hook "falls back to the real host value when the
config is absent". That is the right call for robustness — a browser that refuses to start is worse
than one that starts — but it means **every** silent failure mode in this product points the same
way: toward reporting the host.

The mitigations are real but partial:

- The capability contract (§2) covers *presence of hooks*, not *correctness of output*.
- `validateLobiumConfig` covers *the document*, not the browser's reading of it.
- The 28 KiB guard covers *transport*, and its own native failure mode is fail-open (the browser
  drops `--lobium-fp-data` and every renderer reports host values) — caught only because the sidecar
  refuses first (`packages/engine-runner/src/lobium-config.ts:325-334`).

What would close the loop is a harness that launches a real profile and asserts the page reports what
the config asked for. One now exists — `ci/validation/fingerprint-conformance.mjs`, added this
morning in `92cad8b` — and it is a good design: three verdicts (MATCH / MISMATCH / **VACUOUS**) so a
green run cannot be assembled from surfaces that were never measured, plus a separate contradiction
pass, plus a persona-free baseline captured through the raw binary.

**[measured, and since fixed] `fingerprint-conformance.mjs` was referenced nowhere else in the
repo** — not in any `package.json` script, not in any workflow. It ran only if a human remembered to.
A fail-open architecture whose only end-to-end check is opt-in is one forgotten command away from the
state it was written to prevent.

It is now `package.json:44` (`gate:conformance`) and runs in CI at
`.github/workflows/ci.yml:461-475`, which translates its exit 2 into BLOCKED rather than swallowing
it — BLOCKED must not read as a pass. **The remaining gap** is that `ci/validation/gate.mjs`, the
report referee, still does not consider a conformance report.

Three defects inside it, all found by reading it against `derive.ts` and all now fixed:

- `css.colorBits` was CRITICAL, so combined with `derive.ts:234` (arm64 ⇒ `colorDepth` 30) and the
  unhooked `(color:)` feature (§3.2), **a run including any `macos_arm` persona could never pass on
  an ordinary 8-bit display**. It is now a distinct `KNOWN-OPEN` verdict
  (`fingerprint-conformance.mjs:205-211` and `:318-330`): still reported every run, no longer gating.
  Deleting the entry once the surface is hooked is what makes the gate start requiring it.
- `claimsChrome` was `/Chrome\//.test(navigator.userAgent)` rather than a Sec-CH-UA brand check, so
  the Widevine contradiction fired for *every* persona — every UA contains `Chrome/152…`. Now tests
  the brand list (`:267-273`).
- The Dolby Vision check only fired for macOS personas, so a build advertising it for *nobody* looked
  clean. Corrected — see §6.6, which is also where that check turned out to need a control rather
  than a rule.

---

## 6. Corrections to the brief

The brief invites this: *"If a claim in this brief turns out to be wrong, say so plainly with your
evidence — it was written from the Linux side and some of it is inference about your machine."*
In descending order of impact.

### 6.1 This host has no GPU either — Phases 1 and 2 rest on a false premise

The brief states, twice, that this machine has a real GPU:

> "So the engine binary and the fingerprint layer are both exonerated on a software-GL host, and the
> defect lives on the real-GPU path. **Yours is the only machine that has one.**" (Phase 1)
>
> "**Your host has a GPU, so this one may not reproduce** — which is exactly the point of measuring
> here." (Phase 2, contradiction 4)

**[measured] It does not.** This is a QEMU/KVM virtual machine with the Bochs standard VGA adapter:

```
Win32_VideoController : "Microsoft Basic Display Adapter"
                        (Standard display types), SeaBIOS VBE(C) 2011, AdapterRAM 0
PnP instance          : PCI\VEN_1234&DEV_1111&SUBSYS_11001AF4   (QEMU/Bochs VGA + virtio subsys)
Win32_ComputerSystem  : Manufacturer BOCHS_, Model BXPC____
NVIDIA / AMD / Intel graphics devices present: NONE
```

And the engine agrees. Running the brief's own Phase 1 command with no persona:

```
gpu.featureStatus   webgl: "unavailable_software"        webgpu: "unavailable_software"
                    gpu_compositing: "disabled_software" rasterization: "disabled_software"
                    opengl: "disabled_off"               2d_canvas: "unavailable_software"
gpu.devices         "Microsoft Basic Render Driver"  (vendor 0x1414 = Microsoft)
glRenderer          ANGLE (Google, Vulkan 1.3.0 (SwiftShader Device (Subzero) (0x0000C0DE)),
                    SwiftShader driver-5.0.0)
```

That is **SwiftShader** — the exact software path the brief says invalidates all seven prior detector
reports, and the same class of backend as the Linux box's llvmpipe.

Consequences:

- **Phase 1 cannot reproduce the 3D defect here.** For completeness I ran it anyway
  (`qa-out/lobium-3d-nopersona.json`): all four GitHub mascots were found, contexts created, 98 draw
  calls, **no GL errors**, and the PNGs contain the rendered mascot. Same verdict as Linux, same
  reason.
- **Phase 2 cannot produce real-GPU baselines here.** Twenty profiles captured on this host would be
  twenty more SwiftShader captures — precisely the flawed measurement Phase 2 exists to replace. Its
  contradiction 4 will reproduce here rather than being tested against a real GPU.

I did not change either phase's plan on my own; that needs a decision, and the options are in the
report rather than picked unilaterally.

### 6.2 The rebuild's binary check would fail on a *correct* Windows build

Phase 3 step 4 and the rebuild doc both say: search **`chrome.exe`** for **`LobiumDeviceFrameView`**,
and "zero occurrences means the patch did not apply — stop, do not package."

**[measured] On Windows that check returns zero for every build, correct or not**, for two
independent reasons:

1. **Wrong file.** Windows Chromium's code is in `chrome.dll` (297 MB); `chrome.exe` is a 4.3 MB
   launcher stub. It contains no Lobium strings whatsoever — not even `lobium-fp-config`, which is
   unquestionably present in every build.
2. **Wrong token.** `LobiumDeviceFrameView` is a C++ class name. It appears in the Linux binary
   because that build retains a symbol table (the same 236.7 MB the rebuild doc wants stripped). In
   the Windows release build it appears nowhere — I get 0 occurrences of `LobiumFpConfig` and
   `LobiumConfiguredHardwareConcurrency` too, in a binary that demonstrably has those hooks.

**A check that does work**, and the one I used above: grep `chrome.dll` for the *switch strings*,
which are string literals and survive optimisation. On the published build, 11 of 13 are present and
exactly `lobium-device-frame` / `lobium-device-screen` are missing. I suggest replacing step 4 with
that.

Note this check will still read "missing" after a correct Windows rebuild if §5.1 holds and the hooks
stay `IS_LINUX`-guarded — though for a different reason. The switch *constants* live in the
unconditionally-compiled `lobium_device_frame_view.cc` (patch line 243), so after a rebuild I would
expect the strings to appear while the frame still does not render. Worth knowing before that is
mistaken for success.

### 6.3 The timestamp table's ordering is an artifact of mixed timezones

The rebuild doc's central table reads:

| | |
|---|---|
| `45a4480` published the win-x64 engine | 2026-08-25 **20:11** |
| `30ed714` made the device frame link | 2026-08-25 **23:14** |

**[measured] Those two timestamps are in different timezones** — `45a4480` is `20:11:38 -0700`,
`30ed714` is `23:14:00 +0200`. Normalised to UTC the order reverses:

```
30ed714  2026-08-25 21:14:00 UTC   device frame links
45a4480  2026-08-26 03:11:38 UTC   win-x64 engine published   (5h58m LATER)

git merge-base --is-ancestor 30ed714 45a4480  →  true
```

So the publish commit's *tree already contained* the device-frame fix. The conclusion "the published
binary has no device frame" is still correct — proved from the bytes in §5.2 — but the mechanism is
not "committed three hours too early". It is that **the archive was built from an older tree than the
commit that published it**, which is a provenance failure, and a different problem with a different
fix (build-stamp the archive rather than reasoning about commit order).

### 6.4 The rebuild's acceptance criterion has the wrong capability count

`docs/qa/2026-08-26-windows-engine-rebuild.md` acceptance: *"prints contract version 3 with **19**
names."*

**[measured]** A correct Windows build printed **20** when I probed it — 19 portable plus
`font-isolation`, which is `BUILDFLAG(IS_WIN)`-gated. 19 is the Linux count; `docs/STATUS.md:25-26`
already said so, and as written the criterion would have rejected a correct build.

Adding `device-frame` (§5.2) moves both: a current build prints **21 on Windows and 20 on Linux**.
The rebuild doc and `docs/STATUS.md` now say 21.

### 6.5 Two smaller notes

- **Vulkan artifacts.** The brief asks about the `.dll` equivalents of
  `libVkLayer_khronos_validation.so` / `libVkICD_mock_icd.so`. **[measured]** The DLLs are **not**
  shipped. But their **layer manifests are**: `angledata/VkLayer_khronos_validation.json` and
  `angledata/VkICD_mock_icd.json`. Real Chrome ships neither, so the brief's concern does apply on
  Windows — just to two small JSON files rather than 28 MB of code. No PDBs are shipped.
- **Series state.** `branding/device-frame.patch` is confirmed the last line of
  `lobium/patches/series`, as Phase 3 step 1 requires.

---

## 7. What I am uncertain about

- **Whether the 3D defect is real on a real GPU at all.** Neither host in this project has one. Both
  render the mascots correctly. The report came from a user's machine, and nothing here can stand in
  for it. Getting the diagnostic JSON from *the reporter's* machine would settle in one run what no
  amount of work on these two boxes can.
- **Whether porting the device frame to Windows is a small job or a large one.** I established that
  it is not built there; I have not scoped the Windows `BrowserFrame` work.
- **`navigator.gpu` on a software backend.** The repo contradicts itself — `docs/STATUS.md:16` says
  `requestAdapter()` returns null, `docs/qa/2026-08-23-fingerprint-defect-register.md:62` says
  `navigator.gpu` is undefined. My own run reports `webgpu: "unavailable_software"`, a third
  description. I have not reconciled these.
- **Whether the Linux archive shares the Windows one's provenance problem.** I proved the Windows
  archive was built from a tree without the device-frame patch. I have not checked whether the Linux
  archive's contents match the commit that published it.
- **`engine-audit.md` cross-check.** The register is 2,261 lines and I read it through a delegated
  reader rather than end to end myself. Its open findings are not individually re-verified here.
- **The four "known contradictions" are confirmed in source, not in a browser.** `colorDepth = 30`
  for arm64 (`derive.ts:234`), no `enable_widevine` in either gn-args file, no codec hook anywhere,
  and the unhooked `(color:)` path are all read from the code. Phase 2 was to be the measurement, and
  §6.1 is why it cannot be taken here as briefed.
