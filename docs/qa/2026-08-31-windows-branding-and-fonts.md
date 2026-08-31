# Windows: rebrand the engine, and fix emoji / text / scrollbar rendering

**For the agent on the Windows build host.** No memory of the conversation that produced this is
assumed. `git pull` first — everything below has landed on the Linux side.

This is one engine rebuild that closes three of the product owner's test findings. Two of them
require the rebuild; the third is already fixed in app-side code and only needs you to confirm it.

---

## The three findings

### 1. The engine is still Chromium-branded (rebuild required)

Reported: *"the lobster icon is not configured globally — the icon at the Lobium tab is still the
chromium icon, and in chrome://version I can clearly see the Chromium logo. The engine name and
engine version should be fully replaced by ours."*

**Root cause, proven.** `scripts/apply-lobium-branding.mjs` rendered correct Lobium assets and
rewrote the Chromium branding files, but nothing it produced was checked in, and **neither build
path ever ran it**. `lobium/build.ps1` staged only `lobium/src/*` plus four NTP PNGs;
`lobium/build.sh` staged only `lobium/src/*`. So a clean checkout plus a build always produced a
stock-branded engine. Worse, `-Force`'s `git checkout -- .` would have reverted a hand-run of the
script, while running without `-Force` trips the "checkout is not pristine" preflight — the two
modes were mutually exclusive with branding.

Verified against the shipped Linux artifact before the fix: `chrome --version` printed
`Chromium 152.0.7977.42`, `product_logo_48.png` was byte-identical to upstream's blue ball, and
`locales/en-US.pak` carried 579 occurrences of "Chromium".

**What changed.** Branding is now committed and staged deterministically:

* `lobium/branding/overlay/` — 33 committed binary assets at their Chromium-tree-relative paths
  (every `product_logo_*`, the `linux/` variants, `favicon_ntp`, `favicon_product`,
  `product_logo_name_*`, the `.xpm`, the chrome://version wordmark under `components/resources/`),
  **plus a newly generated multi-size Windows `chromium.ico`** (16/24/32/48/64/128 as BMP, 256 as
  PNG) which the old script never produced at all.
* `lobium/branding/BRANDING` — the Lobium BRANDING file that `version_info` compiles from.
* `lobium/stage-branding.mjs` — a deterministic, **Playwright-free** stager. It mirrors the overlay,
  copies BRANDING, applies the product-name string transforms (now including
  `components/components_chromium_strings.grd`, which owns the "Chromium logo" alt-text and the
  chrome://version licence line — the old script never touched it), and stages the NTP icons.
* `scripts/apply-lobium-branding.mjs` is now the **design-time regenerator** only: it renders into
  the committed overlay. It is never a build prerequisite.
* Both drivers now call the stager **after** the patch step, so nothing can revert it:
  `lobium/build.sh` step 4b, and `lobium/build.ps1` step 2b (inside `ShouldRun 'patch'`, before
  `gn gen`).

`branding_path_component` stays `chromium` and we overwrite those files. **Do not set
`is_chrome_branded = true`** — that switches to the `google_chrome` theme path and pulls in
Google-only assets.

### 2. No emoji, and text renders in a wrong face (rebuild required)

Reported: *"this browser cannot handle/display emojis at all, and fonts are awkward — very unusual
compared to other normal browsers."*

**The obvious explanation was wrong, and was ruled out.** The font pack does ship inside the engine
zip, it does contain `Noto Color Emoji`, and the Windows persona's `fontFallbackFamilies` does list
it. I confirmed this by range-fetching `fonts/font-pack.manifest.json` out of the published
`lobium-win-x64-152.0.7977.42.zip`: `windows.physicalFamilies` has 46 entries with
`Noto Color Emoji` at position 9.

**Actual root cause.** Lobium substitutes fonts in the **browser process**, but Blink re-validates
the result in the **renderer** by family name, and no patch hooked that. Two Windows-only failures
in `third_party/blink/renderer/platform/fonts/win/font_cache_skia_win.cc`:

1. `FontCache::GetDWriteFallbackFamily` takes the typeface `matchFamilyStyleCharacter` correctly
   returned (Noto Color Emoji, from the restricted collection), reads its family name back, and
   **re-resolves it by name** through `GetFontPlatformData` → mojo `MatchFamilyName("Noto Color
   Emoji")` → `lobium::FontFamilyAllowed` is false, because a Windows persona's `fonts` list only
   ever contains Windows family names. Result: `nullptr`, so **no character fallback for any
   codepoint** — that is the total emoji failure.
2. `CreateFontPlatformData` calls `TypefacesMatchesFamily(typeface, requested)`. The renderer builds
   its `SkTypeface` from raw pack bytes whose own name is e.g. "Liberation Sans", so a request for
   "Arial"/"Segoe UI" fails the name check and returns `nullptr`. Only the `kLastResort` path (which
   skips the check) renders — that is "fonts feel very unusual".

Linux is immune: its fallback creates fonts by fontconfig **file path**, and its
`CreateFontPlatformData` has no family-name verification.

**What changed.** New patch `lobium/patches/fingerprint/windows-font-renderer-fallback.patch`
(in `series` immediately after `windows-font-isolation.patch`; different file, no textual apply
chain). It builds the fallback platform data straight from the typeface already in hand instead of
re-looking it up by name, and makes the family-name verification alias-aware via a new
`lobium::FontFamilyIsPackPhysical()` predicate in `lobium/src/lobium_fonts.{h,cc}`. To let the
renderer answer that predicate, `fontFallbackFamilies` is no longer stripped from the renderer
config copy (`packages/engine-runner/src/lobium-config.ts` and the mirrored
`lobium/src/lobium_fp_config.cc`) — 46 short names, about 1 KB. `fonts`, `fontPackDir` and
`fontAliases` stay browser-only for command-line size.

**This leaks nothing.** The predicate is a membership test against the profile's *own* pack
inventory; the typeface can only have come from the restricted collection; no host font becomes
resolvable by name.

I verified the patch applies to the real 152.0.7977.42 file with **no fuzz and no offset**.
It is Windows-only code and cannot be compiled on Linux — **your build is its first compile.**

### 3. Scrollbar arrows missing on some profiles (already fixed — just confirm)

Reported: *"the scroll bar's top and bottom tiny buttons are not displayed in some profiles —
'Device' is fine, 'test1' is not."*

**Root cause.** Chromium draws the Fluent scrollbar arrows as glyphs U+EDDB/U+EDDC looked up **by
family name** from "Segoe Fluent Icons" (`ui/native_theme/native_theme_fluent.cc`), and falls back
to its own hand-drawn triangles only when that lookup returns *no* typeface. `planFontAliases` was
aliasing every claimed family the pack lacks onto a pack face — including "Segoe Fluent Icons" →
"Liberation Sans". That returns a real typeface with no chevron glyphs, so the triangle fallback
never ran and the arrows rendered as `.notdef` boxes whose stroke is about a third of a pixel at the
9 px arrow size: invisible. The per-profile split is simply whether the persona *claims* that
family — which is why one profile had arrows and the other did not. It was a bug, not
correct-for-persona: a desktop Windows persona was losing an affordance real Chrome shows.

**Fix (app-side, already landed).** `packages/engine-runner/src/fonts.ts` now refuses to alias
engine UI glyph families (`Segoe Fluent Icons`, `Segoe MDL2 Assets`, `HoloLens MDL2 Assets`), and
the Linux fontconfig gained matching `not_eq` guards. Emoji and symbol families also gained proper
classes, so `Segoe UI Emoji` → `Noto Color Emoji` instead of a Latin sans.
`FONT_CONFIG_SCHEMA_VERSION` was bumped 2 → 3 so cached Linux profiles regenerate; **Windows needs
no bump because `fontAliases` are recomputed on every launch**, so Windows profiles pick this up on
their next start — no rebuild needed for this one.

Proven on Linux against the real fontconfig library with the shipped pack:

```
Segoe UI Emoji      -> "Noto Color Emoji"(w) "Segoe UI Emoji"(s) "Liberation Sans"(w)
Segoe Fluent Icons  -> "Segoe Fluent Icons"(s)          # untouched: no typeface -> triangles
Arial               -> "Liberation Sans"(w) "Arial"(s)  # metric clone intact
```

---

## Task

### 1. Pull and sanity-check

```powershell
git pull
Test-Path lobium\stage-branding.mjs
Test-Path lobium\branding\BRANDING
Test-Path lobium\branding\overlay\chrome\app\theme\chromium\win\chromium.ico
(Get-Content lobium\patches\series) -match 'windows-font-renderer-fallback'
```

### 2. Build the engine

Use the normal driver — the branding stage is wired into it now, so do **not** run
`apply-lobium-branding.mjs` (it needs Playwright and is design-time only).

```powershell
$env:LOBIUM_CHROMIUM_SRC = '<your chromium checkout>'   # or pass -SrcDir
powershell -ExecutionPolicy Bypass -File lobium\build.ps1 -Run -Force
```

`-Force` is safe and correct here: it resets tracked files and re-applies the series, and the
branding stage now runs at step **2b, inside `ShouldRun 'patch'`, after that reset** — which is
precisely the ordering that used to be missing. Without `-Force`, a non-pristine checkout trips the
preflight at line 167.

If the quilt push fails on `windows-font-renderer-fallback.patch`, that is the one new patch —
report the reject rather than force-applying it.

### 3. Prove the branding actually shipped

These are the acceptance criteria. Capture the output verbatim.

```powershell
& "<out>\chrome.exe" --version          # MUST print: Lobium 152.0.7977.42
Select-String -Path "<out>\locales\en-US.pak" -Pattern 'The Lobium Authors'   -Encoding Byte  # > 0 hits
Select-String -Path "<out>\locales\en-US.pak" -Pattern 'The Chromium Authors' -Encoding Byte  # should drop
(Get-Item "<out>\chrome.exe").VersionInfo | Format-List ProductName, CompanyName, FileDescription
```

`ProductName` / `CompanyName` / `FileDescription` come from the same BRANDING file via
`chrome_version.rc.version`, so they should now read Lobium / The Lobium Authors. Also open
`chrome://version` and confirm the logo and the "Lobium" application row, and check the taskbar and
Explorer icon are the Lobium mark rather than the Chromium ball.

### 4. Prove the font fix

With a **Windows-persona profile** (this is the case that was broken):

* A page of emoji renders actual emoji, not blank space or boxes.
* Ordinary text renders in the expected metric-clone face, not a last-resort face.
* The scrollbar's up/down arrow buttons are visible.
* Non-Latin text (Arabic, CJK, Devanagari) renders rather than showing tofu — the same fallback path
  carried all of it.

Then run the registration gate, which was tightened for exactly this bug:

```powershell
node ci\validation\font-pack-registration-gate.mjs
```

Note: the gate previously passed green *while this bug was shipping*, because its test `fonts` list
included pack physical names (so `FontFamilyAllowed` returned true for names production never
claims). It has been reworked toward the production-shaped list. If it still reports green in a way
you do not trust, say so — a green gate here has already been wrong once.

### 5. Repackage, republish, rebuild both installers

Unchanged from the last release; the font pack itself is not modified.

```powershell
.\scripts\package-lobium-runtime.ps1 -OutDir <staging> -SourceDir <out> `
  -FontPack <pack> -FontScanner <fc-scan.exe>
node scripts\verify-lobium-runtime.mjs <staging>
```

Then upload the zip, update the `win-x64` entry in `engine-manifest.json` (url + sha256), and build
**both** installers from one checkout so they cannot drift:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\build-windows-product.ps1
powershell -ExecutionPolicy Bypass -File scripts\build-windows-product.ps1 -Bundled -EngineRuntime <staging>
```

**Remember the `.lobium-engine-version` stamp beside the bundled engine** — without it every fresh
bundled install re-downloads the engine forever.

---

## What I could not verify from Linux, and want back from you

1. **`chrome.exe --version` says Lobium.** This is the whole point of finding 1.
2. **The Windows `.ico` actually binds.** `chrome_exe.rc` already points `IDR_MAINFRAME` at
   `theme\chromium\win\chromium.ico` for the non-branded build, and the stager overwrites that path,
   so it should. But I generated that ICO on Linux and have never seen Windows load it — confirm the
   taskbar/Explorer icon visually.
3. **The renderer patch compiles.** It is `#if`-gated Windows code; your build is its first compile.
4. **Emoji actually rasterize.** One caveat worth an explicit check: the pack's `NotoColorEmoji.ttf`
   is a **CBDT/CBLC bitmap font with no `glyf`/`loca`/`CFF` outline table at all** — I confirmed this
   by parsing the bytes out of the published zip. It clearly *loads* today (DirectWrite's strict
   all-or-nothing pack registration would otherwise have killed the whole font system), but loading
   is not the same as rasterizing colour glyphs. **If emoji are still blank after this rebuild, that
   is the next thing to test** — and the fix would be to swap in Google's COLRv1 build
   (`Noto-COLRv1.ttf`), which has real `glyf`+`loca` outlines plus `COLR`/`CPAL`, reports the
   identical family/PostScript name (so it is a drop-in with no persona or alias change), and is
   5.0 MB against the current 10.7 MB.

   **This is now a latent risk, not the live phantom-launch bug.** `589db08` found and fixed that
   one independently: the staged pack path exceeded Windows `MAX_PATH`, so `FontPackFaces` cleared
   the whole pack and DirectWrite initialisation failed *lazily*, on the first font resolution —
   after the CDP endpoint was already published, which is why the product reported a successful
   launch and the browser died seconds later. Worth noting that both bugs reach the browser through
   the *same* fail-closed chain (empty or unregisterable pack → no restricted collection → no
   fonts), so if a font-shaped launch failure ever reappears, check pack registration before
   suspecting anything else.

### One open question for the product owner, not for you

The engine's product icon is the existing brand master — a purple shield with the "Lobium"
wordmark — not a lobster. The launcher's **profile avatars** are now lobster silhouettes. If the
intent was a lobster for the engine icon too, that is a swap of one master file plus a re-render,
not a code change. Flag it; do not decide it.
