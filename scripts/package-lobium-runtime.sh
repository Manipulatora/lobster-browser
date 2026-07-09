#!/usr/bin/env bash
# Package a runnable Lobium Linux runtime (~1GB) from the Chromium out/ dir.
# Excludes obj/, gen/, *.runtime_deps, and other build junk (full out/ is ~7.3GB).
#
# Usage:
#   ./scripts/package-lobium-runtime.sh [OUT_DIR]
# Default OUT_DIR: dist-linux/lobium-runtime

set -euo pipefail

SRC="${LOBSTER_LOBIUM_DIR:-/home/chrome/lobium-build/src/out/Lobium}"
OUT="${1:-/home/chrome/browser/lobster-browser/dist-linux/lobium-runtime}"

if [[ ! -x "$SRC/chrome" ]]; then
  echo "error: Lobium chrome not found at $SRC/chrome" >&2
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

# PAK / ICU / V8 / resources Chromium needs at runtime
for f in "$SRC"/*.pak "$SRC"/*.dat "$SRC"/*.bin "$SRC"/icudtl.dat \
         "$SRC"/v8_context_snapshot.bin "$SRC"/snapshot_blob.bin \
         "$SRC"/chrome_100_percent.pak "$SRC"/chrome_200_percent.pak \
         "$SRC"/resources.pak "$SRC"/product_logo_*.png; do
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
  "packagedAt": "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
}
EOF

chmod +x "$OUT/chrome" || true
du -sh "$OUT"
echo "[lobium-runtime] done → $OUT/chrome"
