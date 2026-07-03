#!/usr/bin/env bash
# Lobium rebase automation — advance to a newer Chrome-stable tag and refresh the quilt series.
#
# The Octo-class moat is tracking Chrome stable within days. This bumps CHROMIUM_REF in build.sh,
# syncs, and re-applies the series with `quilt push`, reporting any patch that no longer applies so a
# human refreshes just that hook. The ADDED files under third_party/lobium-fp/ never reject — only the
# small hook patches can, which is the whole point of the added-file strategy.
#
#   ./rebase.sh 132.0.6834.83        # dry run: show what would change
#   ./rebase.sh 132.0.6834.83 --run  # execute on the build machine
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
NEW_REF="${1:-}"
RUN="${2:-}"
SRC_DIR="${SRC_DIR:-${HERE}/chromium/src}"

[[ -z "${NEW_REF}" ]] && { echo "usage: $0 <chromium-ref> [--run]" >&2; exit 2; }
step() { printf '\n\033[1m==> %s\033[0m\n' "$*"; }

step "Rebase Lobium onto Chromium ${NEW_REF}"
if [[ "${RUN}" != "--run" ]]; then
  echo "DRY RUN. Would:"
  echo "  1. sed -i 's/^CHROMIUM_REF:=.*/…/' build.sh   (pin ${NEW_REF})"
  echo "  2. gclient sync --revision src@${NEW_REF}"
  echo "  3. quilt pop -a; refresh added files; quilt push -a  (report rejects)"
  exit 0
fi

step "1. Pin the new ref in build.sh"
sed -i "s/^CHROMIUM_REF=\"\${CHROMIUM_REF:-.*}\"/CHROMIUM_REF=\"\${CHROMIUM_REF:-${NEW_REF}}\"/" "${HERE}/build.sh"

step "2. Sync the checkout"
( cd "${SRC_DIR}" && git fetch --tags && gclient sync --nohooks --revision "src@${NEW_REF}" )

step "3. Refresh the series"
( cd "${SRC_DIR}" && QUILT_PATCHES="${HERE}/patches" quilt pop -a || true )
cp "${HERE}"/src/* "${SRC_DIR}/third_party/lobium-fp/"
if ( cd "${SRC_DIR}" && QUILT_PATCHES="${HERE}/patches" quilt push -a ); then
  echo "all patches applied cleanly onto ${NEW_REF}"
else
  echo "error: a hook patch no longer applies on ${NEW_REF} — refresh it (quilt push -f; edit; quilt refresh)" >&2
  exit 1
fi
