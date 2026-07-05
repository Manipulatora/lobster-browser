# Lobium font packs (ENG-6)

Per-OS bundled font sets that make the **font fingerprint** OS-plausible and stable per profile. This is
a **packaging** surface, not a Blink hook: the launcher writes a private `fontconfig` (see
`packages/engine-runner/src/fonts.ts`) that exposes ONLY the bundled dir for the persona's OS and points
`FONTCONFIG_FILE` at it, so Chromium's browser-process fontconfig — which backs width-probe enumeration,
`queryLocalFonts()`, `@font-face src:local()`, and `measureText` metrics — sees exactly this set and no
host fonts.

## Layout

```
lobium/fonts/
  windows/   # metric-compatible faces presented as Arial / Times New Roman / Courier New (+ more in prod)
  macos/     # (todo) Helvetica/Menlo/San-Francisco metric-compatibles
```

The launcher resolves this base dir from **`LOBSTER_FONTS_DIR`** (e.g. `.../lobium/fonts`) and picks the
`<os>/` subdir per persona. When the env var is unset or the OS has no bundle, fonts fall through to the
host (no config written).

## The font files are NOT committed (like the engine binaries)

They are provisioned at package/build time. For **dev** on Linux, symlink the host's metric-compatible
faces (Liberation ≈ Arial/Times/Courier), then export `LOBSTER_FONTS_DIR`:

```sh
mkdir -p lobium/fonts/windows
for f in LiberationSans-{Regular,Bold,Italic,BoldItalic} \
         LiberationSerif-{Regular,Bold,Italic,BoldItalic} \
         LiberationMono-{Regular,Bold,Italic,BoldItalic}; do
  ln -sf "/usr/share/fonts/truetype/liberation/$f.ttf" "lobium/fonts/windows/$f.ttf"
done
export LOBSTER_FONTS_DIR="$PWD/lobium/fonts"
```

**Production** bundles real, licensed metric-compatible faces (Liberation/Carlito/Caladea/Gelasio/Noto,
plus optional name-table-renamed copies for exact family names) under `<os>/`, shipped as a Tauri
resource. The family renames live in `fonts.ts` (`PERSONAS`).
