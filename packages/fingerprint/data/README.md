# Fingerprint catalog source data

Checked-in, provenance-bearing inputs for `scripts/generate-fingerprint-catalog.mjs`.

| File | Role |
|---|---|
| `webgl-renderers.verified.json` | Windows / macOS WebGL renderer presets with PCI device IDs (from [pciutils/pciids](https://github.com/pciutils/pciids)) or Apple Silicon product IDs |

Fonts and Android models are fetched live from official URLs at generation time (see provenance doc). Do not invent GPU model names without a `deviceId` + `source`.
