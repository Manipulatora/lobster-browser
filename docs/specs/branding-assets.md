# Branding assets (Lobster / Lobium)

## Masters (repo)

| Asset | Path | Use |
| --- | --- | --- |
| Primary icon (lowpoly) | `apps/desktop/src/assets/brand/lobster-icon.png` | Desktop UI, Tauri app icon, Lobium product logos |
| Dark mono tab icon | `apps/desktop/src/assets/brand/lobster-icon-mono-dark.png` | Browser tab / NTP favicon (colorless) |
| Purple variant (legacy) | `apps/desktop/src/assets/brand/lobster-icon-purple.png` | Optional alternate tab mark |
| NTP hero lobster | `apps/desktop/src/assets/brand/lobster-ntp-hero.png` | Sidecar NTP brand mark (CSS title separate) |
| Lobium branding image | `apps/desktop/src/assets/brand/lobium-browser-branding.png` | Marketing / packed NTP hero with text |
| NTP ad (4:1) | `apps/desktop/src/assets/brand/lobium-ntp-ad-4x1.png` | Chrome-like NTP promo strip |
| Wordmark | `apps/desktop/src/assets/brand/lobster-wordmark.png` | Legacy NTP / about brand mark |
| Source candidate | `apps/desktop/src/assets/brand/icon-candidates/lobster-icon-18-lowpoly.png` | Selected icon source |

Size variants: `lobster-icon-{16,32,48,64,128,256,512}.png`, purple counterparts, and `lobster-icon-mono-dark-{16..512}.png`.

Embedded sidecar copies (base64 modules under `packages/engine-runner/src/runners/`):

- `lobster-ntp-hero-data.ts`
- `lobium-ntp-ad-data.ts`
- `lobster-icon-mono-data.ts`

## Apply pipeline

```bash
npm run apply:lobium-branding
```

Writes:

- Tauri PNGs under `apps/desktop/src-tauri/icons/`
- Chromium theme `product_logo_*` + dark mono `favicon_ntp.png`
- NTP resources + `chrome/app/theme/chromium/BRANDING` → Lobium
- User-visible Chrome/Google/Chromium/Lobster strings → **Lobium** in `*_strings.grd*`

Then regenerate platform icons (optional):

```bash
cd apps/desktop && npx @tauri-apps/cli icon src/assets/brand/lobster-icon.png -o src-tauri/icons
```

## Global (all-tabs) branding

1. **Native Lobium**: `watchAndBrandNewTabs` brands every NTP tab via CDP `Page.setDocumentContent` on `about:blank` (omnibox stays clean — **not** a `data:text/html,...` URL).
2. **Patchright harness**: `configureLaunchedContext` uses `setContent` the same way.
3. **Profile name**: passed as `profileName` from desktop → sidecar; shown as an NTP chip and written into Chromium `Default/Preferences` `profile.name` (avatar/profile UI). A true omnibox-left profile chip still needs Lobium chrome patches.
4. **Chromium NTP resources**: after rebuild, packed resources can still carry logos; runtime branding does not depend on a Lobium rebuild.

## Product UI shell

- Global font: **Inter** (`index.html` + `tokens.css` `--font`) — product chrome only; fingerprint font catalogs unchanged.
- Header: icon only (no product name text).
- Sidebar: no brand icon at top.

## Rebuild + package

```bash
# Sidecar-only (NTP branding):
node scripts/bundle-sidecar.mjs
rsync -a apps/desktop/src-tauri/resources/sidecar/ ~/.local/share/lobster/lib/sidecar/

# Full product (UI shell + sidecar):
bash scripts/build-linux-product.sh
```

## Verify

1. Restart the desktop app (`lobster-browser`).
2. Launch a profile → Lobium window.
3. Omnibox should be empty / `about:blank` style — **not** a huge `data:` URL.
4. NTP: large lobster, gradient **Lobster Browser** title, Google search, 4:1 ad, Add shortcut, Customise Lobium, Gmail/Images/apps.
5. Tab favicon: dark mono lobster.
6. Desktop shell: Inter, header icon only, no sidebar logo.
