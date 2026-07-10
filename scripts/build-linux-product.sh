#!/usr/bin/env bash
# Build + install a fully working Linux Lobster Browser product on this machine.
# See docs/specs/linux-packaging.md

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
HOME_DIR="${HOME:-/home/$(whoami)}"

# Prefer repo-local toolchains when present; otherwise use PATH (this VPS: system Node 24 + rustup).
if [[ -d "$ROOT/.tools/node22/bin" ]]; then
  export PATH="$ROOT/.tools/node22/bin:${PATH:-}"
fi
if [[ -d "$ROOT/.tools/cargo/bin" ]]; then
  export PATH="$ROOT/.tools/cargo/bin:${PATH:-}"
fi
export RUSTUP_HOME="${RUSTUP_HOME:-${HOME_DIR}/.rustup}"
export CARGO_HOME="${CARGO_HOME:-${HOME_DIR}/.cargo}"
if [[ -d "$ROOT/.tools/rustup" ]]; then
  export RUSTUP_HOME="$ROOT/.tools/rustup"
fi
if [[ -d "$ROOT/.tools/cargo" ]]; then
  export CARGO_HOME="$ROOT/.tools/cargo"
fi

# Lobium out/ dir (binary + runtime libs). Override with LOBSTER_LOBIUM_SRC / LOBSTER_LOBIUM_DIR.
DEFAULT_LOBIUM_SRC=""
for candidate in \
  "${LOBSTER_LOBIUM_SRC:-}" \
  "${LOBSTER_LOBIUM_DIR:-}" \
  "$HOME_DIR/lobium-build/src/out/Lobium" \
  /home/chrome/lobium-build/src/out/Lobium; do
  if [[ -n "$candidate" && -x "$candidate/chrome" ]]; then
    DEFAULT_LOBIUM_SRC="$candidate"
    break
  fi
done
export LOBSTER_LOBIUM_SRC="${DEFAULT_LOBIUM_SRC}"
export LOBSTER_LOBIUM_DIR="${LOBSTER_LOBIUM_SRC}"

# GPU: this build VPS has no NVIDIA — default to software/SwiftShader. Real-GPU hosts can set
# LOBSTER_GPU=gpu LOBSTER_ANGLE_BACKEND=vulkan VK_ICD_FILENAMES=...
export LOBSTER_GPU="${LOBSTER_GPU:-software}"
export LOBSTER_ANGLE_BACKEND="${LOBSTER_ANGLE_BACKEND:-}"
export DISPLAY="${DISPLAY:-:0}"
# Unset empty ANGLE so resolveGpuMode does not force a missing backend.
[[ -z "${LOBSTER_ANGLE_BACKEND}" ]] && unset LOBSTER_ANGLE_BACKEND || true

DIST="$ROOT/dist-linux"
INSTALL_ROOT="${HOME_DIR}/.local/share/lobster"
BIN_LINK="${HOME_DIR}/.local/bin/lobster-browser"

NODE_BIN="$(command -v node)"
if [[ -z "$NODE_BIN" || ! -x "$NODE_BIN" ]]; then
  echo "error: node not found on PATH" >&2
  exit 1
fi
if [[ -z "$LOBSTER_LOBIUM_SRC" ]]; then
  echo "error: Lobium chrome not found. Set LOBSTER_LOBIUM_SRC to out/Lobium" >&2
  exit 1
fi

cd "$ROOT"
mkdir -p "$DIST" "$INSTALL_ROOT" "$(dirname "$BIN_LINK")"

echo "==> host: $(whoami)@$(hostname)"
echo "==> node: $NODE_BIN ($("$NODE_BIN" -v))"
echo "==> rustc: $(rustc -V 2>/dev/null || echo missing)"
echo "==> lobium: $LOBSTER_LOBIUM_SRC/chrome"
echo "==> gpu: LOBSTER_GPU=$LOBSTER_GPU DISPLAY=$DISPLAY"

echo "==> [1/6] Bundle self-contained sidecar"
node scripts/bundle-sidecar.mjs

echo "==> [2/6] Package Lobium runtime (~1GB)"
LOBSTER_LOBIUM_DIR="$LOBSTER_LOBIUM_SRC" bash scripts/package-lobium-runtime.sh "$DIST/lobium-runtime"

echo "==> [3/6] Vendor Node into Tauri resources"
NODE_DST="$ROOT/apps/desktop/src-tauri/resources/node"
rm -rf "$NODE_DST"
mkdir -p "$NODE_DST/bin"
cp -a "$NODE_BIN" "$NODE_DST/bin/node"
chmod +x "$NODE_DST/bin/node"
# Keep dynamic linker happy for a copied system node (usually fine on same distro).
"$NODE_DST/bin/node" -e "console.log('vendored node ok', process.version)"

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
  FOUND=$(find "$ROOT/apps/desktop/src-tauri/target" -path '*/release/lobster-desktop' -type f 2>/dev/null | head -1 || true)
  if [[ -n "$FOUND" ]]; then
    RELEASE_DIR=$(dirname "$FOUND")
  else
    FOUND=$(find /tmp/cursor-sandbox-cache -path '*/release/lobster-desktop' -type f 2>/dev/null | head -1 || true)
    if [[ -n "$FOUND" ]]; then
      RELEASE_DIR=$(dirname "$FOUND")
    fi
  fi
fi
if [[ ! -x "$RELEASE_DIR/lobster-desktop" ]]; then
  echo "error: lobster-desktop binary not found under $RELEASE_DIR" >&2
  exit 1
fi
DEB=$(find "$RELEASE_DIR/bundle/deb" -name '*.deb' 2>/dev/null | head -1 || true)
if [[ -z "$DEB" ]]; then
  echo "error: .deb not found under $RELEASE_DIR/bundle/deb" >&2
  exit 1
fi
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

# Env file for the installed product (software GPU defaults for this VPS).
{
  echo "export LOBSTER_NODE_BIN=\"$INSTALL_ROOT/lib/node/bin/node\""
  echo "export LOBSTER_SIDECAR=\"$INSTALL_ROOT/lib/sidecar/index.js\""
  echo "export LOBSTER_LOBIUM_BIN=\"$INSTALL_ROOT/lobium/chrome\""
  echo "export LOBSTER_LOBIUM_DIR=\"$INSTALL_ROOT/lobium\""
  echo "export LOBSTER_GPU=\"${LOBSTER_GPU}\""
  echo "export LOBSTER_NO_SANDBOX=\"${LOBSTER_NO_SANDBOX:-1}\""
  if [[ -n "${LOBSTER_ANGLE_BACKEND:-}" ]]; then
    echo "export LOBSTER_ANGLE_BACKEND=\"${LOBSTER_ANGLE_BACKEND}\""
  fi
  if [[ -n "${VK_ICD_FILENAMES:-}" ]]; then
    echo "export VK_ICD_FILENAMES=\"${VK_ICD_FILENAMES}\""
  fi
  echo "export DISPLAY=\"${DISPLAY}\""
  echo "export LOBSTER_HOST_CALIBRATION_FILE=\"$INSTALL_ROOT/host-calibration.json\""
} > "$INSTALL_ROOT/env"

cat > "$DIST/run-lobster.sh" <<EOF
#!/usr/bin/env bash
set -euo pipefail
# shellcheck disable=SC1091
source "$INSTALL_ROOT/env"
exec "$INSTALL_ROOT/bin/lobster-desktop" "\$@"
EOF
chmod +x "$DIST/run-lobster.sh"
ln -sfn "$DIST/run-lobster.sh" "$BIN_LINK"

mkdir -p "$HOME_DIR/.local/share/applications"
cat > "$HOME_DIR/.local/share/applications/lobster-browser.desktop" <<EOF
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
# Headless E2E on this VPS (DISPLAY may be a virtual X without a usable GPU).
export LOBSTER_HEADFUL="${LOBSTER_HEADFUL:-0}"
if node "$ROOT/ci/validation/product-e2e.mjs" 2>&1 | tee "$DIST/product-e2e.log"; then
  E2E_OK=1
else
  E2E_OK=0
  echo "[warn] product-e2e failed — install is still present; see $DIST/product-e2e.log" >&2
fi

echo
echo "======== Linux product ready ========"
echo "Start:  lobster-browser"
echo "Deb:    $DIST/$(basename "$DEB")"
echo "Install:$INSTALL_ROOT"
echo "Docs:   docs/specs/linux-packaging.md"
if [[ "$E2E_OK" -eq 1 ]]; then
  echo "E2E:    PASS"
else
  echo "E2E:    FAIL (install kept)"
fi
echo "====================================="
[[ "$E2E_OK" -eq 1 ]]
