# Lobium Android — OS-embedded app sandbox

The mobile-machine equivalent of the desktop **Lobium** engine: instead of an installed isolation app,
app sandboxing is **compiled into the operating system**. Lobium Android is an **AOSP fork** whose
framework moves every third-party app into its own isolated Android profile the moment it is installed.
There is nothing for the user to install, enable, or grant — it is a default property of the OS.

This is the "Island" capability referred to in the product UI, delivered the same way the desktop
anti-detect is: as a native fork (patches + new platform source), not an add-on.

## What it does

When an app is installed into the main space, the OS:

1. sees the install (a platform `PackageMonitor` inside `system_server`);
2. checks the per-machine policy (default: **sandbox every third-party app**);
3. creates an isolated **sandbox profile** (`USER_TYPE_LOBIUM_SANDBOX`) that runs alongside the main
   space, with its own storage, accounts, cookies, and app-set;
4. enables the app inside that profile and hides it in the main space — so the only reachable copy is
   the isolated one.

Because each sandbox is a real Android profile, isolation is enforced by the kernel/framework (separate
UID range, separate `/data/user/<id>`), not by an app that could be bypassed or uninstalled. Preinstalled
system apps (Play, browser, dialer…) are never touched.

## Layout

```
aosp/
  overlay/frameworks/base/services/core/java/com/android/server/lobium/
    LobiumSandboxManagerService.java   # the OS sandbox service (system_server SystemService)
    LobiumSandboxManagerInternal.java  # in-process LocalService contract
    SandboxPolicy.java                 # per-machine policy loader (JSON)
  patches/
    series
    0001-systemserver-start-lobium-sandbox-manager.patch   # bring the service up in system_server
    0002-usertypefactory-lobium-sandbox-profile.patch      # define the sandbox profile user type
  config/sandbox-policy.default.json   # reference schema + the compiled-in default
  build-lobium-android.sh              # sync AOSP -> overlay -> patch -> build system image
```

New platform code lives in `overlay/` mirrored at its real AOSP path and is dropped in by the build
script; only genuine edits to existing AOSP files are `.patch`es. This mirrors the desktop
`lobium/patches/` Chromium fork.

## Policy

`config/sandbox-policy.default.json` documents the schema and the **compiled-in default** the OS uses
when no per-machine file exists (`mode: all`, `isolation: per-app`, `freezeIdleApps: true`). Per machine,
the host stages a file of the same shape at `/data/system/lobium/sandbox-policy.json` (derived from the
create form's `IslandConfig`) and the running OS re-reads it with `adb shell cmd lobium_sandbox reload`.
The capability itself is never disable-able — policy only shapes it (`all` vs `selected`, per-app vs
shared profile, freeze-idle on/off).

## SELinux

No new SELinux domain is required. The service runs entirely inside `system_server` and uses privileges
that domain already holds (create/start profiles, install-existing, hide packages, force-stop). Its
policy files live under `/system/etc` and `/data/system`, which `system_server` reads by default.

## Building — host-gated

A real AOSP build needs a heavy Linux host (~400 GB disk, 32 GB+ RAM, many cores, hours). It **cannot**
run on the limited dev VPS, exactly like the desktop Chromium build. Everything here is the reviewable
source + patches; `build-lobium-android.sh` is what a provisioned build host runs:

```bash
AOSP_ROOT=/data/aosp AOSP_TAG=android-14.0.0_r67 ./build-lobium-android.sh
```

The patches are authored against **AOSP 14 (android-14.0.0_r\*)**. If a tree has drifted, apply with
`git apply --3way` and fix any `*.rej` — the load-bearing choices are documented in each patch header.

Verify on a booted image:

```bash
adb shell cmd lobium_sandbox status                 # policy + sandboxed packages
adb install some.thirdparty.apk
adb shell cmd lobium_sandbox status                 # the app now maps to a sandbox profile user
```
