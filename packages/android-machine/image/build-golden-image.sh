#!/usr/bin/env bash
# Build the sealed GOLDEN Android system image every machine is cloned from.
#
# The OS is Lobium Android — an AOSP fork whose framework sandboxes apps on install (see ../aosp/). The
# sandbox is part of the operating system, so there is NO app to install and NO device owner to set:
# this script just builds that OS, adds Google Play, and seals a cloneable golden snapshot.
#
# HOST REQUIREMENTS (cannot run on the GPU-less dev box):
#   - The Lobium Android system image, built by ../aosp/build-lobium-android.sh on a heavy build host
#     (~400 GB disk, 32 GB+ RAM). Point LOBIUM_SYSTEM_IMAGE at its out/target/product/<dev>/ dir.
#   - Android SDK: emulator, avdmanager, sdkmanager, adb
#   - KVM (bare-metal or nested-virt) + a GPU for the emulator
#   - A Play-enabled GApps package to overlay (Google Play licensing applies).
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
API_LEVEL="${1:-34}"                          # Android 14 by default
ABI="${LOBIUM_AVD_ABI:-x86_64}"
OUT="${LOBIUM_GOLDEN_OUT:-$PKG_ROOT/.golden}"
# The Lobium Android system image (framework sandbox baked in). Built by ../aosp/build-lobium-android.sh.
SYSTEM_IMAGE="${LOBIUM_SYSTEM_IMAGE:?set LOBIUM_SYSTEM_IMAGE to the out/target/product/<dev>/ dir from ../aosp/build-lobium-android.sh}"

echo "==> 1/4 Register the Lobium Android system image as an emulator target (API ${API_LEVEL} ${ABI})"
# The fork's build output is used directly as the AVD system image; no stock system-image download.
echo no | avdmanager create avd -n lobium-golden \
  -k "system-images;android-${API_LEVEL};lobium;${ABI}" --force 2>/dev/null || true

echo "==> 2/4 Boot the fork, overlay Google Play (GApps)"
emulator -avd lobium-golden -writable-system -no-window -gpu swiftshader_indirect -no-snapshot \
  -sysdir "$SYSTEM_IMAGE" &
adb wait-for-device
adb root && adb remount
# Overlay GApps if provided (Play is a licensed add-on, not part of the AOSP fork).
if [[ -n "${LOBIUM_GAPPS_DIR:-}" ]]; then
  adb push "${LOBIUM_GAPPS_DIR}/." /system/
fi
# Sanity-check the OS sandbox is live before sealing.
adb shell cmd lobium_sandbox status || { echo "FATAL: OS sandbox not present in system image"; exit 1; }

echo "==> 3/4 Prepare the per-machine policy directory (staged per clone at boot, not baked here)"
adb shell mkdir -p /data/system/lobium

echo "==> 4/4 Seal the golden snapshot"
adb reboot
adb wait-for-device
adb emu avd snapshot save golden
adb emu kill
mkdir -p "$OUT"
echo "golden image built for API ${API_LEVEL} (Lobium Android, ${ABI}). Clone per machine via src/machine-lifecycle.ts."
