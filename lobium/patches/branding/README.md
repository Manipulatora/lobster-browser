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

## 2. `omnibox-profile-chip.patch` (native C++ — profile chip inside the omnibox)

Adds a profile-name chip (brand-red dot + name) as the **leftmost leading decoration inside the
LocationBarView** — i.e. inside the same rounded omnibox box that holds the URL and the zoom/page-action
icons, not a separate pill in the toolbar. Reads the per-profile name from the `--lobium-profile-name`
command-line switch the launcher passes (`packages/engine-runner/src/runners/lobium-launcher.ts`);
absent switch → no chip. Touches only
`chrome/browser/ui/views/location_bar/location_bar_view.{cc,h}`.

## 3. `suppress-sandbox-infobar.patch` (native C++ — product polish)

Skips `--no-sandbox` in `ShowBadFlagsPrompt` so the "unsupported command-line flag" security-warning
infobar is not shown. `--no-sandbox` is required by our packaged launch env and is not web-observable.
The companion "Google API keys are missing" infobar is suppressed **without a patch** by inert
`GOOGLE_API_KEY`/`GOOGLE_DEFAULT_CLIENT_ID`/`GOOGLE_DEFAULT_CLIENT_SECRET` env vars set by the launcher
and the installed `env` file.

Apply patches after the resource edits, then rebuild `chrome`.
