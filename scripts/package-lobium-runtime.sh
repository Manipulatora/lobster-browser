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

# Shared libraries next to chrome ($ORIGIN).
#
# NOT a blanket glob. Three kinds of file in out/ match *.so* and must never be redistributed:
#   * libVkLayer_khronos_validation.so (27.9 MB) — the Vulkan VALIDATION layer. It is a debugging
#     tool loaded only when VK_INSTANCE_LAYERS names it; shipping it costs every user 27.9 MB for a
#     developer feature, and its presence beside chrome is itself an unusual, fingerprintable
#     artifact that no Google Chrome install has.
#   * libVkICD_mock_icd.so (0.8 MB) — a MOCK Vulkan driver used by tests. Real Chrome ships neither.
#   * *.so.TOC (34 KB) — link-time table-of-contents metadata the linker uses for incremental
#     builds. It is never opened at runtime.
# libvk_swiftshader.so and libvulkan.so.1 ARE required (software WebGL, see the ICD note below), so
# an exclusion list is used rather than an allowlist: a future Chromium that adds a genuinely needed
# library still gets packaged, while these three known-unshippable shapes stay out.
shopt -s nullglob
for f in "$SRC"/*.so "$SRC"/*.so.*; do
  base="$(basename "$f")"
  case "$base" in
    *.TOC|libVkLayer_*|libVkICD_mock_icd.so) continue ;;
  esac
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

# locales/ ships 220 *.pak.info files totalling 73.1 MB — GRIT BUILD METADATA, not runtime data.
# Each is a text index mapping resource ids to the generated header that defined them, written so a
# developer can trace a string back to its .grd. Chromium never opens them at runtime (only the
# sibling .pak), real Chrome does not ship them, and they embed absolute build-host paths — so they
# are simultaneously dead weight, a fingerprintable artifact, and an information leak about the
# build machine.
find "$OUT/locales" -name '*.pak.info' -delete 2>/dev/null || true

# Strip the ELF symbol tables.
#
# `symbol_level = 0` in the GN args removes DWARF debug info but NOT the .symtab/.strtab the static
# link produces, so an unstripped `chrome` carries 236.7 MB of mangled C++ names — 45% of the binary.
# Upstream Chrome does strip: chrome/installer/linux/BUILD.gn runs strip_binary() over chrome,
# crashpad, the sandbox, libEGL, libGLESv2, libvulkan and libvk_swiftshader before packaging. Lobium
# copies raw out/ artifacts and so bypassed that target entirely.
#
# For an ANTI-DETECT product the symbols matter more than the megabytes: `nm -C chrome` on an
# unstripped build lists ~100 symbols naming the fork's internals (lobium::LobiumFpConfig::Current,
# LobiumConfiguredHardwareConcurrency, LobiumDeviceFrameView::OnMousePressed, ...), handing anyone
# with the binary a map of exactly which surfaces are spoofed and what to probe.
#
# Debug info is separated FIRST into a sibling directory that is never packaged, so crashes stay
# symbolicable. Set LOBSTER_KEEP_SYMBOLS=1 to skip stripping for a local debugging build.
if [[ "${LOBSTER_KEEP_SYMBOLS:-}" != "1" ]]; then
  DEBUG_OUT="${OUT%/}-debug"
  rm -rf "$DEBUG_OUT"
  mkdir -p "$DEBUG_OUT"
  for bin in "$OUT/chrome" "$OUT/chrome_crashpad_handler" "$OUT"/*.so "$OUT"/*.so.*; do
    [[ -f "$bin" ]] || continue
    # chrome_sandbox is setuid-root and deliberately left alone.
    [[ "$(basename "$bin")" == "chrome_sandbox" ]] && continue
    objcopy --only-keep-debug "$bin" "$DEBUG_OUT/$(basename "$bin").debug" 2>/dev/null || true
    strip --strip-all "$bin" 2>/dev/null || true
  done
  echo "[lobium-runtime] stripped; debug symbols kept out-of-band in $DEBUG_OUT"
  # A release must never ship an unstripped engine again.
  if file "$OUT/chrome" | grep -q "not stripped"; then
    echo "error: $OUT/chrome is still not stripped" >&2
    exit 1
  fi
fi

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
