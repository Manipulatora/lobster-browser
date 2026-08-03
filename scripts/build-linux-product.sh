#!/usr/bin/env bash
# Build + install a fully working Linux Lobster Browser product on this machine.
# See docs/OPERATIONS.md (§2)

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
  "$HOME_DIR/lobium-build/src/out/LobiumOfficial" \
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

# Never silently ship the fast-link development component build. Chromium's
# own BUILDCONFIG documents that only the official tier is suitable for end
# users; it removes release DCHECK overhead and enables the platform's PGO /
# ThinLTO defaults. Prepackaged runtimes may not carry args.gn, but a local
# Chromium out directory does and must prove the production configuration.
LOBIUM_ARGS="$LOBSTER_LOBIUM_SRC/args.gn"
if [[ -f "$LOBIUM_ARGS" ]]; then
  if ! grep -Eq '^[[:space:]]*is_official_build[[:space:]]*=[[:space:]]*true' "$LOBIUM_ARGS" ||
     ! grep -Eq '^[[:space:]]*is_component_build[[:space:]]*=[[:space:]]*false' "$LOBIUM_ARGS"; then
    echo "error: refusing to package a development Lobium build: $LOBIUM_ARGS" >&2
    echo "       build out/LobiumOfficial from lobium/gn-args.gn.example" >&2
    exit 1
  fi
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
FONTS_DST="$ROOT/apps/desktop/src-tauri/resources/fonts"
rm -rf "$NODE_DST"
mkdir -p "$NODE_DST/bin"
cp -a "$NODE_BIN" "$NODE_DST/bin/node"
chmod +x "$NODE_DST/bin/node"
rm -rf "$FONTS_DST"
cp -a "$DIST/lobium-runtime/fonts" "$FONTS_DST"
# Keep dynamic linker happy for a copied system node (usually fine on same distro).
"$NODE_DST/bin/node" -e "console.log('vendored node ok', process.version)"

# Lobee: the first-party in-browser agent side-panel extension (React/TS/Tailwind, MV3), auto-loaded
# into every profile. Rebuild it from source (packages/lobee-app → packages/lobee) so the shipped
# bundle is always current, then stage the self-contained output.
node "$ROOT/scripts/build-lobee.mjs"   # builds, stages into src-tauri/resources/lobee, and runs the anti-detect manifest guard

echo "==> [4/6] Build .deb"
# tauri.conf.json declares every resource (sidecar, node, fonts, lobee, engine-manifest.json) and is
# NOT rewritten here. It used to be: this script overwrote the resource map with its own four-entry
# dict, which silently dropped `engine-manifest.json` — the file `lib.rs` reads to resolve the
# first-run engine download — so a packaged build could not provision an engine without env overrides.
# The bundle target comes from `--bundles deb` on the command line below.

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
  echo "export LOBSTER_LOBEE_DIR=\"$INSTALL_ROOT/lib/lobee\""
  echo "export LOBSTER_LOBIUM_BIN=\"$INSTALL_ROOT/lobium/chrome\""
  echo "export LOBSTER_LOBIUM_DIR=\"$INSTALL_ROOT/lobium\""
  echo "export LOBSTER_FONTS_DIR=\"$INSTALL_ROOT/lobium/fonts\""
  echo "export LOBSTER_EXTENSION_CACHE_DIR=\"$INSTALL_ROOT/extension-cache\""
  echo "export LOBSTER_GPU=\"${LOBSTER_GPU}\""
  if [[ "${LOBSTER_GPU}" == "software" ]]; then
    # This host has no physical GPU. Allow product-path calibration only as explicitly provisional;
    # detector grading still rejects software renderers as release evidence.
    echo "export LOBSTER_ALLOW_SOFTWARE_GPU_CALIBRATION=\"1\""
  fi
  echo "export LOBSTER_NO_SANDBOX=\"${LOBSTER_NO_SANDBOX:-1}\""
  # Inert Google API keys: their presence suppresses the "Google API keys are missing"
  # infobar without enabling any Google service call.
  echo "export GOOGLE_API_KEY=\"no\""
  echo "export GOOGLE_DEFAULT_CLIENT_ID=\"no\""
  echo "export GOOGLE_DEFAULT_CLIENT_SECRET=\"no\""
  if [[ -n "${LOBSTER_ANGLE_BACKEND:-}" ]]; then
    echo "export LOBSTER_ANGLE_BACKEND=\"${LOBSTER_ANGLE_BACKEND}\""
  fi
  if [[ -n "${VK_ICD_FILENAMES:-}" ]]; then
    echo "export VK_ICD_FILENAMES=\"${VK_ICD_FILENAMES}\""
  fi
  echo "export DISPLAY=\"${DISPLAY}\""
  echo "export LOBSTER_HOST_CALIBRATION_FILE=\"$INSTALL_ROOT/host-calibration.json\""
  # Software rendering: pin the bundled SwiftShader Vulkan ICD so SwANGLE initializes
  # deterministically (host Vulkan ICDs can be partial/incompatible and break WebGL).
  if [[ "${LOBSTER_GPU}" == "software" && -f "$INSTALL_ROOT/lobium/vk_swiftshader_icd.json" ]]; then
    echo "export VK_ICD_FILENAMES=\"$INSTALL_ROOT/lobium/vk_swiftshader_icd.json\""
    echo "export VK_DRIVER_FILES=\"$INSTALL_ROOT/lobium/vk_swiftshader_icd.json\""
  fi
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

# Stage a product icon and register a launcher entry that references it, so the app shows an icon in
# the desktop menu. An absolute Icon= path is the most portable across desktop environments; we also
# drop the PNG into the hicolor theme for DEs that resolve icons by name.
ICON_SRC="$ROOT/apps/desktop/src-tauri/icons/128x128@2x.png"
[[ -f "$ICON_SRC" ]] || ICON_SRC="$ROOT/apps/desktop/src-tauri/icons/128x128.png"
ICON_DST="$INSTALL_ROOT/lobster.png"
cp -f "$ICON_SRC" "$ICON_DST" 2>/dev/null || true
for sz in 128x128 256x256; do
  HICOLOR="$HOME_DIR/.local/share/icons/hicolor/$sz/apps"
  mkdir -p "$HICOLOR"
  cp -f "$ICON_SRC" "$HICOLOR/lobster-browser.png" 2>/dev/null || true
done

mkdir -p "$HOME_DIR/.local/share/applications"
cat > "$HOME_DIR/.local/share/applications/lobster-browser.desktop" <<EOF
[Desktop Entry]
Name=Lobster Browser
Comment=Anti-detect browser with a per-profile web agent
Exec=$DIST/run-lobster.sh
Icon=$ICON_DST
Terminal=false
Type=Application
Categories=Network;WebBrowser;
StartupWMClass=lobster-desktop
EOF
update-desktop-database "$HOME_DIR/.local/share/applications" 2>/dev/null || true
gtk-update-icon-cache -f -t "$HOME_DIR/.local/share/icons/hicolor" 2>/dev/null || true

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
echo "Docs:   docs/OPERATIONS.md (§2)"
if [[ "$E2E_OK" -eq 1 ]]; then
  echo "E2E:    PASS"
else
  echo "E2E:    FAIL (install kept)"
fi
echo "====================================="
[[ "$E2E_OK" -eq 1 ]]
