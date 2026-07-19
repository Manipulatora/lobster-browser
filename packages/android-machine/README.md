# @lobster/android-machine

Per-profile isolated Android **machines** — full Android emulators (AVD/QEMU), one per machine, cloned
copy-on-write from a hardened **golden image**. Each machine ships with **Google Play**, arbitrary APK
install, and — baked into the OS — the **Lobium Island** isolation service.

> **Host requirement:** provisioning/booting a machine needs a host with **KVM** (bare-metal or
> nested-virt) **+ a GPU**, the Android SDK (`emulator`, `avdmanager`, `adb`), and the Android build
> tools to compile the Island app + assemble the image. This is not runnable on a GPU-less box.

## Layout

```
island-app/     The Lobium Island Android app (Kotlin) — device-owner isolation, developed here.
                Compiles to com.lobium.island.apk, placed as a SYSTEM priv-app in the image.
image/          Golden-image build pipeline: base Android + GApps + Island priv-app + first-boot provision.
src/            Host-side TypeScript: AVD lifecycle (provision / clone / boot / stop), fingerprint +
                proxy application, adb/CDP endpoint exposure. Called by the desktop core / sidecar.
```

## Island — the built-in isolation function (developed here)

Island is **not** a Play-store install. It is developed as a first-party Android app
(`island-app/`, package `com.lobium.island`) and shipped **inside the OS image** as a privileged system
app that is auto-provisioned as **device owner** at first boot. It provides "secure app install + account
protection":

1. **Isolated managed profile.** At first boot the app creates an Android *managed profile* (the work-
   profile container) — a separate user space with its own data, isolated from the main space and from
   other isolated apps.
2. **Secure install routing.** When a flagged app (mail/social/banking — see `isolate-defaults.json`) is
   installed, the `InstallRouter` clones/installs it **into the isolated profile** instead of the main
   space, so each account-holding app is sandboxed by default. No user setup.
3. **Idle freeze.** Isolated apps are frozen (suspended) when idle so they cannot run or phone home in
   the background — reducing tracking/linkage.

The per-machine policy (which apps auto-isolate, freeze-on-idle) comes from the create form
(`IslandConfig`) and is written into the machine's provisioning payload.

## Golden image → per-profile clone

`image/build-golden-image.sh` composes the sealed base once; `src/` clones it copy-on-write per machine
and applies the machine's fingerprint (build.prop, GPU/GL, sensors, IMEI/serial) + proxy before boot.
See `docs/OPERATIONS.md` for the host setup.
