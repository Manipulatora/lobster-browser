#!/usr/bin/env bash
# Lobium rebase automation — advance to a newer Chrome-stable tag and refresh the quilt series.
#
# The Octo-class moat is tracking Chrome stable within days. This bumps CHROMIUM_REF in build.sh,
# syncs, and re-applies the series with `quilt push`, reporting any patch that no longer applies so a
# human refreshes just that hook. The ADDED files under components/lobium_fp/ never reject — only the
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
  echo "  1. node scripts/bump-engine-version.mjs ${NEW_REF}   (build.sh CHROMIUM_REF + ENGINE_CHROME)"
  echo "  2. gclient sync --revision src@${NEW_REF}"
  echo "  3. quilt pop -a; refresh added files; quilt push -a  (report rejects)"
  echo "  4. after build+package: bump-engine-version.mjs ${NEW_REF} --tarball <tar.gz>"
  exit 0
fi

# Step 1 used to be a bare `sed` on build.sh. That moved the BUILD ref while leaving ENGINE_CHROME in
# packages/fingerprint untouched, so every rebase silently desynced the version the personas claim from
# the version actually compiled — the exact fingerprint lie the pin exists to prevent. Delegate to the
# bump script, which moves both together and refuses an unreleased (canary) ref outright.
step "1. Pin the new ref (build.sh CHROMIUM_REF + ENGINE_CHROME, in lockstep)"
node "${HERE}/../scripts/bump-engine-version.mjs" "${NEW_REF}"

step "2. Sync the checkout"
( cd "${SRC_DIR}" && git fetch --tags && gclient sync --nohooks --revision "src@${NEW_REF}" )

step "3. Refresh the series"
( cd "${SRC_DIR}" && QUILT_PATCHES="${HERE}/patches" quilt pop -a || true )
cp "${HERE}"/src/* "${SRC_DIR}/components/lobium_fp/"
if ( cd "${SRC_DIR}" && QUILT_PATCHES="${HERE}/patches" quilt push -a ); then
  echo "all patches applied cleanly onto ${NEW_REF}"
else
  echo "error: a hook patch no longer applies on ${NEW_REF} — refresh it (quilt push -f; edit; quilt refresh)" >&2
  exit 1
fi

step "4. Remaining steps (not automated — they need the build host)"
cat <<EOF
  build:    ./build.sh --run
  package:  ../scripts/package-lobium-runtime.sh
  finalize: node ../scripts/bump-engine-version.mjs ${NEW_REF} --tarball <lobium-linux-x64.tar.gz>
            (rewrites engine-manifest.json version/url/sha256 and clears rebuildPending)
  verify:   node ../scripts/track-upstream.mjs            # must exit 0
            node --test ../ci/validation/version-coherence.test.mjs
            node ../ci/validation/regression-gate.mjs

  The patch headers under patches/ record "proven on Chromium <ref>". Those are EVIDENCE claims, not
  pins — update them only after this ref has actually compiled and passed its probes.
EOF
