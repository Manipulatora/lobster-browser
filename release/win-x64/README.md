# Windows engine — rebranded, with the renderer font fix

Built on the Windows host from `a0c6f9a`, `out/Lobium`, 2h25m, exit 0.

This directory is a **transfer mechanism between the two build hosts**, not the product's
distribution path. Users get the engine from `lobrowser.com` via `engine-manifest.json`.

```
file      lobium-win-x64-152.0.7977.42.zip
bytes     291049912
sha256    1ed28f186b58628199628c3b1e164af669bd793fdfa10f9ae18744f2d55184c9
revision  a0c6f9a7a80ba65618b7fe1679d923f8fb3e01db
contents  554 files, 21 capability hooks, font pack of 77 faces
tree      f261099720fcbbf5ae143397f3e4076f6d3b8ea8a66a10d47dbfb76e55fdf04e
```

Verified by `ci/validation/engine-archive-gate.mjs`: **PASSED** — schema 2, tree hash matches the
archive's own attestation, all 554 files byte-for-byte, revision is a real commit in this
repository, 21 capabilities including `font-isolation` and `device-frame`.

## What is in it that was not in the last one

* **Lobium branding, throughout.** `chrome://version` reads `Lobium 152.0.7977.42`, "The Lobium
  Authors", and contains **zero** occurrences of "Chromium". `en-US.pak` went from 579 occurrences
  of "Chromium" to **0**. PE VERSIONINFO reads Lobium / The Lobium Authors. The `chrome.exe` icon is
  the purple Lobium shield.
* **The Windows renderer font fix** (`fingerprint/windows-font-renderer-fallback.patch`), compiled
  for the first time. Colour emoji now rasterize, non-Latin scripts render instead of tofu, and text
  lands on the metric-clone faces rather than a last-resort face.

Full evidence: `docs/qa/2026-08-31-windows-branding-and-fonts-report.md`.

## What the Linux side needs to do

1. Publish this zip to `https://lobrowser.com/download/engine/lobium-win-x64-152.0.7977.42.zip`.
2. Update the `win-x64` entry in `apps/desktop/src-tauri/resources/engine-manifest.json` with that
   URL and the sha256 above. `scripts/bump-engine-version.mjs --platform win-x64 --archive <zip>`
   does it and runs the archive gate; the platform is cross-checked against the archive's own
   declared platform, so a wrong `--platform` is refused rather than silently writing a win-x64
   digest into the linux entry.
3. Tell the Windows host, which will then build both installers from one checkout and work through
   step 6 of the brief.

**The manifest was deliberately left untouched here.** The bundled installer stamps the digest of
whatever zip the manifest names, so the manifest must not move ahead of the bytes — that ordering is
one of the four artifact-vs-tree incidents this project has already had, and
`engine-archive-gate --check-url` exists to refuse it.

## Not verified from this host

Everything in step 6 of the brief needs an install, which needs the published zip: the taskbar and
Explorer icon binding, the 90 rebranded strings in real UI, the docked Lobee side panel,
export/import, a proxy surviving a sync round trip, and sync convergence.
