#!/usr/bin/env bash
# Per-machine first-boot staging. Run once, right after a machine's cloned AVD boots (invoked by
# src/machine-lifecycle.ts over adb).
#
# The app sandbox is part of the OS (Lobium Android, ../aosp/) — there is no app to install and no
# device owner to set. This only stages THIS machine's sandbox policy (from its IslandConfig) where the
# OS reads it, then tells the running OS to re-read it. With no policy file the OS applies its
# compiled-in default (sandbox every third-party app, one profile per app).
#
# Args: $1 = path to this machine's sandbox-policy.json (derived from IslandConfig in the create form).
set -euo pipefail
POLICY_JSON="${1:-}"

# 1) Stage the per-machine policy where SandboxPolicy.load() reads it.
adb shell mkdir -p /data/system/lobium
if [[ -n "$POLICY_JSON" && -f "$POLICY_JSON" ]]; then
  adb push "$POLICY_JSON" /data/system/lobium/sandbox-policy.json
fi

# 2) Tell the OS sandbox service to re-read the policy now (no reboot needed).
adb shell cmd lobium_sandbox reload

echo "sandbox policy staged; OS app sandbox active for this machine."
