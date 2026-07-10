# Fingerprint catalog provenance

How Lobster builds the verified fonts / WebGL / Android model catalogs used by the create-profile Fingerprint tab and Lobium launch config.

## Rule

Fonts, WebGL renderers, and Android models must come from **official or verified sources with provenance**. Invented inline GPU name lists without device IDs are forbidden.

## Sources

| Dataset | Source | Refresh |
|---|---|---|
| Windows fonts | [MS Learn Win10](https://learn.microsoft.com/en-us/typography/fonts/windows_10_font_list), [Win11](https://learn.microsoft.com/en-us/typography/fonts/windows_11_font_list) | `npm run generate:fingerprint-catalog` |
| macOS fonts | Apple Support: [Ventura](https://support.apple.com/en-us/HT213266), [Sonoma](https://support.apple.com/en-us/108939), [Sequoia](https://support.apple.com/en-us/120414), [Tahoe](https://support.apple.com/en-us/122869) | same |
| Android models | [Play supported_devices.csv](https://storage.googleapis.com/play_public/supported_devices.csv) | same |
| Windows / macOS Intel WebGL | [`packages/fingerprint/data/webgl-renderers.verified.json`](../../packages/fingerprint/data/webgl-renderers.verified.json) built from [pci.ids](https://github.com/pciutils/pciids) (NVIDIA `10de`, AMD `1002`, Intel `8086`) | rebuild JSON from pci.ids, then regenerate catalog |
| macOS Arm WebGL | Same JSON; Apple Silicon labels + Chrome ANGLE Metal string format | extend Apple chip list from Apple product pages |

## Output

`packages/fingerprint/src/catalog.generated.ts` exports:

- `FINGERPRINT_CATALOG_SOURCES` / `CATALOG_PROVENANCE` (URLs, retrievedAt, counts)
- `WINDOWS_FONT_NAMES`, `MACOS_FONT_NAMES`
- `ANDROID_PHONE_MODEL_CATALOG`, `ANDROID_TABLET_MODEL_CATALOG`
- `WINDOWS_RENDERER_PRESETS`, `MACOS_INTEL_RENDERER_PRESETS`, `MACOS_ARM_RENDERER_PRESETS`

Each renderer entry includes `deviceId`, `source`, and `validationLevel: 'verified_source'`.

## Acceptance floors

- Windows fonts ≥ 300
- macOS fonts ≥ 1000
- Android phones ≥ 300, tablets ≥ 30
- Windows renderers ≥ 300 (with PCI `deviceId`)
- macOS renderers (Intel + Arm) ≥ 200

## Default font selection (~435)

Create Profile pre-selects a researched default subset (not the entire catalog):

| OS | Strategy | Target |
|---|---|---|
| Windows | Priority core Win11 families (Segoe UI, Calibri, CJK UI, emoji, …) then fill from verified MS Learn list | **435** (catalog has 506) |
| macOS | Collapse Apple Support versioned face rows → prefer system UI / Helvetica / SF / CJK stems → fill | **435** families |
| Linux | Full verified Ubuntu package family list (honest ceiling) | **all** (~314 today) |

See `packages/fingerprint/src/defaults.ts`. Defaults are always subsets of verified catalogs.

## Android OS-version filter

Play CSV has no API level. `filterAndroidCatalogByOsVersion` applies generation heuristics (Galaxy S21+/Pixel 6+/… for Android 15+) and falls back to the full catalog if the filtered set would be too thin (<80).
