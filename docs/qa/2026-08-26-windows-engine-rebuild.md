# Windows engine rebuild — the mobile device frame is missing from the shipped binary

**For the agent on the Windows build host.** You have no memory of the conversation that produced
this; everything you need is below.

## What is wrong

A profile whose fingerprint OS is Android should open with its viewport centred in a phone-shaped
stage. On Windows it opens flush-left with no frame at all. The user reports it worked "a few days
ago" and then stopped.

It is not a regression in the launcher, and not a visual bug. **It had two independent causes, and
the original diagnosis in this document had both of them wrong.** Corrected on the Windows host,
2026-08-26, from the binary and the checkout rather than from commit order. Corrections are marked
**[measured]**.

### Cause 1 — the feature was never compiled on Windows at all

**[measured]** `branding/device-frame.patch` was **Linux-only in source**: 11
`#if BUILDFLAG(IS_LINUX)` guards and zero `BUILDFLAG(IS_WIN)`, sitting on every integration point —
the include, the member declaration, construction in `BrowserView::BrowserView`, the destructor,
`OnActiveTabChanged`, `AddedToWidget`, `AcceleratorPressed`, the `BrowserViewLayoutViews` field, and
`browser_view_tabbed_layout_impl.cc`.

`lobium_device_frame_view.{cc,h}` *are* added unconditionally to the chrome `ui` target
(`core/build-gn.patch:51-52`), so the class compiled on Windows perfectly well — and then nothing
referenced it, so the linker dropped the whole object out of the static library and its two switch
strings went with it. That is why the switches are absent from a `chrome.dll` built from a fully
patched tree, which is exactly what the checkout at `out/Lobium` was.

**So rebuilding alone would not have fixed anything.** The port has since been made: all 11 guards
are now `#if BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_WIN)`. The view is 406 lines of
`views`/`gfx`/`content` code with no platform-specific includes at all — no X11, Wayland, Ozone, GTK,
Aura or Win32 — so the guards were the whole job. The full 33-patch series re-applies with no fuzz
and `gn gen` produces 32,075 targets.

### Cause 2 — the archive was built from an older tree than the commit that published it

The original table read:

| | |
|---|---|
| `45a4480` published the win-x64 engine | 2026-08-25 **20:11** |
| `30ed714` made the device frame link and put `branding/device-frame.patch` back in the series | 2026-08-25 **23:14** |

**[measured] Those timestamps are in different timezones, which reverses their order.** `45a4480` is
`20:11:38 -0700`; `30ed714` is `23:14:00 +0200`. In UTC:

```
30ed714  2026-08-25 21:14:00 UTC   device frame links
45a4480  2026-08-26 03:11:38 UTC   win-x64 engine published   (5h58m LATER)

git merge-base --is-ancestor 30ed714 45a4480   →   true
```

The publishing commit's tree already contained the fix. So the mechanism was **not** "built three
hours before the fix" — it is that the **archive was built from an older tree than the commit that
published it**. That is a provenance failure, and it needs a different remedy: stamp the archive with
the source revision it was built from and check that stamp at publish time, rather than reasoning
about commit order at all.

### Background that remains accurate

The patch had been out of `lobium/patches/series` from 2026-08-21 to 2026-08-25 because it failed to
link — its hooks referenced `LobiumDeviceFrameView`, whose implementation was in no GN target. Two
commits fixed that: `core/build-gn.patch` GN-wires
`chrome/browser/ui/views/frame/lobium_device_frame_view.{cc,h}`, and
`core/device-emulation-scale.patch` carries `content/{public/browser,browser/devtools}/lobium_device_emulation.*`
plus the `EmulationHandler::SetDeviceEmulationScale` those hooks call — a method that until then
existed in no file at all.

The Linux engine built at 23:47 on 2026-08-25 **does** contain it (41 `LobiumDeviceFrameView`
occurrences in the binary), and the frame was verified working there: launched headful with
`--lobium-device-frame=phone --lobium-device-screen=412x915`, the viewport renders centred in a phone
stage. The Linux binary retains a symbol table, which is why a class NAME is greppable there and is
not on Windows — see the corrected verification step below.

## What to do

Rebuild and republish the win-x64 engine from the **current** `main`, then bump the manifest.

1. `git pull` and confirm you are at or after `30ed714`. Confirm
   `branding/device-frame.patch` is the last line of `lobium/patches/series`.
2. Force-clean the checkout and apply the series from scratch. **[measured] There is no `quilt` on
   the Windows host and no `.pc/` directory in the checkout** — `lobium/build.ps1` applies the series
   with GNU patch (from Git for Windows), and its `-Force` flag is the Windows equivalent of
   `quilt pop -a; quilt push -a`: it resets tracked files and re-applies the whole series from the
   pinned checkout. So:

   ```powershell
   $env:LOBIUM_CHROMIUM_SRC = 'C:\lobium-build\src'
   powershell -ExecutionPolicy Bypass -File lobium\build.ps1 -Run -Force
   ```

   **Do not hand-apply patches.** The Linux host's `.pc/` state is out of sync with its series
   because someone did exactly that, which is why the provenance of that build had to be established
   by disassembly rather than by reading `applied-patches`.
3. That same command builds with the official/PGO/ThinLTO settings in `lobium/gn-args-windows.gn`.
   To resume an interrupted build without re-patching, run its step 4 directly:
   `autoninja -C out\Lobium chrome` from the checkout.
4. **Verify the frame is actually in the binary before packaging** — this is the check whose absence
   let the bug ship.

   **[measured] The check this document used to give returns zero on a CORRECT Windows build, and
   would block every rebuild.** It said to search `chrome.exe` for `LobiumDeviceFrameView`. Two
   independent reasons that cannot work here:

   * **Wrong file.** On Windows, `chrome.exe` is a 4.3 MB launcher stub containing no Lobium strings
     whatsoever — not even `lobium-fp-config`, which is present in every build. The code is in
     `chrome.dll` (297 MB).
   * **Wrong token.** `LobiumDeviceFrameView` is a C++ class name that does not survive an optimised
     release build. `LobiumFpConfig` and `LobiumConfiguredHardwareConcurrency` also return 0
     occurrences in a Windows binary that demonstrably has those hooks. The name is greppable in the
     Linux binary only because that build still carries a symbol table — the same one the strip step
     below removes.

   Use the **switch strings** instead. They are string literals, so they survive optimisation:

   ```powershell
   # NOT Select-String -Encoding Byte: that value does not exist for Select-String on Windows
   # PowerShell 5.1 (it is a Get-Content parameter) and the command fails with a ValidateSet error
   # rather than searching. Read the bytes and scan them.
   $dll   = Join-Path $out 'chrome.dll'
   $bytes = [System.IO.File]::ReadAllBytes($dll)
   $text  = [System.Text.Encoding]::ASCII.GetString($bytes)
   foreach ($s in 'lobium-device-frame','lobium-device-screen') {
     if ($text.IndexOf($s, [System.StringComparison]::Ordinal) -lt 0) {
       throw "chrome.dll does not contain '$s' - the device frame is not in this build"
     }
   }
   ```

   (`chrome.dll` is ~300 MB, so this holds it in memory briefly. On a constrained host, `strings`
   or `grep -a -o` over the file does the same job.)

   What makes this trustworthy: on the currently published build, **11 of the 13 `lobium-*` switch
   strings are present in `chrome.dll` and exactly `lobium-device-frame` and `lobium-device-screen`
   are missing** — so the test discriminates, rather than passing or failing everything at once.

   Note this check now also depends on Cause 1 being fixed. Before the Windows port, the switch
   constants lived in a translation unit the linker discarded, so they were absent even from a tree
   with the patch fully applied.
5. Package with `scripts/package-lobium-runtime.ps1`, passing the explicit `-SourceDir`,
   `-FontPack <verified-pack>`, `-FontScanner <fc-scan.exe>` and a versioned `-OutDir`.
6. Verify with `scripts/verify-lobium-runtime.mjs --font-scanner <fc-scan.exe>`.
7. Upload, download the published URL back, require the same SHA-256, then
   `node scripts/bump-engine-version.mjs 152.0.7977.42 --platform win-x64 --archive <zip> --url <published-url>`.

## Two things that changed on the Linux side and apply to you

**Strip the binaries.** `scripts/package-lobium-runtime.sh` now separates debug info out-of-band and
runs `strip --strip-all`. `symbol_level = 0` removes DWARF but NOT the symbol table the static link
produces: on Linux that was 236.7 MB, 45% of `chrome`. For an anti-detect product the symbols matter
more than the megabytes — `nm -C` listed ~100 symbols naming the fork's internals
(`lobium::LobiumFpConfig::Current`, `LobiumConfiguredHardwareConcurrency`,
`LobiumDeviceFrameView::OnMousePressed`), which is a map of exactly which surfaces are spoofed.
Check whether the Windows PDB/packaging path leaks the equivalent, and match the behaviour.

**Do not ship the Vulkan validation layer or the mock ICD.** A blanket `*.so` glob was pulling in
`libVkLayer_khronos_validation.so` (27.9 MB, a debugging tool) and `libVkICD_mock_icd.so` (a test
mock). Real Chrome ships neither, so their presence beside the executable is itself an unusual,
fingerprintable artifact. Check the `.dll` equivalents.

## Acceptance

- The **PE ProductVersion** of `chrome.exe` reports `152.0.7977.42`.
  **[measured] Do not run `chrome.exe --version` on Windows** — unlike POSIX it is not an early-exit
  path, so it starts a browser. `scripts/package-lobium-runtime.ps1` reads the PE VERSIONINFO instead
  (`Read-PeProductVersion`), and `ci/validation/windows-packager-contract.test.mjs` asserts the
  packager never probes `--version`.
- **`chrome.dll`** contains the strings `lobium-device-frame` and `lobium-device-screen`.
  **[measured] Not** `chrome.exe`, and **not** the class name `LobiumDeviceFrameView` — see step 4
  for why both of those return zero on a correct Windows build.
- `chrome.exe --lobium-fingerprint-capabilities` prints contract version 3 with **21** names.

  **[measured] The old criterion said 19, which is the LINUX count and would reject a correct
  Windows build.** The portable set is 19; Windows adds `font-isolation`
  (`BUILDFLAG(IS_WIN)`-gated), which made it 20 — verified by probing the shipped runtime. This
  rebuild adds `device-frame`, guarded to Linux and Windows, so the counts are now **21 on Windows
  and 20 on Linux**. `docs/STATUS.md` and `lobium/src/lobium_capabilities.cc` are the source of
  truth; `ci/validation/patch-series.test.mjs` fails the build if the C++ list and its TypeScript
  mirror ever diverge.
- Launched with `--lobium-device-frame=phone --lobium-device-screen=412x915`, the viewport is
  centred in a phone stage rather than flush left. This is the criterion that actually proves the
  Windows port, and it could not even be attempted before it.
- The published archive's SHA-256 matches after re-downloading it from its public URL.
  **[measured] As of 2026-08-26 that URL returns HTTP 404** — the archive has never been uploaded —
  while the Linux one returns HTTP 200 and 270,688,368 bytes. Uploading is a prerequisite for this
  criterion, not a consequence of it.
