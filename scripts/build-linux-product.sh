#!/usr/bin/env bash
# Build + install a fully working Linux Lobster Browser product on this machine.
# See docs/specs/linux-packaging.md

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
export PATH="/home/chrome/browser/.tools/node22/bin:/home/chrome/browser/.tools/cargo/bin:${PATH:-}"
export RUSTUP_HOME="${RUSTUP_HOME:-/home/chrome/browser/.tools/rustup}"
export CARGO_HOME="${CARGO_HOME:-/home/chrome/browser/.tools/cargo}"
export LOBSTER_LOBIUM_SRC="${LOBSTER_LOBIUM_SRC:-/home/chrome/lobium-build/src/out/Lobium}"
export LOBSTER_GPU="${LOBSTER_GPU:-gpu}"
export LOBSTER_ANGLE_BACKEND="${LOBSTER_ANGLE_BACKEND:-vulkan}"
export VK_ICD_FILENAMES="${VK_ICD_FILENAMES:-/home/chrome/browser/.gpu/nvidia_icd.json}"
export DISPLAY="${DISPLAY:-:20.0}"

DIST="$ROOT/dist-linux"
INSTALL_ROOT="${HOME}/.local/share/lobster"
BIN_LINK="${HOME}/.local/bin/lobster-browser"

cd "$ROOT"
mkdir -p "$DIST" "$INSTALL_ROOT" "$(dirname "$BIN_LINK")"

echo "==> [1/6] Bundle self-contained sidecar"
node scripts/bundle-sidecar.mjs

echo "==> [2/6] Package Lobium runtime (~1GB)"
bash scripts/package-lobium-runtime.sh "$DIST/lobium-runtime"

echo "==> [3/6] Vendor Node 22"
NODE_DST="$ROOT/apps/desktop/src-tauri/resources/node"
rm -rf "$NODE_DST"
mkdir -p "$NODE_DST/bin"
cp -a /home/chrome/browser/.tools/node22/bin/node "$NODE_DST/bin/node"
chmod +x "$NODE_DST/bin/node"

echo "==> [4/6] Configure + build .deb"
python3 - <<'PY'
import json
from pathlib import Path
p = Path("apps/desktop/src-tauri/tauri.conf.json")
cfg = json.loads(p.read_text())
cfg.setdefault("bundle", {})["resources"] = {
    "resources/sidecar": "sidecar",
    "resources/node": "node",
}
cfg["bundle"]["targets"] = ["deb"]
p.write_text(json.dumps(cfg, indent=2) + "\n")
print("updated", p)
PY

cd "$ROOT/apps/desktop"
npm run tauri -- build --bundles deb 2>&1 | tee "$DIST/tauri-build.log"
cd "$ROOT"

# Locate cargo target (may be under CARGO_TARGET_DIR)
RELEASE_DIR="${CARGO_TARGET_DIR:-$ROOT/apps/desktop/src-tauri/target}/release"
if [[ ! -x "$RELEASE_DIR/lobster-desktop" ]]; then
  RELEASE_DIR=$(dirname "$(find /tmp/cursor-sandbox-cache -path '*/release/lobster-desktop' -type f 2>/dev/null | head -1)")
fi
DEB=$(find "$RELEASE_DIR/bundle/deb" -name '*.deb' 2>/dev/null | head -1)
cp -a "$RELEASE_DIR/lobster-desktop" "$DIST/lobster-desktop"
cp -a "$DEB" "$DIST/"
echo "[build] deb=$DEB"

echo "==> [5/6] Install under $INSTALL_ROOT"
EXTRACT="$DIST/deb-extract"
rm -rf "$EXTRACT" "$INSTALL_ROOT"
mkdir -p "$EXTRACT" "$INSTALL_ROOT"/{bin,lib,lobium}
dpkg-deb -x "$DEB" "$EXTRACT"
APP_LIB="$EXTRACT/usr/lib/Lobster Browser"
cp -a "$EXTRACT/usr/bin/lobster-desktop" "$INSTALL_ROOT/bin/"
cp -a "$APP_LIB/." "$INSTALL_ROOT/lib/"
cp -a "$DIST/lobium-runtime/." "$INSTALL_ROOT/lobium/"

cat > "$INSTALL_ROOT/env" <<EOF
export LOBSTER_NODE_BIN="$INSTALL_ROOT/lib/node/bin/node"
export LOBSTER_SIDECAR="$INSTALL_ROOT/lib/sidecar/index.js"
export LOBSTER_LOBIUM_BIN="$INSTALL_ROOT/lobium/chrome"
export LOBSTER_LOBIUM_DIR="$INSTALL_ROOT/lobium"
export LOBSTER_GPU="${LOBSTER_GPU}"
export LOBSTER_ANGLE_BACKEND="${LOBSTER_ANGLE_BACKEND}"
export VK_ICD_FILENAMES="${VK_ICD_FILENAMES}"
export DISPLAY="${DISPLAY}"
export LOBSTER_HOST_CALIBRATION_FILE="$INSTALL_ROOT/host-calibration.json"
EOF

cat > "$DIST/run-lobster.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source "$INSTALL_ROOT/env"
exec "$INSTALL_ROOT/bin/lobster-desktop" "\$@"
EOF
chmod +x "$DIST/run-lobster.sh"
ln -sfn "$DIST/run-lobster.sh" "$BIN_LINK"

mkdir -p "$HOME/.local/share/applications"
cat > "$HOME/.local/share/applications/lobster-browser.desktop" <<EOF
[Desktop Entry]
Name=Lobster Browser
Exec=$DIST/run-lobster.sh
Terminal=false
Type=Application
Categories=Network;WebBrowser;
EOF

echo "==> [6/6] Product E2E (installed Lobium env)"
set -a
# shellcheck disable=SC1091
source "$INSTALL_ROOT/env"
set +a
node "$ROOT/ci/validation/product-e2e.mjs" 2>&1 | tee "$DIST/product-e2e.log"

echo
echo "======== Linux product ready ========"
echo "Start:  lobster-browser"
echo "Deb:    $DIST/$(basename "$DEB")"
echo "Install:$INSTALL_ROOT"
echo "Docs:   docs/specs/linux-packaging.md"
echo "====================================="
