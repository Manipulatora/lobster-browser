# Phase 3 — engine rebuild, and the release blocker that a rebuild alone would not have fixed

2026-08-26, Windows build host.

**The Android device frame now works on Windows, proved with a control.** It was not a stale binary:
the feature had never been compiled on Windows at all, so the rebuild the brief asked for would have
produced a binary with exactly the same defect. The guards were widened first, then the engine was
rebuilt, packaged and verified end to end.

**Not done: publishing.** The archive is built, verified and hashed, but uploading it needs
credentials for `158.220.91.217` that this host does not have, and the manifest must not move before
the bytes are reachable. See §6.

---

## 1. The actual cause

`branding/device-frame.patch` carried **11 `#if BUILDFLAG(IS_LINUX)` guards and zero
`BUILDFLAG(IS_WIN)`**, on every integration point: the include, the member declaration, construction
in `BrowserView::BrowserView`, the destructor, `OnActiveTabChanged`, `AddedToWidget`,
`AcceleratorPressed`, the `BrowserViewLayoutViews` field, and `browser_view_tabbed_layout_impl.cc`.

`lobium_device_frame_view.{cc,h}` are added *unconditionally* to the chrome `ui` target
(`core/build-gn.patch:51-52`), so on Windows the class compiled and then nothing referenced it — the
linker dropped the object out of the static library and its two switch strings went with it.

That is why the shipped `chrome.dll` was missing `lobium-device-frame` and `lobium-device-screen`
while the checkout at `C:\lobium-build\src` was fully patched, `components/lobium_fp/` was staged and
`chrome/browser/ui/views/frame/lobium_device_frame_view.cc` was present on disk.

The fix was the guards, not the implementation: the view is **406 lines** of `views`/`gfx`/`content`
code with no platform-specific includes at all — no X11, Wayland, Ozone, GTK, Aura or Win32. All 11
guards are now `#if BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_WIN)`. The edit changes line *content* only,
so every hunk header stayed valid.

---

## 2. Build

Series re-applied from a reset tree with `lobium\build.ps1 -Run -Force` — the Windows equivalent of
`quilt pop -a; quilt push -a`, since there is no quilt on this host and no `.pc/` directory (the
brief's procedure has been corrected).

```
33 patches, all OK, no fuzz          (branding/device-frame.patch last, as required)
gn gen: 32,075 targets from 4,947 files
build:  finished successfully, official / PGO (459 MB profile) / ThinLTO
chrome.dll  297,380,864 bytes   (old published build: 297,368,576 — +12,288)
```

---

## 3. Verification

### 3.1 The binary contains the frame

```
lobium switch strings in chrome.dll:  13 of 13     (was 11 of 13)
  newly present: lobium-device-frame, lobium-device-screen
```

The brief's check — grep `chrome.exe` for `LobiumDeviceFrameView` — returns zero on a **correct**
Windows build and would have blocked this one. `chrome.exe` is a 4.3 MB launcher stub with no Lobium
strings at all, and the class name does not survive an optimised release build (`LobiumFpConfig` and
`LobiumConfiguredHardwareConcurrency` are also absent from a binary that demonstrably has them). The
switch strings are literals and survive. Both the brief and
`docs/qa/2026-08-26-windows-engine-rebuild.md` have been corrected.

### 3.2 The capability contract

```
contract version 3, 21 capabilities, device-frame PRESENT, font-isolation PRESENT
```

21, not the 19 the rebuild doc's acceptance criterion asked for — 19 is the Linux count. 19 portable
+ `font-isolation` (`IS_WIN`) = 20 before this change; adding `device-frame` (Linux and Windows)
makes it 21 on Windows and 20 on Linux.

`device-frame` is **new to the contract**, added because its absence was invisible to every gate:
the launcher emits `--lobium-device-frame` unconditionally for a mobile profile, Chromium silently
ignores switches it does not know, and the contract did not cover the feature — so a binary without
it launched, reported success, and simply had no frame. It is now required for an emulated Android
launch and required by the packager, so a runtime without the frame cannot be packaged at all.

### 3.3 The frame actually renders — with a control

Same window size, same page, frame flags on and off, against both binaries:

```
                                  viewport            verdict
NEW build,  no frame flags        1028 x 637          tracks the window
NEW build,  --lobium-device-frame=phone
            --lobium-device-screen=412x915   411 x 914   FRAME ACTIVE
OLD published build, no flags     1028 x 637          tracks the window
OLD published build, WITH flags   1028 x 637          NO FRAME — switch ignored
```

The old binary is the control that makes this meaningful: it responds *identically* with and without
the flags, which is what "the switch does not exist in this build" looks like from outside. The new
binary's viewport becomes the 412×915 device (411×914 after the aperture inset) while the window
stays the size it was asked for — that is the frame doing its job.

A screenshot of the framed run is `qa-out/frame-phone.png`; it is the viewport, so it shows the
phone-shaped aspect rather than the stage around it.

---

## 4. Packaging

```powershell
scripts\package-lobium-runtime.ps1 `
  -SourceDir   C:\lobium-build\src\out\Lobium `
  -FontPack    <verified pack, 77 faces> `
  -FontScanner C:\project\tools\msys64\mingw64\bin\fc-scan.exe `
  -OutDir      dist-win\lobium-runtime-152.0.7977.42-devframe
```

```
font pack        lobster-open-fonts-f933eea3271f8735, 77 faces, rescanned before and after the copy
capabilities     21 hooks, version 152.0.7977.42
artifacts        554 files   (was 556 — see below)
tree digest      0362a3f9384ec4df427351f031fd237e596000e73726960528898878dace0400
size             0.6 GB
```

**Two fingerprintable debugging artifacts were removed**, which is the Windows answer to the brief's
question about the Vulkan validation layer. The `.so` files the Linux side found are not present
here, but their **loader manifests were shipping**:

```
removed Vulkan debug artifact: VkICD_mock_icd.json
removed Vulkan debug artifact: VkLayer_khronos_validation.json
```

Real Chrome ships neither. A Vulkan layer manifest naming a validation layer, sitting beside the
executable, is an unusual environment for a browser to be in — the same class of ambient tell, in two
small JSON files rather than 28 MB of code. `vk_swiftshader.dll` and `vk_swiftshader_icd.json` are
deliberately kept: SwiftShader is the software backend the product actually falls back to, and stock
Chrome ships it too. No PDBs are shipped.

**Symbols.** The brief asks for the Windows equivalent of the Linux `strip --strip-all`. There is
nothing to strip: `symbol_level = 0` on MSVC/lld-link does not produce the separate symbol table that
the Linux static link does, and the measurement shows it — `LobiumFpConfig`,
`LobiumConfiguredHardwareConcurrency` and `LobiumDeviceFrameView` all return **zero** occurrences in
`chrome.dll`, where `nm -C` on the Linux binary listed ~100 such names. The Windows build already
leaks no fork-internal symbol names, and no PDB accompanies the runtime.

---

## 5. The archive

```
lobium-win-x64-152.0.7977.42-devframe.zip
bytes    290,775,636   (277.3 MB)
sha256   5225c67ae353485aed5235ede5059664e459df0a8a95d5ff38b69dc915df7ee3
```

Fresh-extraction check — the archive is what a user actually receives, so it was extracted to a clean
directory and re-verified rather than trusting the staged tree:

```
extracted 555 files
verified Lobium 152.0.7977.42 win-x64: 554 files,
  tree 0362a3f9384ec4df427351f031fd237e596000e73726960528898878dace0400   (identical)
capability probe on the extract:  contract v3, 21 capabilities, device-frame true
device-frame check on the extract: FRAME ACTIVE — viewport 411x914
```

---

## 6. Not done, and why

**The archive is not uploaded and the manifest is not bumped.**

* `https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip` returns **HTTP 404** and
  always has. The Linux archive at the sibling URL returns 200 and 270,688,368 bytes, so the origin
  and the path convention are both fine — the Windows bytes have simply never been put there.
* Uploading needs credentials for `158.220.91.217` that this host does not have. The brief says to
  ask rather than guess, so I am asking.
* `bump-engine-version.mjs` must not run before the bytes are reachable: the manifest's whole job is
  to name bytes that exist at a URL, and a manifest pointing at a 404 strands every first run after
  the user has already installed. The `stale` marker on the win-x64 entry stays until then, and now
  says so in terms a build can act on — `build-windows-product.ps1` prints a red do-not-ship warning
  when it sees one.

**One caveat on the archive as built.** It was produced with `Compress-Archive`, not by the release
tooling, because no archive step exists in the repo for Windows. If the Linux side's `.tar.gz` step
has a Windows counterpart in mind (deterministic ordering, stored timestamps), this zip should be
rebuilt with it before publishing so the digest is reproducible.

---

## 7. Sequence for whoever publishes this

1. Upload `dist-win/lobium-win-x64-152.0.7977.42-devframe.zip` to
   `/var/www/lobster-downloads/download/engine/lobium-win-x64-152.0.7977.42.zip` on `158.220.91.217`.
2. Download it back from `https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip` and
   require sha256 `5225c67ae353485aed5235ede5059664e459df0a8a95d5ff38b69dc915df7ee3`.
3. Only then:
   ```
   node scripts/bump-engine-version.mjs 152.0.7977.42 --platform win-x64 \
     --archive <zip> --url https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip
   ```
   It will report the `stale` marker it is clearing, and it now refuses rather than silently pairing a
   new digest with an old URL.
