# Windows report: rebranded engine + font/emoji fix

Answers `docs/qa/2026-08-31-windows-branding-and-fonts.md`. Built on the Windows host from
`a0c6f9a`, engine `out/Lobium`, **2h25m, exit 0**.

Every figure below was read off the artifact. Where something could not be done from this host it
says so rather than being left implied.

---

## The five things Linux could not verify

### 1. `chrome.exe --version` says Lobium — YES

**`--version` itself hangs on this host** and is not a usable check here. `chrome.exe` is a
GUI-subsystem binary with no console attached; run under redirected handles it either answered
`Opening in existing browser session.` (process singleton) or, with an isolated `--user-data-dir`,
timed out at 45s and had to be killed by PID. That is a property of the host, not of this build —
but it means the acceptance criterion has to be read somewhere else.

`chrome://version` carries the same BRANDING-derived string, and is what the brief wanted seen
anyway:

```
Lobium:     152.0.7977.42 (Official Build) (64-bit)
Revision:   db8ceb709fe92f3bb010fb982d6300e54de6dc6a-refs/branch-heads/7977@{#1253}
company:    The Lobium Authors
copyright:  Copyright 2026 The Lobium Authors. All rights reserved.

"Chromium" occurrences on the page : 0
"Lobium"   occurrences on the page : 5
```

PE VERSIONINFO agrees:

```
ProductName     : Lobium
CompanyName     : The Lobium Authors
FileDescription : Lobium
LegalCopyright  : Copyright 2026 The Lobium Authors. All rights reserved.
ProductVersion  : 152.0.7977.42
```

`locales/en-US.pak`, byte-scanned for ASCII and UTF-16LE (note `Select-String -Encoding Byte` is
**invalid in PowerShell 5.1** — the brief's snippet will not run as written; `qa-out/pakscan.mjs`
does a real byte scan instead):

| needle | count |
| --- | --- |
| `Chromium` | **0**  (was 579) |
| `The Chromium Authors` | **0** |
| `Lobium` | 531 |
| `The Lobium Authors` | 2 |
| `Chromium logo` | **0** |
| `Relaunch Lobium` / `Relaunch Chromium` | 5 / **0** |
| `Lobium cannot verify` / `Chromium cannot verify` | 1 / **0** |
| `Lobium is made possible` | 1 |

`resources.pak` and `chrome_100_percent.pak` contain neither string (they are not where UI text
lives).

### 2. The Windows `.ico` binds — YES

The ICO staged into the checkout is byte-identical to the committed overlay:

```
lobium/branding/overlay/chrome/app/theme/chromium/win/chromium.ico   188357 bytes  sha 84C19F29F8C3CB22
<checkout>/chrome/app/theme/chromium/win/chromium.ico                188357 bytes  sha 84C19F29F8C3CB22
```

Extracted from the built `chrome.exe` via `Icon::ExtractAssociatedIcon`, the icon is the purple
Lobium shield — dominant buckets `48,0,96` (57 px), `96,48,192` (28 px), `48,48,144` (28 px). The
Chromium ball's blue/red/yellow/green is absent. Saved at `qa-out/exe-icon.png`; the
`chrome://version` capture shows the same shield plus the Lobium wordmark.

Explorer/taskbar rendering on a real install is still unconfirmed — see "what is not done".

### 3. The renderer patch compiles — YES

Checked **before** committing to the multi-hour build, by compiling only the affected objects:

```
obj/components/lobium_fp/lobium_fp/lobium_fonts.obj                12:04:24
obj/third_party/blink/renderer/platform/platform/font_cache_skia_win.obj   12:06:50
The build has finished successfully.
```

Both fresh, from genuinely patched source (`font_cache_skia_win.cc` carries the `lobium::`
references). The whole series applied clean: **37 patches in `series`, 37 reported OK**, including
`fingerprint/windows-font-renderer-fallback.patch`, with no fuzz and no rejects.

### 4. Emoji rasterize — YES. **The COLRv1 swap is not needed.**

Under a Windows persona with the packaged pack, colour emoji render fully: 😀 😂 😍 👍 🚀 🔥 ❤️ 🎉,
regional-indicator flags 🇺🇸 🇯🇵 🇩🇪, and 🐰 🦞 🐘 🌴.

**So the CBDT/CBLC caveat is closed.** The bitmap font does rasterize colour glyphs, not merely
load. `Noto-COLRv1.ttf` is not required and the pack needs no change.

Non-Latin renders with no tofu on the same fallback path: Arabic, Chinese, Japanese, Korean,
Devanagari, Hebrew, Thai. Text faces are visibly distinct rather than one last-resort face —
Calibri is narrower than Arial, which is Carlito doing its job as the metric clone.

No `lobium_fonts.cc` line appeared on stderr, i.e. the pack registered and the restricted collection
was built.

`ci/validation/font-pack-registration-gate.mjs`:

```
persona       141 claimed families (production-shaped)
registered    5/5 pack-only alias targets
emoji face    Noto Color Emoji
OK: renderer accepts browser font substitutions (metric + class-fallback) and emoji character
    fallback renders a face, all under a production-shaped persona.
```

Screenshots: `qa-out/shots/fonts-final.png`, `qa-out/shots/version.png`.

### 5. Scrollbar arrows — FIXED, and the first result was a false failure worth recording

The first render showed the arrows as **empty `.notdef` boxes** — exactly the reported bug, on a
build that was supposed to fix it.

The cause was local and not the product's: `packages/engine-runner/dist/` was stale from earlier
work, so `planFontAliases` still had the pre-fix behaviour. After `tsc -b`:

```
Segoe Fluent Icons    -> (NOT ALIASED)          Segoe UI Emoji -> Noto Color Emoji
Segoe MDL2 Assets     -> (NOT ALIASED)          Segoe UI Symbol -> Noto Sans Symbols2
HoloLens MDL2 Assets  -> (NOT ALIASED)          Wingdings      -> Noto Sans Symbols2
Arial -> Liberation Sans                        Calibri        -> Carlito
```

and the arrows became solid grey triangles — Chromium's own vector fallback running because the
family resolves to no typeface, which is the designed behaviour.

Both 5×-magnified captures are kept: `qa-out/shots/scrollbar.png` (boxes, stale dist) and
`qa-out/shots/scrollbar-fixed.png` (triangles, correct dist).

**Worth carrying forward:** anyone validating this fix from a repo checkout must rebuild
`engine-runner` first. The aliases are computed by the built `dist/`, so a stale build reproduces
the original bug perfectly and looks like the fix failed.

---

## Branding staging, as it ran

Step 2b, inside `ShouldRun 'patch'`, after the `-Force` reset — the ordering that was missing:

```
overlay: staged 33 binary asset(s) into the checkout
BRANDING: chrome/app/theme/chromium/BRANDING -> Lobium
strings: chrome/app/chromium_strings.grd, settings_chromium_strings.grdp,
         google_chrome_strings.grd, settings_google_chrome_strings.grdp,
         components/components_chromium_strings.grd            -> Lobium
strings: Chromium-only pass over 14 shipped-UI file(s), 14 rewritten
install_static: chromium_install_modes.h -> Lobium display names (identity keys untouched)
ntp: staged 4 brand icon(s)
```

One note on the brief's own instructions: running `-Stop gen` **without** `-Force` trips the
"checkout is not pristine" preflight at line 167, because the patch step has already dirtied the
tree. `-Force` on every invocation is the workable pattern.

---

## The artifact

```
staging   dist-win/lobium-runtime-152.0.7977.42-brand
files     554        capabilities 21 hooks        font pack 77 faces (rescanned)
tree      f261099720fcbbf5ae143397f3e4076f6d3b8ea8a66a10d47dbfb76e55fdf04e
zip       lobium-win-x64-152.0.7977.42.zip
bytes     291049912
sha256    1ed28f186b58628199628c3b1e164af669bd793fdfa10f9ae18744f2d55184c9
revision  a0c6f9a7a80ba65618b7fe1679d923f8fb3e01db
```

`ci/validation/engine-archive-gate.mjs` on the zip: **PASSED** — schema 2, tree hash matches its own
attestation, all 554 files byte-for-byte, revision is a real commit, 21 capabilities including
`font-isolation` and `device-frame`.

Two Vulkan debug artifacts were removed during packaging as before (`VkICD_mock_icd.json`,
`VkLayer_khronos_validation.json`).

---

## What is NOT done, and why

**The zip is not published and `engine-manifest.json` is untouched.** The bundled installer writes a
`.lobium-engine-version` stamp carrying the digest of the zip the manifest names, so publishing has
to happen before either installer is built. This host has no upload path to `lobrowser.com`;
previous releases moved bytes to the Linux side via LFS, which is what this commit does.

Deliberately not edited: pointing the manifest at a URL with no bytes behind it is one of the four
artifact-vs-tree incidents this project already had, and `engine-archive-gate --check-url` exists
precisely to refuse it.

**Therefore all of step 6 is unverified**, because it needs an install:

* Explorer/taskbar icon on a real install (the PE resource is confirmed; the shell binding is not)
* the 90 rebranded strings in surfaces a user meets (the `.pak` counts are confirmed; the UI is not)
* the docked Lobee side panel, and the `Lobee side panel published` log line
* export/import completing, and Cancel actually cancelling
* a proxy surviving a sync or export/import round trip
* sync convergence — a `failed` profile recovering within a minute
* profile-row lobster avatars

**Next step is yours:** publish this zip, update the `win-x64` entry (url + sha256 above), and I will
build both installers from one checkout and work through step 6.

---

## For the product owner, flagged not decided

The engine icon is the existing brand master — a purple shield with the "Lobium" wordmark — while
the launcher's profile avatars are lobster silhouettes. If a lobster was intended for the engine
icon too, that is a swap of one master file plus a re-render, not a code change.
