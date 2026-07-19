#!/usr/bin/env bash
# Build Lobium Android — an AOSP fork whose framework sandboxes apps on install by default.
#
# This does the OS half of a machine image: sync AOSP, drop in the Lobium sandbox service, apply the
# framework patches, and build a system image for the emulator (SDK/emulator target). The golden-image
# step (../image/build-golden-image.sh) then wraps that image into a per-profile-cloneable AVD.
#
# HOST-GATED: a real AOSP build needs a beefy Linux host — ~400 GB free disk, 32 GB+ RAM, many cores,
# hours of wall time. It cannot run on the GPU-less/limited dev VPS. Everything under aosp/ is the
# reviewable source + patches; this script is what a provisioned build host runs.
#
# Usage: AOSP_ROOT=/path/to/aosp AOSP_TAG=android-14.0.0_r67 ./build-lobium-android.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
AOSP_ROOT="${AOSP_ROOT:?set AOSP_ROOT to your AOSP checkout root}"
AOSP_TAG="${AOSP_TAG:-android-14.0.0_r67}"
# Emulator (goldfish) x86_64 target; the fingerprint persona is applied per-machine at boot, not baked.
LUNCH_TARGET="${LUNCH_TARGET:-sdk_phone64_x86_64-trunk_staging-userdebug}"

echo "==> 1/5 Sync AOSP ${AOSP_TAG} into ${AOSP_ROOT} (skip if already synced)"
if [[ ! -d "${AOSP_ROOT}/.repo" ]]; then
  mkdir -p "${AOSP_ROOT}"
  ( cd "${AOSP_ROOT}"
    repo init -u https://android.googlesource.com/platform/manifest -b "${AOSP_TAG}" --depth=1
    repo sync -c -j"$(nproc)" --no-tags --no-clone-bundle )
fi

echo "==> 2/5 Drop in Lobium framework sources (overlay/ -> AOSP tree)"
rsync -a "${HERE}/overlay/" "${AOSP_ROOT}/"

echo "==> 3/5 Apply framework patches (patches/series, in order)"
while read -r patch; do
  case "${patch}" in ''|\#*) continue ;; esac
  echo "    - ${patch}"
  # --3way lets git reconcile against minor drift; fix any *.rej before continuing.
  git -C "${AOSP_ROOT}" apply --3way --directory=. "${HERE}/patches/${patch}"
done < "${HERE}/patches/series"

echo "==> 4/5 Build the system image"
( cd "${AOSP_ROOT}"
  set +u; source build/envsetup.sh; set -u
  lunch "${LUNCH_TARGET}"
  m -j"$(nproc)" )

echo "==> 5/5 Done. System image is under ${AOSP_ROOT}/out/target/product/*/."
echo "    Next: ../image/build-golden-image.sh wraps it into the cloneable golden AVD."
echo
echo "Sanity-check the OS sandbox on a booted image with:"
echo "    adb shell cmd lobium_sandbox status"
echo "    adb install some.thirdparty.apk && adb shell cmd lobium_sandbox status   # app -> profile user"
