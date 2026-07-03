#!/usr/bin/env bash
# Lobium build driver — fetch -> sync -> apply patches -> gn gen -> ninja.
#
# This is the REAL pipeline (T-010). It is a DRY RUN by default (prints the steps); pass --run to
# execute. Executing requires a dedicated build machine: `depot_tools` on PATH, ~150 GB disk, and
# hours of compile time (use ccache / reclient). It CANNOT run in a small sandbox — that is expected.
#
#   CHROMIUM_REF=<tag> ./build.sh          # dry run (prints the plan)
#   CHROMIUM_REF=<tag> ./build.sh --run    # real build on a build machine
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Pin an exact Chrome-stable tag. Bumped by rebase.sh; keep within a few days of upstream stable.
# Default matches the ref the active patches (core/build-gn + core/config-channel) were built + proven on.
CHROMIUM_REF="${CHROMIUM_REF:-152.0.7928.0}"
SRC_DIR="${SRC_DIR:-${HERE}/chromium/src}"
OUT_DIR="${OUT_DIR:-out/Lobium}"
RUN="${1:-}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }
run()  { if [[ "${RUN}" == "--run" ]]; then eval "$*"; else echo "    $*"; fi; }

step "Lobium build (ref: ${CHROMIUM_REF}, src: ${SRC_DIR}, out: ${OUT_DIR})"
[[ "${RUN}" != "--run" ]] && echo "DRY RUN — pass --run to execute on a build machine."

step "1. Toolchain: depot_tools on PATH"
if ! command -v gclient >/dev/null 2>&1; then
  echo "note: depot_tools not found — https://chromium.googlesource.com/chromium/tools/depot_tools"
  [[ "${RUN}" == "--run" ]] && { echo "error: depot_tools required for --run" >&2; exit 1; }
fi

step "2. Fetch Chromium (first run only) + sync to the pinned ref"
run "mkdir -p '${HERE}/chromium' && cd '${HERE}/chromium'"
run "[ -d src ] || fetch --nohooks chromium"
run "cd '${SRC_DIR}' && git fetch --tags && gclient sync --nohooks --revision 'src@${CHROMIUM_REF}' && gclient runhooks"

step "3. Stage Lobium added files (components/lobium_fp/) — first-party root; applies cleanly across rebases"
run "mkdir -p '${SRC_DIR}/components/lobium_fp'"
run "cp '${HERE}'/src/* '${SRC_DIR}/components/lobium_fp/'"

step "4. Apply the quilt patch series (hook points into existing Chromium files)"
run "cd '${SRC_DIR}' && QUILT_PATCHES='${HERE}/patches' QUILT_SERIES='${HERE}/patches/series' quilt push -a"

step "5. Configure (GN) with the Lobium args"
run "cd '${SRC_DIR}' && gn gen '${OUT_DIR}' --args=\"\$(grep -v '^#' '${HERE}/gn-args.gn.example' | tr '\\n' ' ')\""

step "6. Build"
run "cd '${SRC_DIR}' && autoninja -C '${OUT_DIR}' chrome"

step "Done. Binary: ${SRC_DIR}/${OUT_DIR}/chrome  (rename/rebrand + sign in the packaging step)"
[[ "${RUN}" != "--run" ]] && echo "(dry run — nothing was executed)"
