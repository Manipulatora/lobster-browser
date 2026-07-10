# Lobium branding patches

Lobium is **stock Chrome visually**, with only brand images swapped and one added native element.
Two mechanisms produce that, split by what each is best at:

## 1. `scripts/apply-lobium-branding.mjs` (resource/string edits — idempotent)

Applied to the Chromium source before a build. It swaps icon/logo assets and the NTP brand images,
and keeps the product name "Lobium" in UI strings. It deliberately does **not** touch shortcuts, the
One-Google-Bar, the omnibox placeholder, or the Web Store label — those stay stock Chrome.

New Tab Page result (the real `chrome://newtab`, not an injected mock):
- **master brand** (`icons/lobium_master.png`, transparent) as the logo **on the search box**;
- **`icons/profile_branding.png`** (transparent sub-brand) **under the search box**;
- real omnibox ("Search Google or type a URL"), real "Add shortcut" tiles, title **"New Tab"**.

Brand image sources live in `apps/desktop/src/assets/brand/`; the transparent variants are produced by
`scripts/make-brand-transparent.mjs` (corner flood-fill background removal).

## 2. `toolbar-profile-chip.patch` (native C++ — a real toolbar element)

Adds a profile-name chip (brand-colored dot + name) as a rounded pill **immediately left of the
omnibox** in `ToolbarView`. It reads the per-profile name from the `--lobium-profile-name` command-line
switch that the launcher passes (`packages/engine-runner/src/runners/lobium-launcher.ts`). Absent
switch → no chip. This replaces the old in-page profile chip that the removed injected NTP used to draw.

Apply after the resource edits (it only touches `chrome/browser/ui/views/toolbar/toolbar_view.{cc,h}`),
then rebuild `chrome`.
