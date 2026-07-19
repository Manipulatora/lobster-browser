#!/usr/bin/env bash
# First-boot provisioning for a per-machine clone. Run once, right after a machine's cloned AVD boots
# (invoked by src/machine-lifecycle.ts over adb). Sets Lobium Island as DEVICE OWNER and writes the
# machine's per-Island policy — so isolation is active with zero user interaction.
#
# Args: $1 = path to this machine's island-policy.json (derived from IslandConfig in the create form).
set -euo pipefail
POLICY_JSON="${1:-}"
ADMIN="com.lobium.island/.LobiumIslandAdminReceiver"

# 1) Make Island the device owner. Only works on a fresh device with no accounts (true for a clone).
adb shell dpm set-device-owner "$ADMIN"

# 2) Write the per-machine policy where IslandPolicy.load() reads it.
adb shell mkdir -p /data/system/lobium
if [[ -n "$POLICY_JSON" && -f "$POLICY_JSON" ]]; then
  adb push "$POLICY_JSON" /data/system/lobium/island-policy.json
fi

# 3) Kick provisioning now (the admin's onEnabled + BootReceiver also do this idempotently).
adb shell am broadcast -a android.app.action.DEVICE_ADMIN_ENABLED -n "$ADMIN"

echo "island provisioned as device owner; isolated user + policy applied."
