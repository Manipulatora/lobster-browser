# @lobster/android-machine

Per-profile isolated Android **machines** — full Android emulators (AVD/QEMU), one per machine, cloned
copy-on-write from a hardened **golden image**. Each machine ships with **Google Play**, arbitrary APK
install, and runs **Lobium Android** — an AOSP fork whose framework **sandboxes apps on install** (the
"Island" capability, built into the OS rather than installed).

> **Host requirement:** provisioning/booting a machine needs a host with **KVM** (bare-metal or
> nested-virt) **+ a GPU**, the Android SDK (`emulator`, `avdmanager`, `adb`), and — to build the OS
> itself — a heavy AOSP build host. This is not runnable on a GPU-less box.

## Layout

```
aosp/           Lobium Android — the AOSP fork. Framework sandbox service + patches + build script.
                This is where app isolation lives; it is compiled into the OS, not an installed app.
image/          Golden-image build pipeline: the fork's system image + GApps, sealed as a cloneable AVD.
src/            Host-side TypeScript: AVD lifecycle (provision / clone / boot / stop), fingerprint +
                proxy application, per-machine sandbox-policy staging, adb/CDP endpoint exposure.
```

## Island — sandboxing embedded in the OS

Island is **not** an app — there is nothing to install or provision. It is a property of the operating
system: **Lobium Android** (`aosp/`) is an AOSP fork whose framework, inside `system_server`, moves every
third-party app into an isolated Android **profile** the moment it is installed. Separate storage,
accounts, cookies, and app-set — walled off from other apps and from the main space, enforced by the
kernel/framework rather than by an app that could be bypassed or removed. Preinstalled system apps are
never touched. See `aosp/README.md` for the mechanism and build.

The per-machine policy (sandbox all apps vs selected, per-app vs shared profile, freeze-on-idle) comes
from the create form (`IslandConfig`); `src/machine-lifecycle.ts` stages it at
`/data/system/lobium/sandbox-policy.json` at boot and the OS re-reads it. With no file, the OS applies
its compiled-in default: sandbox every third-party app, one isolated profile per app.

## Golden image → per-profile clone

`aosp/build-lobium-android.sh` builds the OS once (heavy build host); `image/build-golden-image.sh` seals
it — plus GApps — into a golden AVD; `src/` clones that copy-on-write per machine and applies the
machine's fingerprint (build.prop, GPU/GL, sensors, IMEI/serial) + proxy before boot. See
`docs/OPERATIONS.md` for host setup.
