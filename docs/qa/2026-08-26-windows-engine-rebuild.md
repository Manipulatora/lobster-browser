# Windows engine rebuild — the mobile device frame is missing from the shipped binary

**For the agent on the Windows build host.** You have no memory of the conversation that produced
this; everything you need is below.

## What is wrong

A profile whose fingerprint OS is Android should open with its viewport centred in a phone-shaped
stage. On Windows it opens flush-left with no frame at all. The user reports it worked "a few days
ago" and then stopped.

It is not a regression in the launcher, and not a visual bug. It is a **stale binary**:

| | |
|---|---|
| `45a4480` published the win-x64 engine | 2026-08-25 **20:11** |
| `30ed714` made the device frame link and put `branding/device-frame.patch` back in the series | 2026-08-25 **23:14** |

The published Windows engine was built three hours **before** the fix, so it contains no device-frame
code. The patch had been out of `lobium/patches/series` from 2026-08-21 to 2026-08-25 because it
failed to link — its hooks referenced `LobiumDeviceFrameView`, whose implementation was in no GN
target. Two commits fixed that: `core/build-gn.patch` now GN-wires
`chrome/browser/ui/views/frame/lobium_device_frame_view.{cc,h}`, and
`core/device-emulation-scale.patch` carries `content/{public/browser,browser/devtools}/lobium_device_emulation.*`
plus the `EmulationHandler::SetDeviceEmulationScale` those hooks call — a method that until then
existed in no file at all.

The Linux engine built at 23:47 on 2026-08-25 **does** contain it (41 `LobiumDeviceFrameView`
occurrences in the binary), and the frame was verified working there: launched headful with
`--lobium-device-frame=phone --lobium-device-screen=412x915`, the viewport renders centred in a
phone stage. So the patches are known-good; only the Windows binary is behind.

## What to do

Rebuild and republish the win-x64 engine from the **current** `main`, then bump the manifest.

1. `git pull` and confirm you are at or after `30ed714`. Confirm
   `branding/device-frame.patch` is the last line of `lobium/patches/series`.
2. Force-clean the 152.0.7977.42 checkout and apply the series from scratch:
   `quilt pop -a` then `quilt push -a`. **Do not hand-apply patches.** The Linux host's `.pc/`
   state is currently out of sync with its series because someone did exactly that, which is why the
   provenance of that build had to be established by disassembly rather than by reading
   `applied-patches`.
3. Build with `lobium/build.ps1` using the official/PGO/ThinLTO settings in
   `lobium/gn-args-windows.gn`.
4. **Verify the frame is actually in the binary before packaging** — this is the check whose absence
   caused the bug:
   `Select-String -Path chrome.exe -Pattern 'LobiumDeviceFrameView' -Encoding Byte` (or run
   `strings` equivalently). Zero occurrences means the patch did not apply; stop and fix that rather
   than shipping.
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

- `chrome.exe --version` reports `152.0.7977.42`.
- The binary contains `LobiumDeviceFrameView`.
- `chrome.exe --lobium-fingerprint-capabilities` prints contract version 3 with 19 names.
- Launched with `--lobium-device-frame=phone --lobium-device-screen=412x915`, the viewport is
  centred in a phone stage rather than flush left.
- The published archive's SHA-256 matches after re-downloading it from its public URL.
