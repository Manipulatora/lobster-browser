# Project Status — What Exists, What Runs Where

Status date: 2026-08-23. This is the orientation document for an engineer or agent picking this
repository up on a new machine. It records what is true today, not what is planned; the plans live in
[`ENGINEERING.md`](ENGINEERING.md) §5 and [`LOBEE_AGENT_ROADMAP.md`](subsystems/agent.md).

> **The series has now been measured in a browser — on Linux, once, on 2026-08-21.**
>
> A `linux-x64` engine was built from the then-current series at `152.0.7977.42` on the Linux host and
> `gate:oracles` scored it: **37 of 43 oracles pass, 10 of 15 aspects green, one real regression**
> (`canvas-getpixelmods-toblob` — `toBlob` and `getImageData` disagree on ~65-72 of 256 bytes, and
> the count varies per run, so the two paths are drawing different noise rather than the same
> seeded farble). The gate therefore exits `FAIL`, not `BLOCKED` — it is now describing the engine
> instead of the environment, which is the distinction that matters.
>
> What that does NOT cover: `webgpu` (this host has no real GPU, `requestAdapter()` returns null),
> `fonts` (Windows-only by nature), and `networkTls`/`networkHttp2` (no stock Chrome 152 is pinned
> or installed to compare a ClientHello against). Those four aspects remain unmeasured, and no
> real-GPU run has happened. Treat §5.1 closures on Windows-only surfaces as *compiled and
> reviewed*; the rest now have one Linux datapoint behind them.
>
> **Every existing native artifact now predates the source contract.** `engine-manifest.json` names
> the old Linux `152.0.7928.0` artifact, while the locally built Linux and Windows binaries predate
> the contract-v3 and native-policy privacy fixes finalized on 2026-08-24. The launcher refuses all of them.
> Current source advertises 19 capabilities on Linux and 20 on Windows (the extra hook is Windows
> font isolation); a clean rebuild and a new oracle run are required before either can be published.
>
> **Superseded on 2026-08-26, measured on the Windows host.** The two paragraphs above are stale and
> are kept because the reasoning around them still holds:
>
> * `engine-manifest.json` no longer names `152.0.7928.0` and no longer carries a `rebuildPending`
>   block. Both platforms are at `152.0.7977.42`, and the `win-x64` entry carries a `stale` marker
>   explaining why its bytes must not be shipped.
> * Artifacts are served from `lobrowser.com`, not GitHub. **Measured from the Windows host:** the
>   Linux archive is live (`HTTP 200`, 270,688,368 bytes); the Windows archive returns **`HTTP 404`**
>   and has never been uploaded, so Windows first-run provisioning cannot succeed today.
> * The capability counts are confirmed by probing the shipped Windows runtime: contract version 3,
>   **20 names** (19 portable plus `font-isolation`). Adding `device-frame` on 2026-08-26 makes it
>   **21 on Windows and 20 on Linux** once the current rebuild lands.
> * `branding/device-frame.patch` was **Linux-only in source** until 2026-08-26 — 11
>   `BUILDFLAG(IS_LINUX)` guards, zero `IS_WIN` — so the Windows binary compiled `LobiumDeviceFrameView`
>   and then dropped it at link time, and an Android profile opened with no phone stage. The guards
>   now cover Windows. See `docs/qa/2026-08-26-windows-understanding.md`.
>
> The audit itself (2026-08-14) returned **79 findings — 10 critical, 19 high**. Most remain open.
> This is a solid native foundation with real, documented gaps, not a finished anti-detect product.

## 1. What this repository contains

Six deliverables share one monorepo:

| Deliverable | Path | State |
| --- | --- | --- |
| **Desktop app** — Tauri 2 (Rust) + React UI, the product | `apps/desktop` | Builds and runs on Linux and Windows. Per-platform bundle targets (`deb` / `nsis`). |
| **Lobium engine** — Chromium fork with native fingerprinting | `lobium/` (build scripts + patches) | Series is cut against `152.0.7977.42`. Existing binaries are stale against the current series and capability contract; see §3. |
| **Sidecar** — profile lifecycle, CDP, agent bridge | `packages/engine-runner` | Ships on Linux and Windows. |
| **Lobee agent** — in-browser side panel | `packages/agent`, `packages/lobee-app` | Ships. Plus/Pro/Max only, metered per call. See [`subsystems/agent.md`](subsystems/agent.md). |
| **Cloud backend** — NestJS (auth, teams, sync, billing, model proxy) | `apps/backend` | Live at `api.lobrowser.com`. See [`subsystems/billing-and-auth.md`](subsystems/billing-and-auth.md). |
| **Marketing site + dashboard** — Angular 22 SSR/SSG | `apps/web` | Live at `lobrowser.com`. |

The engine is **not** bundled into the installer. `apps/desktop/src-tauri/resources/engine-manifest.json`
declares a per-platform URL + SHA-256, and the Rust core streams and extracts the archive on first run.
This is why the installer is small and why platform support is a manifest question as much as a build
question.

**Engine version — rebuild outstanding.** The repo was pinned to Chromium `152.0.7928.0`, which is a
**canary nightly**, not a release. For an anti-detect product that is worse than being stale:
`getHighEntropyValues(['fullVersionList'])` returns the real build, so a nightly nobody runs is close to
a globally unique identifier. It went unnoticed because `scripts/track-upstream.mjs` compared version
ordering only — `152 > 151` read as "UP TO DATE". The source pins now target `152.0.7977.42` and both
halves are enforced (`track-upstream.mjs` checks channel membership online,
`ci/validation/version-coherence.test.mjs` gates offline on every push).

**The published engine tarball is still the old build.** `engine-manifest.json` declares this in a
`rebuildPending` block, and clearing it needs a completed engine build (§3).

## 2. Platform support — the honest matrix

**Windows x64 is the owner's first target platform.** Linux x64 is the development platform and the only
one with a published engine artifact. macOS is neither built nor configured.

| Component | Windows x64 | Linux x64 | macOS |
| --- | --- | --- | --- |
| Rust/Tauri core | Builds and runs | Builds and runs | Untested |
| Sidecar (`engine-runner`) | Verified — bundled sidecar answers `ping`/`status` over stdio under the vendored `node.exe`, and the Lobee loopback bridge binds | Ships | Untested |
| Vendored Node runtime | Official win-x64 `node.exe`, SHA-256 verified against nodejs.org | Ships | Not implemented |
| Lobium engine | Prior official/PGO/ThinLTO `152.0.7977.42` build exists, but is **stale and refused** by contract v3. Clean rebuild required. | Published `152.0.7928.0` and later local build are both **stale and refused** (§5) | Does not exist |
| Installer bundle target | `nsis` (`tauri.windows.conf.json`) | `deb` (`tauri.linux.conf.json`) | Not configured |
| Engine archive form | `.zip` | `.tar.gz` | — |
| Font isolation | Native (DirectWrite filter + font-pack sideload) | Environmental (`FONTCONFIG_FILE` + private pack) | Not implemented |
| Runtime packaging | `package-lobium-runtime.ps1` | `package-lobium-runtime.sh` | Not implemented |
| Fingerprint personas | Ships (~1.8k presets) | Ships (~1.6k presets) | Ships (~200 presets) |

Build the desktop app with `scripts/build-windows-product.ps1` or `scripts/build-linux-product.sh`; see
[`OPERATIONS.md`](OPERATIONS.md) §2.

### What is left before a Windows launch works

**Rebuild, verify, then publish a `win-x64` engine archive.** The prior official build predates the
current patch series and semantic capability contract. Force-clean the pinned checkout, apply all
patches, rebuild with official/PGO/ThinLTO settings, and run the native oracles before packaging.
`engine-manifest.json` has no `win-x64` entry deliberately: naming a URL before the current artifact
exists makes every Windows first run 404 or install a stale engine. An absent entry fails immediately
and says why.

Until then the Windows app installs, opens, and manages profiles, proxies and templates but **cannot
launch a profile**: `startProfile` refuses any engine but Lobium, so it fails closed rather than falling
back to an unprotected browser.

The manifest is a **per-platform map**, which was not cosmetic. The flat manifest would have handed a
Windows install the `linux-x64` tarball, unpacked a `chrome` ELF, reported provisioning success, and
failed at first launch with an unrelated-looking error. Its shape today:

```
{ engine, note, platforms: { "<platform-id>": { version, url, sha256 } },
  rebuildPending: { targetVersion, why, howToClear },
  win-x64Pending: { why, howToClear } }
```

`rebuildPending` and `win-x64Pending` are top-level siblings of `platforms`, not entries inside it. The
Rust core (`engine_provision.rs`) reads neither — they exist for the coherence gate and for humans. It
resolves `platforms[engine_platform_id()]`, where the id comes from the **compile target**, not a runtime
probe, so Rosetta or Windows-on-ARM cannot mislead it. A platform with no entry is a hard error naming
the ids that do exist; no download is attempted.

Correctness work that had to land before a Windows launch was *correct* rather than merely possible:

- `timezone-tz-env-noop-on-windows` → `fingerprint/native-timezone.patch`. Hooked at
  `TimeZoneController::OnTimeZoneChange`, not at renderer start: the browser's `device::TimeZoneMonitor`
  pushes the host zone to every renderer shortly after startup and overwrites anything adopted earlier.
- `fonts-fontconfig-inert-on-windows` → `fingerprint/windows-font-isolation.patch` (below).
- The engine archive is a `.zip` on Windows and `extract_and_swap` was hard-wired to gzip + tar. The
  archive form is now read from the file's own magic bytes (`1f 8b` gzip, `PK` zip) rather than from the
  URL, because a release asset can be redirected, renamed, or served with any content-type.

**Font isolation on Windows works through a different mechanism.** Fontconfig does not exist there —
Chromium resolves fonts through DirectWrite in the *browser* process — so the isolation is native rather
than environmental. `buildLobiumLaunchEnv()` returns early on Windows without the POSIX locale variables,
because setting `TZ` there would look like the timezone was handled when ICU ignores it.

Three surfaces are filtered, because a filter on one is bypassed by the others: `FindFamily` (behind every
`font-family:` resolution and the width-measurement probe), `MatchUniqueFont` (behind `src: local(...)`,
which bypasses `FindFamily` entirely), and the Local Font Access enumerator.

**Filtering is only half of it; the other half is packaging.** A filter can subtract host fonts the persona
does not claim; it cannot add fonts the persona claims that the host lacks, and a persona measurably
*missing* fonts is its own tell. The engine sideloads the profile's font pack into its DirectWrite
collection from `fontPackDir`. The pack rides with the **engine archive**, not the installer, so an
installer can never be out of step with the engine over it. Without a pack the measurable set is
host ∩ persona: narrower than claimed, never wider than the host — degraded, not leaking, which is why
this path fails open where the Linux one fails closed.

> **Correction, 2026-08-26, measured on the Windows host: the "fails open" half of that last sentence
> is not what the engine does.** The *privacy* claim is right — the set is never wider than the host —
> but the *availability* claim is wrong. Launched with a persona whose claimed families are absent
> from the host and no pack (an Android persona claiming Roboto / Noto Sans / Droid Sans / Google
> Sans on a stock Windows host), the engine logs
> `lobium_fonts.cc:535 Lobium: restricted Windows character fallback could not be built` and then
> **never produces a page target at all** — `/json/list` returns only `browser_ui` entries
> indefinitely. That is not a degraded launch; it is a browser that starts and does nothing,
> explained only by one line in a log.
>
> The product does not normally reach this state, because `buildLobiumLaunchArgs` stages and verifies
> a pack before writing the config. But nothing *prevents* reaching it — a quarantined, deleted or
> corrupt pack at runtime lands exactly here — and the honest behaviour would be to refuse the launch
> with a message naming the pack rather than to hang. Recorded rather than fixed: the fix belongs in
> the engine, not the launcher.

One consequence worth recording: populating `fonts` in the native config was previously refused because
the browser base64s the whole config document onto the renderer command line, Windows caps that line at
32767 characters, and exceeding the engine's 28 KiB guard makes the browser drop the switch — so every
renderer reports the *host* platform and hardware concurrency. The engine now strips `fonts` and
`fontPackDir` from the renderer copy (they are browser-only), which is what makes shipping the full list
safe.

Windows-specific defects found and fixed, all of which were silent failures: `user_engine_runtime_dir()`
read `HOME`, which is unset on Windows; `engine_present()` and the discovery candidates hard-coded
`chrome` rather than `chrome.exe`; `resolve_node_bin` probed only POSIX names; `bundle-sidecar.mjs`
spawned `npm` (a `.cmd` that Node refuses to exec without a shell since CVE-2024-27980) and exited 1
printing nothing; `build-lobee.mjs` ran `node node_modules/.bin/vite`, which is a shell shim on Windows;
`verify-series.mjs` joined patch paths with a literal backslash and defaulted the tree to
`E:\lobium-build\src`; and `LOBSTER_UPLOAD_ROOTS` was split on a literal `':'`, which turns
`C:\Users\me\uploads` into two roots that resolve to nothing, so every upload was refused.

## 3. Build hosts — where the engine can actually be built

**The engine CAN be built on the Linux dev host, and was, on 2026-08-21.** This section previously
said it could not; that was a statement about the checkout being stale, not about the hardware. The
box is 12 cores / 47 GB / ~300 GB free, which is enough.

What the sync actually costs is worth recording, because the obvious command is a trap:

- `gclient sync` runs a bare `git fetch origin --no-tags`, which makes Chromium's server enumerate
  every release branch. It ran **1h55m**, moved almost nothing, tripped gclient's own
  `STALL DETECTED` warnings and timed out. So did `git fetch --tags`.
- Fetching the single ref instead — `git fetch origin +refs/tags/<ref>:refs/tags/<ref>` — completed
  in ~13 minutes at ~5 MB/s. After that, `git rev-list --objects <ref> --not --all` returned **0**,
  proving nothing further was needed, and `git checkout --force --detach <ref>` took **17 seconds**.
  A `gclient sync` pinned to the resolved SHA then synced all 270 DEPS submodules in ~15 minutes.
- Budget the compile at ~8.5 h for a cold official build on this host. A rebuild after a one-patch
  change is ~45 min, because siso hashes content and reuses the object cache.

`npm run gate:series` still fails on a host whose checkout has moved on from the patch bases; that is
the gate working correctly. It is a reproducibility check, not a build prerequisite.

The last engine actually produced on this host predates the current series and semantic capability
contract; it is a development artifact that the launcher correctly refuses, not a release candidate.

Chromium's own requirements, checked against `lobium/gn-args.gn.example`:

- **Disk:** the args set `symbol_level = 0` and `blink_symbol_level = 0`, the biggest saver. Source
  checkout (~50–70 GB on Windows) + `out/` (~30–60 GB without symbols) + VS/SDK (~20–30 GB) lands near the
  ~150 GB the `lobium/build.sh` header quotes.
- **RAM:** `is_official_build` + `use_thin_lto` makes the `chrome.dll` link the peak. 16 GB is the
  documented minimum, 32 GB the comfortable figure. **Do not set `concurrent_links`** — with ThinLTO it
  is illegal, not merely redundant: `//build/toolchain/concurrent_links.gni` asserts
  `!use_thin_lto`, so `gn gen` fails outright (measured on 152.0.7977.42). Left at its default,
  Chromium derives the limit itself from the host — `--reserve_mem_gb=10` with `--mem_per_link_gb=45`
  on Windows and `30` on Linux — which already yields one link at a time on a small box.
  `build.ps1` also takes `-Jobs`, because `autoninja` picks parallelism from core count alone and
  each `cl.exe` holds 1–2 GB: eight of them on a 16 GB machine page to disk and finish slower than six.
- **CPU:** 8 cores is fine but slow. Budget 6–8 h wall clock for a clean official build, plus the ThinLTO
  link.

### 3.1 Windows build host — the prerequisites that are not obvious

`lobium/build.ps1` is the native Windows driver (`build.sh` is bash-only, and its `quilt push -a` step has
no Windows equivalent). It stages, patches, configures and builds, and it is idempotent. Its preflight
exists because every one of these failed silently or late on a fresh host:

| Prerequisite | Symptom when missing |
| --- | --- |
| VS 2022 with the **C++ ATL** component | ~2,000 objects compile, then `base/win/atl_throw.cc` dies with `'atldef.h' file not found` after 13 minutes |
| VS installed **outside** `%ProgramFiles%` | `gn gen` fails with `No supported Visual Studio can be found`; `build/vs_toolchain.py` only probes the default root. Fixed by exporting `vs2022_install`, which the script derives from `vswhere` |
| Windows SDK **Debugging Tools** | Chromium's Windows toolchain requires them |
| `checkout_pgo_profiles` in `.gclient` | `chrome_pgo_phase = 2` has no profile |
| The **V8 builtins** PGO profile (a second, separate artifact) | ninja schedules everything, then fails with `v8/tools/builtins-pgo/profiles/x64-rl.profile … missing and no known rule to make it` |
| NTP brand icons staged into the tree | `branding/ntp-branding.patch` adds four PNGs to a `generate_grd` input list; GN fails if they are absent. `build.ps1` stages them from `lobium/assets/ntp-icons/` |

Windows Defender must exclude the checkout and the compiler processes, or the build roughly halves in
speed.

**GitHub Actions cannot build the engine on a hosted runner.** A hosted `windows-latest` gives roughly
4 vCPU / 16 GB / ~14 GB free disk against a ~150 GB requirement, jobs are killed at 6 hours, and the
Actions cache is capped at 10 GB per repository so `out/` cannot be checkpointed between jobs. The engine
build must run on a **self-hosted** runner. This repository already uses that pattern:
`.github/workflows/agent-battery.yml` runs on `[self-hosted, agent-battery]` with a 240-minute timeout,
`real-gpu-gate.yml` on `[self-hosted, gpu]`, and the series-replay job on `[self-hosted, lobium-build]`.

The **installer** has no such problem: a hosted runner builds a Tauri bundle in minutes. Splitting the two
matches how often each changes — the engine per Chromium bump, the installer per release.

### 3.2 The patch series

The series was refreshed onto `152.0.7977.42` and restructured. It had rotted in a way that made it
unbuildable: `core/config-channel.patch` was 64 KB across 19 files, and **21 of its 55 hunks were
byte-identical copies of hunks in three other patches**, so `patch --forward` reported those three as
"previously applied", exited non-zero, and aborted the whole apply. It is now one patch per concern — the
transport, `navigator`/UA-CH, canvas, and WebGL each own their own hunks — with the restructure proven
behaviour-preserving by a byte-identical tree diff.

`ci/validation/patch-series.test.mjs` locks the invariants offline: no hunk body in two patches, no
malformed header, hunk counts matching their bodies, no overlapping hunks, LF-only UTF-8 without a BOM
(CRLF applied under GNU patch but `git apply` rejected it outright), ASCII-only added source, the ordering
chains that must hold because later patches are cut against earlier ones, and the capability contract
agreeing across the native list, the TypeScript mirror, and the series.

`node lobium/regen-patch.mjs <patch>` folds an edit made in the checkout back into its patch, and
**refuses** to regenerate a patch that shares a file with another — `git diff` would silently absorb the
other patch's hunks. [`../lobium/hooks.md`](../lobium/hooks.md) documents every hook point and, more
importantly, the coverage boundary.

## 4. What a fresh clone does not include

`.gitignore` correctly excludes build output and secrets, so a clone needs provisioning:

| Missing | Restore with |
| --- | --- |
| `node_modules/` | `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 npm install` |
| `apps/desktop/src-tauri/resources/{sidecar,node,fonts,lobee}` | `node scripts/bundle-sidecar.mjs`, `node scripts/build-lobee.mjs`, and the vendoring steps in `build-linux-product.sh` |
| `packages/lobee/` | `node scripts/build-lobee.mjs` (rm -rf's and rewrites it) |
| `.env` | Recreate from `.env.example`. The only key here is `VENICE_API_KEY`, used by `scripts/venice-chat.mjs`. |
| The Lobium engine | Downloaded on first run per `engine-manifest.json`, or pointed at a local build via `LOBSTER_LOBIUM_BIN` |
| `ci/validation/reports/` | Regenerated by the validation harnesses |

`engine-manifest.json` **is** tracked — it is configuration, not build output, and it is the only file
under `resources/` in git.

Profile data (`profiles.sqlite`, `secrets.key`, per-profile dirs) lives in the OS app-data directory
(`~/.local/share/com.lobster.browser/` on Linux), never in the repository. It does not travel with a
clone, and uninstalling the app does not remove it.

## 5. Verification status

Read [`ENGINEERING.md`](ENGINEERING.md) §4 and [`LOBEE_AGENT_ROADMAP.md`](subsystems/agent.md) §4 for
the full picture. The short version, because it is easy to overstate:

- The **software gate** (`regression-gate.mjs`) runs anywhere: coherence, device-class diversity floors,
  and fingerprint unit contracts. It reads no baseline and launches no browser.
- The **offline structural gates** run anywhere and are fast: `npm run gate:engine` (patch-series
  structure, version coherence, source hygiene, canonical-seed, and Windows packaging, font-isolation,
  and product-E2E platform contracts),
  `npm run gate:desktop-css`, and `npm run gate:migrations`. All three run in CI on every push.
  `lobium/test/run.ps1` (`npm run gate:kernels`) is a PowerShell entry point for the Windows build
  host: property tests that compile the SHIPPING canvas and audio kernels from `lobium/src/` and
  assert the detection oracles directly.
- The **series reproducibility gate** (`npm run gate:series`) needs the Chromium checkout but no
  browser. It first requires checkout HEAD to resolve to the pinned Chromium tag, then replays all 31
  patches into a scratch tree built from that tag's pristine git blobs and compares the complete
  active-patch and staged-copy footprint. The pristine replay is green on this Windows host; its live
  build checkout is intentionally stale/drifted and will keep reporting footprint differences until
  the documented force-clean rebuild. CI runs the gate as an opt-in job on the `lobium-build`
  self-hosted runner, behind `vars.LOBSTER_ENABLE_SERIES_REPLAY`.
- The **audit oracle gate** (`npm run gate:oracles`) needs the native binary. It runs the detection
  oracles from `ENGINE_AUDIT.md` *in the browser*, which is the only way to prove a kernel fix actually
  reaches the page. It has three outcomes, and the distinction is the point:
  - `0` PASS — every declared aspect green.
  - `1` FAIL — an oracle for a finding marked *fixed* measured and failed. A fact about the **engine**.
  - `2` BLOCKED — nothing conclusive was measured. A fact about the **environment**.

  It exits BLOCKED when there is no binary, or when the binary's advertised capabilities do not cover
  what the launcher requires. That second case is why the 13 "regressions" once on record described
  nothing: they were scored against a build the product itself refuses. It also takes its persona OS from
  `LOBIUM_ORACLE_OS` (default `windows`) rather than from `process.platform`, because a Linux runner
  taking the persona from the host only ever measured a Linux persona and left every Windows-only surface
  unmeasured while reporting "all oracles pass". `process.platform` survives only as `hostPlatform`
  provenance in the report.
- The **font-isolation gate** (`npm run gate:fonts`) needs the native binary and its own launch, because
  its whole method is a deliberately unrealistic config: three claimed families, then measure which
  families the page can still resolve. Against a realistic persona the measurement is nearly blind — the
  persona claims most of what a Windows host has installed. With three, every extra resolution is a leak,
  and a negative control (a family that exists nowhere) proves the measurement discriminates.
- The **engine gates** (`battle-test.mjs`, `deep-probe-50.mjs`) need the native binary, and
  `battle-test.mjs` reports a deep-GPU tell on a software renderer — so this host cannot produce a
  release-valid verdict from them.
- The **real-GPU detection gate** is the release blocker and requires real hardware; the evidence policy
  in `detector-matrix.json` rejects software renderers. `real-gpu-gate.yml` runs it on a self-hosted
  `gpu` runner on a nightly schedule and on demand; its `pull_request` trigger is deliberately commented
  out until the runner is reliably online.
- The **paid live agent battery** has not been run. Deterministic grader success is not a live
  model/browser pass.

This build host has no real GPU (SwiftShader only), so W1 data capture and the W5 live detection gate
cannot execute here — only their code and schemas can.

### 5.1 Audit findings closed in the patch series

`ENGINE_AUDIT.md` is generated and must not be hand-edited, so progress against it is recorded here.
Each of these is closed by a patch in the series and compiles into a binary built from it. **Read the
blockquote at the top of this file first**: no published artifact contains them, so the "Oracle" column
names the check that *would* confirm it, not a check that has passed on a shipping build.

| Finding | Closed by | Oracle |
| --- | --- | --- |
| `pack-row-length-disables-webgl-farble` (critical) | `fingerprint/webgl-bypass-closures.patch` — the farble gate keys on effective geometry, and user framebuffers are covered | `webgl-pack-row-length-still-farbles` |
| `timezone-tz-env-noop-on-windows` (critical) | `fingerprint/native-timezone.patch` | `timezone-is-the-persona-zone`, `timezone-agrees-in-worker` |
| `fonts-fontconfig-inert-on-windows` (critical) | `fingerprint/windows-font-isolation.patch` | `fonts-limited-to-the-persona-set`, plus the dedicated `gate:fonts` |
| `webgpu-adapter-unhooked` (critical) | `fingerprint/webgpu-adapter.patch` | `webgpu-adapter-matches-webgl-renderer` |
| `webgl2-extension-list-served-from-webgl1-persona` | `fingerprint/webgl-bypass-closures.patch` — `getExtension()` now filters WebGL2 contexts against the WebGL2 list, matching `getSupportedExtensions()` | `webgl2-extensions-are-the-webgl2-list` |
| `getextension-case-sensitive-allowlist` | the same patch — the comparison is case-insensitive, matching `ExtensionTracker::MatchesName` | — |
| `webgl2-getparameter-never-hooked` (partly) | `fingerprint/webgl2-surfaces.patch` — the component limits; the feature-level constants are deliberately left honest, see `hooks.md` §5 | `webgl2-components-are-4x-webgl1-vectors` |
| `contract-is-a-hardcoded-literal`, `phantom-capabilities-timezone-acceptlang` | the list moved to `components/lobium_fp/lobium_capabilities.cc` beside the hooks, `font-isolation` is `BUILDFLAG(IS_WIN)`-gated, and CI cross-checks the three copies | — |

Findings **found outside the audit** and closed in the same series, recorded here because nothing else
tracks them:

- `mediaDevices.enumerateDevices()` exposed stable hashed `deviceId`s and the true device count with no
  capture permission and always-empty labels — a combination real Chrome never emits, since a `deviceId`
  without permission is impossible and a blank label after a grant is too. It now shapes the reply the way
  the browser process does: one blank entry per kind until the frame holds the permission, then hashed ids
  with OS-shaped labels and `groupId`s. `lobium_media_devices.{h,cc}` reproduces Chrome's origin-keyed
  HMAC-SHA256 construction. Oracle: `mediadevices-ids-have-chrome-shape`.
- Derivation drew renderer strings from the raw `pci.ids` arrays rather than the filtered product catalog,
  so roughly seven in ten Windows personas shipped a string like `GeForce 6800 Ultra]` — an unbalanced
  bracket on a 2004 card claiming D3D11. The macOS catalog offered GPUs Apple never shipped (Iris Xe,
  Radeon W7900) alongside SKU rows like `Apple M1 7-Core GPU`, which Metal never reports. Both now draw
  from what the vendor actually shipped.

Two fixes that a source-only review would have gotten wrong, recorded so they are not retried:

- **Timezone.** The audit's suggestion was to hook `RenderThreadImpl::Init`. That does not survive: the
  browser's `device::TimeZoneMonitor` pushes the host zone to every renderer shortly after startup and
  overwrites anything adopted earlier. The hook is at `TimeZoneController::OnTimeZoneChange`, the
  receiving end of that push.
- **Fonts.** The first implementation hooked `DWriteFontProxyImpl`, which every older Chromium source and
  every guide describes as the Windows font path. It had **no effect at all** — measured in the running
  browser, every installed family still resolved while the config listed three. M152 sets
  `kFontDataServiceAllWebContents` to `FEATURE_ENABLED_BY_DEFAULT`, so `InitializeFontIntegration` routes
  the renderer to `font_data_service::FontDataManager` and the DWrite proxy is off the CSS matching path
  entirely. Both are now hooked, since either can be live depending on flags. This is the clearest
  argument for the in-browser gates: the patch read as complete and compiled clean.

Three capability gaps the CI cross-check surfaced, none previously tracked in the audit: `screen-metrics`,
`mobile-persona` and `navigator-ua-ch` were shipped, compiled surfaces with no capability name, so the
sidecar could not require them and therefore could not guarantee them. `navigator-ua-ch` was the worst of
the three — a build carrying the config channel but not that patch passed the launcher's gate and then
silently reported the **host's** UA, platform, cores and memory, which looks exactly like success. All
three now have a capability name.

### 5.2 Why the published Linux artifact is refused

`packages/engine-runner/src/lobium-capabilities.ts` asks the exact executable that will be spawned which
hooks it contains (`--lobium-fingerprint-capabilities`) and refuses to launch if the required set is not
covered. Filename and version claims are deliberately not trusted.

The `152.0.7928.0` binary advertises 12 capabilities. The launcher's unconditional requirement includes
five it does not have: **`navigator-ua-ch`, `webgl2-deep`, `screen-metrics`, `webgpu-adapter`,
`native-timezone`**. Launch fails with `Lobium build lacks required native fingerprint hooks: …`.

This is the gate doing its job. Each of those five was made *required* rather than optional because its
absence is a silent, page-visible leak that looks like a working profile: an unhooked `navigator-ua-ch`
reports the host identity on the surfaces detectors read first; a WebGL2 context reporting the host while
WebGL1 reports the persona is worse than neither being spoofed; an unhooked WebGPU adapter names the real
card next to a spoofed WebGL renderer; and on Windows the process-locale timezone route is a no-op, so
without `native-timezone` the persona timezone does not apply at all.
