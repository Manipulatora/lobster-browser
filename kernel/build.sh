#!/usr/bin/env bash
# Lobster Kernel build driver (SCAFFOLD).
#
# Drives a Chromium build: fetch -> sync -> apply patches -> gn gen -> ninja.
# Default is a DRY RUN that prints the steps. Pass --run to execute (needs depot_tools, disk, hours).
#
# Real implementation lands in ticket T-010. Run on a dedicated build machine / self-hosted CI with
# ccache/reclient — compiles are long.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHROMIUM_REF="${CHROMIUM_REF:-CONFIRM_IN_T-010}"   # pin an exact Chromium ref in T-010
OUT_DIR="${OUT_DIR:-out/Lobster}"
RUN="${1:-}"

step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Lobster Kernel build (ref: ${CHROMIUM_REF}, out: ${OUT_DIR})"
if [[ "${RUN}" != "--run" ]]; then
  echo "DRY RUN — pass --run to execute. Planned steps:"
  echo "  1. ensure depot_tools on PATH; fetch chromium (first time)"
  echo "  2. gclient sync --revision src@${CHROMIUM_REF}"
  echo "  3. apply quilt series from ${HERE}/patches/series"
  echo "  4. gn gen ${OUT_DIR} --args=\"\$(cat ${HERE}/gn-args.gn.example)\""
  echo "  5. autoninja -C ${OUT_DIR} chrome"
  exit 0
fi

if [[ "${CHROMIUM_REF}" == CONFIRM* ]]; then
  echo "error: pin CHROMIUM_REF (see T-010) before --run" >&2
  exit 1
fi

# T-010 implements the real fetch/sync/patch/gn/ninja pipeline here.
echo "error: real build pipeline is implemented in T-010" >&2
exit 2
