#!/usr/bin/env bash
# Build the sealed GOLDEN Android system image every machine is cloned from.
#
# Composes: base Android system image + Google Play (GApps) + the built-in Lobium Island app (as a
# privileged SYSTEM app) + Island's privapp-permissions allowlist. The result is a system image that,
# on first boot, provisions Island as device owner (see first-boot-provision.sh) with NO user action.
#
# HOST REQUIREMENTS (cannot run on the GPU-less dev box):
#   - Android SDK: emulator, avdmanager, sdkmanager, adb
#   - KVM (bare-metal or nested-virt) + a GPU for the emulator
#   - A writable system image to inject the priv-app (a userdebug/-eng system image, or a rooted
#     GApps image); Google Play requires a Play-enabled base image (GApps licensing applies).
#   - Gradle + Android build-tools to build the Island APK and platform-sign it.
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
PKG_ROOT="$(cd "$HERE/.." && pwd)"
API_LEVEL="${1:-34}"                          # Android 14 by default
ABI="${LOBIUM_AVD_ABI:-x86_64}"
IMG_TYPE="${LOBIUM_IMG_TYPE:-google_apis_playstore}"   # Play-enabled base
OUT="${LOBIUM_GOLDEN_OUT:-$PKG_ROOT/.golden}"
SYS_IMG="system/priv-app/LobiumIsland"

echo "==> 1/5 Build the Island APK (platform-signed)"
( cd "$PKG_ROOT/island-app" && ./gradlew :assembleRelease )
ISLAND_APK="$PKG_ROOT/island-app/build/outputs/apk/release/island-app-release.apk"
# Platform-sign so it can live in /system/priv-app:
#   apksigner sign --key platform.pk8 --cert platform.x509.pem "$ISLAND_APK"

echo "==> 2/5 Create + boot a writable AVD from the ${IMG_TYPE};${ABI} base (API ${API_LEVEL})"
sdkmanager "system-images;android-${API_LEVEL};${IMG_TYPE};${ABI}" >/dev/null
echo no | avdmanager create avd -n lobium-golden -k "system-images;android-${API_LEVEL};${IMG_TYPE};${ABI}" --force
emulator -avd lobium-golden -writable-system -no-window -gpu swiftshader_indirect -no-snapshot &
adb wait-for-device
adb root && adb remount

echo "==> 3/5 Install Island as a privileged SYSTEM app + its permission allowlist"
adb push "$ISLAND_APK" "/${SYS_IMG}/LobiumIsland.apk"
adb push "$HERE/privapp-permissions-com.lobium.island.xml" \
         /system/etc/permissions/privapp-permissions-com.lobium.island.xml
adb shell mkdir -p /data/system/lobium

echo "==> 4/5 Stage first-boot provisioning (device-owner set on next clean boot)"
adb push "$HERE/first-boot-provision.sh" /data/system/lobium/first-boot-provision.sh

echo "==> 5/5 Seal the golden snapshot"
adb reboot
adb wait-for-device
adb emu avd snapshot save golden
adb emu kill
mkdir -p "$OUT"
echo "golden image built for API ${API_LEVEL} ${IMG_TYPE};${ABI}. Clone per machine via src/machine-lifecycle.ts."
