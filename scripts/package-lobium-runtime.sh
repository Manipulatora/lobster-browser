#!/usr/bin/env bash
# Package a runnable Lobium Linux runtime (~1GB) from the Chromium out/ dir.
# Excludes obj/, gen/, *.runtime_deps, and other build junk (full out/ is ~7.3GB).
#
# Usage:
#   ./scripts/package-lobium-runtime.sh [OUT_DIR]
# Default OUT_DIR: dist-linux/lobium-runtime

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME:-/home/$(whoami)}"

SRC=""
for candidate in \
  "${LOBSTER_LOBIUM_DIR:-}" \
  "${LOBSTER_LOBIUM_SRC:-}" \
  "$HOME_DIR/lobium-build/src/out/LobiumOfficial" \
  "$HOME_DIR/lobium-build/src/out/Lobium" \
  /home/chrome/lobium-build/src/out/Lobium; do
  if [[ -n "$candidate" && -x "$candidate/chrome" ]]; then
    SRC="$candidate"
    break
  fi
done
OUT="${1:-$ROOT/dist-linux/lobium-runtime}"

if [[ -z "$SRC" || ! -x "$SRC/chrome" ]]; then
  echo "error: Lobium chrome not found (set LOBSTER_LOBIUM_DIR to out/Lobium)" >&2
  exit 1
fi

rm -rf "$OUT"
mkdir -p "$OUT"

echo "[lobium-runtime] copying from $SRC → $OUT"

# Core binary + crashpad
cp -a "$SRC/chrome" "$OUT/"
[[ -e "$SRC/chrome_crashpad_handler" ]] && cp -a "$SRC/chrome_crashpad_handler" "$OUT/"
[[ -e "$SRC/chrome_sandbox" ]] && cp -a "$SRC/chrome_sandbox" "$OUT/"

# Shared libraries next to chrome ($ORIGIN)
shopt -s nullglob
for f in "$SRC"/*.so "$SRC"/*.so.*; do
  cp -a "$f" "$OUT/"
done

# Deterministic, redistributable open-font pack. The provisioner copies only explicitly licensed
# DejaVu/Liberation/Carlito/Caladea/Noto/Roboto/Ubuntu/GNU FreeFont faces that are physically present
# on the build host and records their hashes + scanned family names. The provisioner fails if the
# required Noto Unicode/CJK/symbol fallback set is absent; missing fonts are never replaced with
# proprietary OS files or allowed to degrade into square replacement glyphs.
node "$ROOT/scripts/provision-open-fonts.mjs" --out "$OUT/fonts"

# PAK / ICU / V8 / resources Chromium needs at runtime
for f in "$SRC"/*.pak "$SRC"/*.dat "$SRC"/*.bin "$SRC"/icudtl.dat \
         "$SRC"/v8_context_snapshot.bin "$SRC"/snapshot_blob.bin \
         "$SRC"/chrome_100_percent.pak "$SRC"/chrome_200_percent.pak \
         "$SRC"/resources.pak "$SRC"/product_logo_*.png; do
  [[ -e "$f" ]] && cp -a "$f" "$OUT/"
done

# Vulkan ICD manifests (SwiftShader driver). REQUIRED for software WebGL: ANGLE's
# Vulkan-SwiftShader backend loads libvk_swiftshader.so via vk_swiftshader_icd.json
# (library_path is "./libvk_swiftshader.so", relative to this dir). Without the json,
# eglInitialize(SwANGLE) fails ("EGL_NOT_INITIALIZED") and getContext('webgl') returns
# null — which crashes WebGL-using sites to a blank page and is a headless tell.
for f in "$SRC"/*_icd.json "$SRC"/vk_swiftshader_icd.json; do
  [[ -e "$f" ]] && cp -a "$f" "$OUT/"
done

# Directories
for d in locales resources angledata MEIPreload PrivacySandboxAttestationsPreloaded \
         IwaKeyDistribution WidevineCdm; do
  if [[ -d "$SRC/$d" ]]; then
    cp -a "$SRC/$d" "$OUT/"
  fi
done

# Keep a marker so resolveLobiumBinary / LOBSTER_LOBIUM_DIR can find it.
cat > "$OUT/LOBSTER_ENGINE.json" <<EOF
{
  "engine": "lobium",
  "platform": "linux-x64",
  "chrome": "chrome",
  "fonts": "fonts/font-pack.manifest.json",
  "packagedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

chmod +x "$OUT/chrome" || true
du -sh "$OUT"
echo "[lobium-runtime] done → $OUT/chrome"
