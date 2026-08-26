# Windows agent brief — 2026-08-26

**You are the agent on the Windows build host.** You have no memory of the conversation that
produced this. Everything you need is here or reachable from the repo. Read this whole file before
touching anything.

Your counterpart is an agent on the Linux box (which is also the production server,
`158.220.91.217` / `lobrowser.com`). It is working in parallel on the anti-detect engine. **Do not
rebuild the engine until Phase 3**, and read the reason in "Why the order matters" before deciding
you know better — a premature rebuild wastes hours and produces an artifact that has to be thrown
away.

---

## Phase 0 — Understand the product before you change it

Do not skip this and do not skim it. The last three defects in this product were all
"the code was right and the mental model was wrong", and each cost a release.

Read, in this order, and write notes as you go:

1. `README.md`, `docs/STATUS.md`, `docs/ENGINEERING.md`, `docs/OPERATIONS.md`.
2. `docs/subsystems/` — every file. `engine-audit.md` especially: it is a standing register of known
   fingerprint defects, and several are still open.
3. The engine fork: `lobium/patches/series` (read the comments, they are the architecture),
   `lobium/src/` (the added `//components/lobium_fp/` module), `lobium/hooks.md`.
4. The launcher: `packages/engine-runner/src/runners/lobium-launcher.ts` end to end, plus
   `lobium-config.ts`, `lobium-capabilities.ts`, `gpu.ts`.
5. The desktop shell: `apps/desktop/src-tauri/src/lib.rs` (`ensure_lobium_env`, `engine_status`,
   `provision_engine`), `apps/desktop/src/features/engine/EngineGate.tsx`.
6. `packages/fingerprint/` — how a persona is derived and what `coherence.ts` already enforces.

Then write `docs/qa/2026-08-26-windows-understanding.md` answering, in your own words and with
`file:line` citations:

- How does a profile's fingerprint become a running browser? Trace it from the UI to the process
  arguments to the native config to the Blink hook.
- What is the capability contract, what happens if the engine and the sidecar disagree about it, and
  why is that failure mode designed the way it is?
- Which fingerprint surfaces are hooked natively, and which are still host values?
- Where does the engine come from at runtime, in what order are the candidates tried, and what
  changed about that on 2026-08-26?
- Name three things in this codebase you believe are wrong or risky, with evidence.

Stop and report after Phase 0. Do not proceed until you have written that file.

---

## Phase 1 — Diagnose the 3D-rendering defect (do this early; it unblocks Linux)

**The report.** 3D models do not render on `github.com` — specifically the small WebGL mascots that
sit beside each section heading (`.lp-SectionIntroWebGL-canvas`, four of them, one per section, the
first beside "Accelerate your entire workflow"). Other browsers on the same machine render them.

**What is already known, so you do not repeat it.** The Linux box **cannot reproduce this**, and the
reason is that it has no GPU at all — no `/dev/dri`, llvmpipe only. Measured there against stock
Chrome 152.0.7977.64 (our engine is 152.0.7977.42, same milestone): our engine renders all four
mascots **pixel-identically** to stock Chrome, with and without a real profile persona — 1959 draw
calls, zero shader/link failures, zero GL errors, no cap over-claimed, no extension
advertised-but-null. So the engine binary and the fingerprint layer are both exonerated on a
software-GL host, and the defect lives on the real-GPU path. Yours is the only machine that has one.

**What to run:**

```powershell
node scripts\diagnose-3d-render.mjs --out lobium-3d-nopersona.json --shots shots-nopersona
node scripts\diagnose-3d-render.mjs --config <a real profile's lobium-fp.json> `
     --out lobium-3d-persona.json --shots shots-persona
```

A profile's config is at `%APPDATA%\com.lobster.browser\profiles\<id>\lobium-fp.json`. Run it for a
**Windows persona and an Android persona**, and for a persona whose claimed GPU differs sharply from
the host's real one (e.g. an Intel Arc persona on an NVIDIA host) — that is the case most likely to
expose a cap the backend cannot honour.

Then run the identical page in **stock Chrome on the same machine** and capture the same four mascot
regions, so there is a same-host reference rather than a memory of one.

Report the JSON files, the PNGs, and the one-line `verdict` field from each. The script's verdict
already distinguishes the five candidate causes: GPU not used for WebGL at all, context never
created, persona over-claiming a cap the backend cannot execute, an extension named but not
obtainable, and draws landing on nothing.

**Do not guess at a fix.** Send the evidence.

---

## Phase 2 — Real-GPU fingerprint baselines (this is the parallel #8 work)

This is the half of the anti-detect work only you can do, and it must happen **before** the engine
changes, because it is the "before" measurement.

**Why it matters.** Every detector report in this repo — seven of them, 2026-07-09 through
2026-08-23 — was captured on SwiftShader, which the project's own `gate.mjs` is written to reject.
So the product has never once been measured under the conditions it actually ships into. A
`Google SwiftShader` renderer is a headless tell; every conclusion drawn from those runs is
suspect.

Create **20 profiles** spanning the persona space — Windows/macOS/macOS-ARM/Android, different GPU
vendors, different screen geometries, different locales and timezones, at least two behind a proxy —
and for each capture, on the real GPU:

- `chrome://gpu` feature status (via CDP `SystemInfo.getInfo`, as the diagnostic script does).
- CreepJS full report.
- `navigator.gpu.requestAdapter()` result and adapter info.
- `requestMediaKeySystemAccess('com.widevine.alpha', ...)` — expected to FAIL today; see below.
- The WebGL cap set, and for each advertised cap whether the backend can actually execute it.
- `matchMedia('(color: 8)')`, `(dynamic-range: high)`, `(color-gamut: p3)` against `screen.colorDepth`.
- `canPlayType` for Dolby Vision (`dvh1.05.07`) — a Windows build reports it and a macOS persona
  must not.

Save each as `ci/validation/reports/win-gpu-baseline-<persona>-<timestamp>.json`.

**Four contradictions are already known to fire and you should expect to see them.** Confirm or
refute each with your own measurement rather than assuming:

1. `macos_arm` personas report `screen.colorDepth = 30` while the CSS `(color:)` media feature is
   unhooked and answers the host's 8 — `packages/fingerprint/src/derive.ts:234`.
2. Widevine is compiled out (`enable_widevine` defaults false and neither gn-args file sets it), so
   every persona claiming the "Google Chrome" brand rejects `com.widevine.alpha`. Real Chrome always
   resolves it.
3. Dolby Vision support is baked to the BUILD OS, not the persona.
4. On a GPU-less host every profile advertises a discrete GPU in WebGL while `navigator.gpu` returns
   null and the caps are silently clamped. **Your host has a GPU, so this one may not reproduce —
   which is exactly the point of measuring here.**

---

## Phase 3 — Rebuild the engine (WAIT for the Linux agent's go-ahead)

### Why the order matters

The Linux agent is landing fingerprint patches for the contradictions above. Every one of them is a
change to `lobium/patches/`, which means a rebuild. If you rebuild now you will build an engine that
is already superseded, and then build it again. Phases 0–2 need no rebuild at all, which is why they
come first. **Wait until you are told the patches have landed.**

### What this rebuild must fix

**The device frame (release blocker).** A profile whose fingerprint OS is Android should open with
its viewport centred in a phone-shaped stage. On Windows it opens flush-left with no frame. This is
not a launcher bug — it is a stale binary:

| | |
|---|---|
| `45a4480` published the win-x64 engine | 2026-08-25 **20:11** |
| `30ed714` made the device frame link, restoring `branding/device-frame.patch` to the series | 2026-08-25 **23:14** |

The published Windows engine was built three hours before the fix. The Linux engine (built 23:47)
has it, and the frame was verified working there. Details and the failure history are in
`docs/qa/2026-08-26-windows-engine-rebuild.md` — read it.

**Strip the binaries.** `symbol_level = 0` removes DWARF but NOT the symbol table the static link
produces. On Linux that was 236.7 MB, 45% of `chrome`. For an anti-detect product the symbols matter
more than the megabytes: `nm -C` listed ~100 symbols naming the fork's internals
(`lobium::LobiumFpConfig::Current`, `LobiumConfiguredHardwareConcurrency`,
`LobiumDeviceFrameView::OnMousePressed`) — a map of exactly which surfaces are spoofed, handed to
anyone with the binary. Do the Windows equivalent and check what the PDB/packaging path leaks.

**Do not ship the Vulkan validation layer or the mock ICD.** A blanket glob was pulling in
`libVkLayer_khronos_validation.so` (27.9 MB, a debugging tool) and `libVkICD_mock_icd.so` (a test
mock). Real Chrome ships neither, so their presence beside the executable is itself an unusual,
fingerprintable artifact. Check the `.dll` equivalents.

### Procedure

1. `git pull`. Confirm `branding/device-frame.patch` is the last line of `lobium/patches/series`.
2. `quilt pop -a` then `quilt push -a`. **Never hand-apply.** The Linux host's `.pc/` state is
   currently out of sync with its series because someone did exactly that, and the provenance of
   that build had to be established by disassembly rather than by reading `applied-patches`.
3. Build with `lobium\build.ps1` and the official/PGO/ThinLTO settings in `lobium\gn-args-windows.gn`.
4. **Prove the frame is in the binary before packaging.** This check's absence is what caused the
   bug: search `chrome.exe` for `LobiumDeviceFrameView`. Zero occurrences means the patch did not
   apply — stop, do not package.
5. `scripts\package-lobium-runtime.ps1` with explicit `-SourceDir`, `-FontPack <verified-pack>`,
   `-FontScanner <fc-scan.exe>`, versioned `-OutDir`.
6. `node scripts\verify-lobium-runtime.mjs --font-scanner <fc-scan.exe>`.

### Publishing — note this changed today

Artifacts are **no longer published to GitHub**. They are served from `lobrowser.com`, from
`/var/www/lobster-downloads/download/` on the production box. Engine archives live under
`download/engine/`.

Upload the verified archive to
`/var/www/lobster-downloads/download/engine/lobium-win-x64-152.0.7977.42.zip` on `158.220.91.217`
(the user has the credentials; ask rather than guessing), then download it back from its public URL
`https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip` and require the **same
SHA-256** before touching the manifest. Then:

```
node scripts\bump-engine-version.mjs 152.0.7977.42 --platform win-x64 `
     --archive <zip> --url https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip
```

Delete the `stale` key from the win-x64 entry in
`apps/desktop/src-tauri/resources/engine-manifest.json` only once all of that is true.

---

## Phase 4 — The Windows installer, which no longer carries the engine

The distribution model changed today. The installer used to embed the engine (~230 MB on Windows,
490 MB on Linux). It no longer does: the Linux `.deb` went **489.7 MB → 53.4 MB** and the engine is
downloaded on first run. `scripts\build-windows-product.ps1` has already been updated for this and
its header describes the new model — read it.

Expect roughly a **35 MB** installer. If yours is much larger, something is still being bundled;
find out what before shipping it.

**The first-run screen is deliberately wordless** — logo, progress bar, percentage, nothing else. Do
not add explanatory copy, and do not add a "Download engine" button; the download starts on its own.
The only control is a Retry that appears on failure. If you think it needs a sentence, you have
misread the intent — raise it instead of adding one.

**Verify the whole first run on a clean machine (or a fresh user profile):** install, launch, watch
the engine download from `lobrowser.com`, and confirm a profile then launches. That path has never
been exercised against our own host — it used to point at GitHub.

**Verify the uninstall.** It must remove `%LOCALAPPDATA%\lobster\lobium` (the engine cache, ~800 MB,
which neither NSIS nor dpkg tracks) unconditionally, and must ask before removing
`%APPDATA%\com.lobster.browser` (profiles, cookies, saved logins), defaulting to No and never asking
during a silent uninstall. The hooks are in `apps\desktop\src-tauri\installer\hooks.nsh`; they are
written but have **not been run**, so test both answers.

---

## Reporting

After each phase, report: what you did, what you measured, what surprised you, and what you are
uncertain about. Uncertainty stated is useful; uncertainty hidden is how the device-frame regression
shipped. If a claim in this brief turns out to be wrong, say so plainly with your evidence — it was
written from the Linux side and some of it is inference about your machine.
