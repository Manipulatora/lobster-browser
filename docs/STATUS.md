# Project Status — What Exists, What Runs Where

Status date: 2026-08-15. Written as the orientation document for an engineer or agent picking this
repository up on a new machine. It records what is true today, not what is planned; the plans live in
[`ENGINEERING.md`](ENGINEERING.md) §5 and [`LOBEE_AGENT_ROADMAP.md`](LOBEE_AGENT_ROADMAP.md).

> **Read [`ENGINE_AUDIT.md`](ENGINE_AUDIT.md) before making any anti-detect claim about this build.**
> An end-to-end, adversarially-verified audit of the engine (2026-08-14) returned **79 findings — 10
> critical, 19 high**, most of them still open. Four of the criticals are Windows-specific: timezone
> is not spoofed at all, fonts are not isolated at all, WebGPU is enabled and completely unhooked, and
> WebGL2 is largely uncovered. The engine is a solid native foundation with real gaps, not a finished
> anti-detect product.

## 1. What this repository contains

Four deliverables share one monorepo:

| Deliverable | Path | State |
| --- | --- | --- |
| **Desktop app** — Tauri 2 (Rust) + React UI, the product | `apps/desktop` | Builds and runs on Linux. Linux-only bundle target. |
| **Lobium engine** — Chromium 152 fork with native fingerprinting | `lobium/` (build scripts + patches) | Builds on Linux. Windows build path now exists and configures cleanly (`lobium/build.ps1`); a first Windows binary is being produced. |
| **Marketing site** — Angular 22 SSR/SSG | `apps/web` | Live at `lobrowser.com`, deployed from this machine. |
| **Cloud backend** — NestJS (auth, teams, sync, billing) | `apps/backend` | In-repo; not covered by this document. |

The engine is **not** bundled into the installer. `apps/desktop/src-tauri/resources/engine-manifest.json`
declares a URL + SHA256, and the Rust core streams and extracts that tarball on first run. This is why the
`.deb` is small and why platform support is a manifest question as much as a build question.

**Engine version — rebuild outstanding (2026-08-14).** The repo was pinned to Chromium `152.0.7928.0`,
which is a **canary nightly**, not a release. For an anti-detect product that is worse than being stale:
`getHighEntropyValues(['fullVersionList'])` returns the real build, so a nightly nobody runs is close to a
globally unique identifier. It went unnoticed because `scripts/track-upstream.mjs` compared version
ordering only — `152 > 151` read as "UP TO DATE". The source pins now target `152.0.7977.42` (M152
beta-frozen; M152 scheduled stable 2026-08-25) and both halves are enforced (`track-upstream.mjs` checks
channel membership online, `ci/validation/version-coherence.test.mjs` gates offline on every PR).
**The published engine tarball is still the old build** — `engine-manifest.json` declares this as
`rebuildPending`, and clearing it needs the Linux build host (see `docs/OPERATIONS.md` §1.1).

## 2. Platform support — the honest matrix

| Component | Linux x64 | Windows x64 | macOS |
| --- | --- | --- | --- |
| Rust/Tauri core | Ships | **Builds and runs** (2026-08-14) | Untested |
| Sidecar (`engine-runner`) | Ships | **Verified** — bundled sidecar answers `ping`/`status` over stdio under the vendored `node.exe`, and the Lobee loopback bridge binds | Untested |
| Vendored Node runtime | Ships | **Fixed** — official win-x64 `node.exe`, SHA256-verified against nodejs.org | Untested |
| Lobium engine | Ships | **Built** — 152.0.7977.42, `is_official_build` + PGO + ThinLTO. Binary not yet published to a manifest. | Does not exist |
| Installer bundle target | `deb` | `nsis` (`tauri.windows.conf.json`) | Not configured |
| Font isolation | Ships (fontconfig) | **Ships (DirectWrite)** — native filter + font-pack sideload | Not implemented |
| Runtime packaging | `package-lobium-runtime.sh` | `package-lobium-runtime.ps1` | Not implemented |
| Fingerprint personas | Ships | Ships (~1.8k Windows presets) | Ships (~200 presets) |

Build it with `scripts/build-windows-product.ps1` (the Windows counterpart to
`build-linux-product.sh`); see [`OPERATIONS.md`](OPERATIONS.md) §2.3.

Of the three blockers this section used to list, all three are now closed, and one packaging step
remains:

1. **Windows engine — built; the published artifact is what is left.**
   The engine compiles and links natively on this host at 152.0.7977.42 with `is_official_build`,
   PGO and ThinLTO. Chromium cannot be cross-compiled from Linux to Windows and cannot be built from
   WSL, so this needed a *native* Windows host, which now exists and is configured (see §3).

   `engine-manifest.json` is now a **per-platform map**. That was not cosmetic: the flat manifest
   would have handed a Windows install the `linux-x64` tarball, unpacked a `chrome` ELF, reported
   provisioning success, and failed at first launch with an unrelated-looking error. A platform with
   no entry now fails immediately and says why. The `win-x64` entry is deliberately absent until an
   archive is uploaded — naming a URL before the artifact exists means every Windows first run 404s
   after an ~840 MB download.

   Until then the Windows app installs, opens, and manages profiles/proxies but **cannot launch a
   profile**: `startProfile` refuses any engine but Lobium, so it fails closed rather than falling
   back to an unprotected browser.

   The two correctness blockers that had to close before a Windows launch was *correct* rather than
   merely possible are both closed in the engine:
   - `timezone-tz-env-noop-on-windows` → `fingerprint/native-timezone.patch`. The fix is hooked at
     `TimeZoneController::OnTimeZoneChange`, not at renderer start: the browser's
     `device::TimeZoneMonitor` pushes the host zone to every renderer shortly after startup and
     overwrites anything adopted earlier.
   - `fonts-fontconfig-inert-on-windows` → `fingerprint/windows-font-isolation.patch` (see below).
2. ~~The vendored Node binary is a Linux ELF~~ — **closed.** `build-windows-product.ps1` downloads the
   official win-x64 archive and verifies it against `SHASUMS256.txt` instead of copying the build host's
   interpreter. `resolve_node_bin` now probes `node.exe`.
3. ~~`targets: ["deb"]`~~ — **closed.** Platform configs (`tauri.windows.conf.json` /
   `tauri.linux.conf.json`) select `nsis` / `deb`, and Windows sets
   `webviewInstallMode: downloadBootstrapper` since WebView2 is not guaranteed on Windows 10.

**Font isolation now exists on Windows, through a different mechanism.** Fontconfig does not exist
there — Chromium resolves fonts through DirectWrite in the *browser* process — so the isolation is
native rather than environmental. `buildLobiumLaunchEnv()` no longer throws on Windows; it returns
early without the POSIX locale variables, because setting `TZ` there would look like the timezone was
handled when ICU ignores it.

Three surfaces are filtered, because a filter on one is bypassed by the others: `FindFamily` (behind
every `font-family:` resolution and the width-measurement probe), `MatchUniqueFont` (behind
`src: local(...)`, which bypasses `FindFamily` entirely), and the Local Font Access enumerator.

**Filtering is only half of it, and the other half is packaging.** A filter can subtract host fonts
the persona does not claim; it cannot add fonts the persona claims that the host lacks, and a persona
measurably *missing* fonts is its own tell. The engine sideloads the profile's font pack into its
DirectWrite collection from `fontPackDir`.

The pack rides with the **engine archive**, not the installer: `package-lobium-runtime.ps1` writes it
to `fonts/` beside `chrome.exe`, which is the first location `resolveFontsBaseDir()` checks. So
`tauri.windows.conf.json` needs no `resources/fonts` entry — the pack and the engine that consumes it
travel together, and an installer can never be out of step with the engine over it.

Without a pack the measurable set is host ∩ persona: narrower than claimed, but never wider than the
host — degraded, not leaking, which is why this path fails open where the Linux one fails closed.

One consequence worth recording: populating `fonts` in the native config was previously refused
because the browser base64s the whole config document onto the renderer command line, Windows caps
that line at 32767 characters, and exceeding the engine's 28 KiB guard makes the browser drop the
switch — so every renderer reports the *host* platform and hardware concurrency. The engine now
strips `fonts` and `fontPackDir` from the renderer copy (they are browser-only), which is what makes
shipping the full list safe.

Windows-specific defects found and fixed on 2026-08-14 (all were silent failures):
`user_engine_runtime_dir()` read `HOME`, which is unset on Windows, so engine provisioning could never
resolve a path; `engine_present()` and the discovery candidates hard-coded `chrome` rather than
`chrome.exe`; `resolve_node_bin` probed only POSIX names; `bundle-sidecar.mjs` spawned `npm` (a `.cmd`
that Node refuses to exec without a shell since CVE-2024-27980) and exited 1 printing nothing; and
`build-lobee.mjs` ran `node node_modules/.bin/vite`, which is a shell shim on Windows.

## 3. Build hosts — what can be built where

Chromium's own requirements, checked against `lobium/gn-args.gn.example`:

- **Disk:** the args set `symbol_level = 0` and `blink_symbol_level = 0`, which is the biggest saver. Source
  checkout (~50–70GB on Windows) + `out/` (~30–60GB without symbols) + VS/SDK (~20–30GB) lands near the
  ~150GB the `lobium/build.sh` header quotes.
- **RAM:** `is_official_build` + `use_thin_lto` makes the `chrome.dll` link the peak. 16GB is the documented
  minimum, 32GB the comfortable figure. On 24GB, set `concurrent_links = 1` or the link can OOM.
- **CPU:** 8 cores is fine but slow. **Measured on this host** (8 vCPU EPYC 7B13, 24GB, output on a
  fast local volume): a steady **160 compile steps/minute**, so ~4.7h of compilation for the ~48k
  steps of `chrome`, plus the ThinLTO link. Budget 6–8h wall clock for a clean official build.

### 3.1 Windows build host — the prerequisites that are not obvious

`lobium/build.ps1` is the native Windows driver (`build.sh` is bash-only, and its `quilt push -a`
step has no Windows equivalent — that is what the note at the end of this section used to describe).
It stages, patches, configures and builds, and it is idempotent. Its preflight exists because every
one of these failed silently or late on a fresh host:

| Prerequisite | Symptom when missing |
| --- | --- |
| VS 2022 with the **C++ ATL** component | ~2,000 objects compile, then `base/win/atl_throw.cc` dies with `'atldef.h' file not found` after 13 minutes |
| VS installed **outside** `%ProgramFiles%` | `gn gen` fails with `No supported Visual Studio can be found`; `build/vs_toolchain.py` only probes the default root. Fixed by exporting `vs2022_install`, which the script derives from `vswhere` |
| Windows SDK **Debugging Tools** | Chromium's Windows toolchain requires them |
| `checkout_pgo_profiles` in `.gclient` | `chrome_pgo_phase = 2` has no profile |
| The **V8 builtins** PGO profile (a second, separate artifact) | ninja schedules everything, then fails with `v8/tools/builtins-pgo/profiles/x64-rl.profile … missing and no known rule to make it` |
| NTP brand icons staged into the tree | `branding/ntp-branding.patch` adds four PNGs to a `generate_grd` input list; GN fails if they are absent. `build.ps1` stages them from `lobium/assets/ntp-icons/` |

Windows Defender must exclude the checkout and the compiler processes, or the build roughly halves
in speed.

**GitHub Actions cannot build the engine on a hosted runner.** A hosted `windows-latest` gives roughly
4 vCPU / 16GB / ~14GB free disk against a ~150GB requirement, jobs are killed at 6 hours, and the Actions
cache is capped at 10GB per repository so `out/` cannot be checkpointed between jobs. The engine build must
run on a **self-hosted** runner. This repository already uses that pattern —
`.github/workflows/agent-battery.yml` runs on `[self-hosted, agent-battery]` with a 240-minute timeout, and
`real-gpu-gate.yml` on `[self-hosted, gpu]`.

The **installer** has no such problem: a hosted `windows-latest` runner builds a Tauri bundle in minutes.
Splitting the two matches how often each changes — the engine per Chromium bump, the installer per release.

### 3.2 The patch series

The series was refreshed onto `152.0.7977.42` and restructured on 2026-08-14. It had rotted in a way
that made it unbuildable: `core/config-channel.patch` was 64KB across 19 files, and **21 of its 55
hunks were byte-identical copies of hunks in three other patches**, so `patch --forward` reported
those three as "previously applied", exited non-zero, and aborted the whole apply. It is now one
patch per concern — the transport, `navigator`/UA-CH, canvas, and WebGL each own their own hunks —
with the restructure proven behaviour-preserving by a byte-identical tree diff.

`ci/validation/patch-series.test.mjs` locks the invariants offline: no hunk body in two patches, no
malformed header, hunk counts matching their bodies, no overlapping hunks, LF-only UTF-8 without a
BOM (CRLF applied under GNU patch but `git apply` rejected it outright), ASCII-only added source, and
the ordering chains that must hold because later patches are cut against earlier ones.

`node lobium/regen-patch.mjs <patch>` folds an edit made in the checkout back into its patch, and
**refuses** to regenerate a patch that shares a file with another — `git diff` would silently absorb
the other patch's hunks. `lobium/hooks.md` documents every hook point and, more importantly, the
coverage boundary.

## 4. What a fresh clone does not include

`.gitignore` correctly excludes build output and secrets, so a clone is ~84MB and needs provisioning:

| Missing | Restore with |
| --- | --- |
| `node_modules/` | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` |
| `apps/desktop/src-tauri/resources/{sidecar,node,fonts,lobee}` | `node scripts/bundle-sidecar.mjs`, `node scripts/build-lobee.mjs`, and the vendoring steps in `build-linux-product.sh` |
| `packages/lobee/` | `node scripts/build-lobee.mjs` (rm -rf's and rewrites it) |
| `.env` | Recreate from `.env.example`. The only key here is `VENICE_API_KEY`, used by `scripts/venice-chat.mjs`. |
| The Lobium engine | Downloaded on first run per `engine-manifest.json`, or pointed at a local build via `LOBSTER_LOBIUM_BIN` |
| `ci/validation/reports/` | Regenerated by the validation harnesses |

`engine-manifest.json` **is** tracked — it is configuration, not build output, and it is the only file under
`resources/` in git.

Profile data (`profiles.sqlite`, `secrets.key`, per-profile dirs) lives in the OS app-data directory
(`~/.local/share/com.lobster.browser/` on Linux), never in the repository. It does not travel with a clone,
and uninstalling the app does not remove it.

## 5. Verification status

Read [`ENGINEERING.md`](ENGINEERING.md) §4 and [`LOBEE_AGENT_ROADMAP.md`](LOBEE_AGENT_ROADMAP.md) §4 for the
full picture. The short version, because it is easy to overstate:

- The **software gate** (`regression-gate.mjs`) runs anywhere: coherence, device-class diversity floors, and
  fingerprint unit contracts. It reads no baseline and launches no browser.
- The **offline structural gates** run anywhere and are fast: `patch-series.test.mjs` (no duplicated
  hunk, no malformed header, LF+ASCII, ordering chains, and the capability contract agreeing across
  the native list / the TypeScript mirror / the series), `version-coherence.test.mjs` (the three
  version pins agree, none is a canary, and every platform entry in the engine manifest is well
  formed), and `lobium/test/run.ps1` — property tests that compile the SHIPPING canvas and audio
  kernels from `lobium/src/` and assert the detection oracles directly (a solid fill reads back
  byte-exact, a 1x1 read agrees with a full read, the putImageData round trip is a fixed point, a
  constant audio input renders constant, the canonical audio sum stays inside the honest population
  spread).
- The **series reproducibility gate** (`npm run gate:series`) needs the Chromium checkout but no
  browser. It replays the whole series into a scratch tree built from pristine git blobs and diffs
  the result against the checkout. This is the only check that the patches produce the binary that
  was actually tested — a hook present in the checkout but missing from its patch would otherwise
  ship a clean build with the hook gone, while the capability manifest still advertised it (the
  manifest lives in the staged module, not in a patch). Currently: **29 patches apply cleanly to
  pristine and reproduce all 64 patched files exactly.**
- The **audit oracle gate** (`audit-oracles.mjs`) needs the native binary. It runs the detection
  oracles from `ENGINE_AUDIT.md` *in the browser*, which is the only way to prove a kernel fix
  actually reaches the page. It distinguishes a **regression** (a finding marked fixed that fails
  again — non-zero exit) from a **known-open** finding (reported, does not fail), so a green run
  never implies the audit is closed.
- The **font-isolation gate** (`npm run gate:fonts`) needs the native binary and its own launch,
  because its whole method is a deliberately unrealistic config: three claimed families, then measure
  which families the page can still resolve. Against a realistic persona this measurement is nearly
  blind — the persona claims most of what a Windows host has installed, so "resolves" and "should
  resolve" agree whether or not the filter runs. With three, every extra resolution is a leak, and a
  negative control (a family that exists nowhere) proves the measurement itself discriminates.
- The **engine gates** (`battle-test.mjs`, `deep-probe-50.mjs`) need the native binary, and
  `battle-test.mjs` reports a deep-GPU tell on a software renderer — so this host cannot produce a
  release-valid verdict from them.
- The **real-GPU detection gate** is the release blocker and requires real hardware; the evidence policy in
  `detector-matrix.json` rejects software renderers.
- The **paid live agent battery** has not been run. Deterministic grader success is not a live
  model/browser pass.

This build host has no real GPU (SwiftShader only), so W1 data capture and the W5 live detection gate
cannot execute here — only their code and schemas can.

### 5.1 Audit findings closed in the engine

`ENGINE_AUDIT.md` is generated and must not be hand-edited, so progress against it is recorded here.
Each of these is closed by a patch in the series and compiles into the shipping binary; the ones with
an oracle are additionally checked in-browser by `audit-oracles.mjs`.

| Finding | Closed by | Oracle |
| --- | --- | --- |
| `pack-row-length-disables-webgl-farble` (critical) | `fingerprint/webgl-bypass-closures.patch` — the farble gate keys on effective geometry, and user framebuffers are covered | `webgl-pack-row-length-still-farbles` |
| `timezone-tz-env-noop-on-windows` (critical) | `fingerprint/native-timezone.patch` | `timezone-is-the-persona-zone`, `timezone-agrees-in-worker` |
| `fonts-fontconfig-inert-on-windows` (critical) | `fingerprint/windows-font-isolation.patch` | `fonts-limited-to-the-persona-set`, plus the dedicated `gate:fonts` |
| `webgpu-adapter-unhooked` (critical) | `fingerprint/webgpu-adapter.patch` | `webgpu-adapter-matches-webgl-renderer` |
| `webgl2-extension-list-served-from-webgl1-persona` | `fingerprint/webgl-bypass-closures.patch` | `webgl2-extensions-are-the-webgl2-list` |
| `webgl2-getparameter-never-hooked` (partly) | `fingerprint/webgl2-surfaces.patch` — the component limits; the feature-level constants are deliberately left honest, see `hooks.md` §5 | `webgl2-components-are-4x-webgl1-vectors` |
| `contract-is-a-hardcoded-literal`, `phantom-capabilities-timezone-acceptlang` | the list moved to `components/lobium_fp/lobium_capabilities.cc` beside the hooks, `font-isolation` is `BUILDFLAG(IS_WIN)`-gated, and CI cross-checks the three copies | — |
| `media-devices-id-shape` | `lobium_media_devices.{h,cc}` reproduces Chrome's origin-keyed HMAC-SHA256 construction | `mediadevices-ids-have-chrome-shape` |

Two fixes that a source-only review would have gotten wrong, recorded so they are not retried:

- **Timezone.** The audit's suggestion was to hook `RenderThreadImpl::Init`. That does not survive:
  the browser's `device::TimeZoneMonitor` pushes the host zone to every renderer shortly after
  startup and overwrites anything adopted earlier. The hook is at
  `TimeZoneController::OnTimeZoneChange`, the receiving end of that push.
- **Fonts.** The first implementation hooked `DWriteFontProxyImpl`, which every older Chromium source
  and every guide describes as the Windows font path. It had **no effect at all** — measured in the
  running browser, every installed family still resolved while the config listed three. M152 sets
  `kFontDataServiceAllWebContents` to `FEATURE_ENABLED_BY_DEFAULT`, so `InitializeFontIntegration`
  routes the renderer to `font_data_service::FontDataManager` and the DWrite proxy is off the CSS
  matching path entirely. Both are now hooked, since either can be live depending on flags. This is
  the clearest argument for the in-browser gates: the patch read as complete and compiled clean.

Two capability gaps that the new CI cross-check surfaced, neither previously tracked in the audit:
`screen-metrics` and `mobile-persona` were shipped, compiled surfaces with no capability name, so the
sidecar could not require them and therefore could not guarantee them. Both now have one.
