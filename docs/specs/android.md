# SPEC — Android Lobium Track

> **Decision:** iOS is dropped. Android remains a real product target, but it is a **separate mobile
> engine/device track**, not a desktop profile that claims an Android user agent. Desktop Lobium keeps
> supporting Windows/macOS/Linux; Android Lobium becomes an APK running on Android hardware.

## 1. Product Rule

Android support must mean one of these real execution environments:

- A physical Android phone/tablet running a Lobium/Chromium-derived APK.
- An Android emulator used only for smoke/build validation, never as production detector proof.
- A future cloud-phone fleet where each profile runs on a real/virtualized Android device with coherent
  mobile hardware.

It must **not** mean a Linux/Windows/macOS desktop Chromium process with:

- an Android UA string,
- `uaMobile: true`,
- non-zero `maxTouchPoints`,
- and desktop WebGL/caps/sensors underneath.

That combination is a high-confidence fingerprint contradiction.

## 2. Build Baseline

Android is built from Chromium's Android target, not from the desktop Linux output. Chromium's own Android
build documentation states that Android client builds are done on Linux, with a build directory configured
using `target_os = "android"` and a device-appropriate `target_cpu` such as `arm64`; the normal local
browser target is `chrome_public_apk`.

Primary upstream references:

- Chromium Android build instructions: <https://chromium.googlesource.com/chromium/src/+/master/docs/android_build_instructions.md>
- Android WebView/AOSP integration background: <https://chromium.googlesource.com/chromium/src/+/119.0.6045.199/android_webview/docs/aosp-system-integration.md>

Initial build target:

```gn
target_os = "android"
target_cpu = "arm64"
is_component_build = false
chrome_pgo_phase = 0
symbol_level = 0
```

Initial artifact:

```bash
autoninja -C out/AndroidLobium chrome_public_apk
out/AndroidLobium/bin/chrome_public_apk install
```

## 3. Architecture

Desktop remains the profile manager. Android profiles require an Android runner:

```text
Lobster Desktop / Cloud
  -> Android Device Manager
      -> adb / device bridge
      -> Lobium Android APK
          -> per-profile storage sandbox
          -> Android-native config channel
          -> CDP/debug endpoint for automation
```

The first implementation should support local USB-connected devices. Cloud phones and remote device
farms are later scale work.

## 4. Fingerprint Model

Android needs a mobile-specific profile family. It cannot reuse `OsFamily = windows|macos|linux`.

Required Android surfaces:

- UA and UA-CH: Android version, device model, `uaMobile: true`, mobile form factor.
- Navigator: `platform`, `maxTouchPoints > 0`, realistic mobile `deviceMemory`, mobile CPU buckets.
- Screen: portrait/landscape dimensions, DPR, orientation, viewport/visualViewport consistency.
- GPU: mobile renderer such as Adreno/Mali/PowerVR, Android GL/Vulkan caps, extensions, precision.
- Fonts: Android system fonts such as Roboto/Noto, not desktop font packs/fontconfig.
- Sensors: DeviceMotion/DeviceOrientation and Generic Sensor API policy.
- Battery/network/media/codecs: Android-shaped values and permissions behavior.
- Media devices: mobile camera/microphone/speaker enumeration and permission state.
- WebRTC/proxy/DNS: no host IP leak; behavior must match Android networking constraints.

The production model should mirror desktop's host-calibration pivot:

```text
real Android device calibration -> mobile persona -> per-profile farbling -> proxy geo overlay
```

Fallback catalogs are acceptable only for tests or cloud profiles where the backing Android device class
is controlled and measured.

### 4.1 Current Code Status

`@lobster/fingerprint` now has an Android-only fingerprint foundation:

- `AndroidFingerprint` / `AndroidDeviceFingerprint` in shared types. This is deliberately separate from
  the launchable desktop `Fingerprint` contract.
- `deriveAndroidFingerprint(seed, opts)` selects one whole Android device class from the built-in catalog:
  device model/build, Android version/API, CSS screen/DPR, mobile GPU, CPU/RAM bucket, touch points,
  fonts, UA, and UA-CH.
- `validateAndroidFingerprintCoherence(fp)` checks the Android chain: UA Android token, model, `Mobile`
  marker, Sec-CH-UA platform/model/version, `uaMobile=true`, touch, portrait phone screen, mobile
  GLES/Vulkan renderer, Android fonts, and legal `deviceMemory`.
- `applyGeoToFingerprint` works for Android too, but only as a proxy-geo overlay; it does not mutate
  the Android device identity.
- The desktop coherence validator rejects Android as unsupported instead of allowing a fake desktop
  launch path.

This closes the TypeScript/catalog part of AND-3. It does **not** make Android launchable yet.

## 5. Config Channel

Android Lobium should reuse the same conceptual `lobium-fp.json` schema, but delivery may differ from
desktop flags:

- Desktop uses `--lobium-fp-config=<path>`.
- Android APK should read a per-profile config from app-private storage or an Android command-line/config
  bridge owned by the app/device manager.

Do not assume the desktop flag path is enough for a signed APK. The acceptance criterion is page-visible
surface parity, not flag parity.

### 5.1 Current Code Status

`@lobster/engine-runner` now includes the first Android control-plane scaffolding:

- `buildAndroidLobiumConfig(fp, opts)` creates an Android-specific native config payload from
  `AndroidFingerprint`. It includes Android build metadata, mobile UA-CH model, mobile GPU/screen/fonts,
  farbling seeds, launch policy, and a credential-free proxy summary.
- `writeAndroidLobiumConfig(dir, config)` writes `lobium-android-fp.json` locally with owner-only file
  permissions before ADB delivery.
- `AndroidDeviceBridge` and pure command builders parse `adb devices -l`, build an app-specific remote
  config path, push the config, forward a local CDP port to a device `localabstract` socket, start the APK
  activity with profile/config extras, force-stop the package, and remove the CDP forward.

This is scaffolding for AND-2/AND-4. It is not yet connected to the sidecar RPC or a real APK.

## 6. Native Patch Portability

Likely portable with small changes:

- `components/lobium_fp` parser and farbling kernels.
- Blink-level navigator hardware getters.
- Canvas/WebGL/audio farbling hooks.
- UA/UA-CH metadata source hooks.

Needs Android-specific work:

- Java/browser startup plumbing for config delivery.
- Android UA/device model fields.
- Android fonts and font metrics.
- Touch/orientation/sensor presence.
- Android media codecs/camera/mic permission behavior.
- Proxy/WebRTC/DNS behavior under Android networking.

## 7. Validation Matrix

Minimum Android proof cannot be emulator-only. Start with:

- Pixel 7/8 or newer (Adreno/Tensor-class path).
- Samsung Galaxy A/S series (common Android market path).
- One lower-end Android 11/12 device if target users care about older phones.

Gates:

- Android APK launches and exposes CDP/debug connection.
- Sannysoft, CreepJS, BrowserLeaks, Pixelscan mobile checks show mobile coherence.
- `uaMobile`, UA token, UA-CH model/platform, touch, viewport, DPR, sensors, and WebGL all agree.
- Two profiles on the same device have stable-but-distinct canvas/WebGL/audio farbling.
- Proxy/WebRTC checks prove no direct host/carrier IP leak when a proxy is configured.

## 8. Roadmap

| ID | Task | Acceptance |
|---|---|---|
| AND-0 | Finalize Android MVP scope and device matrix | Pixel/Samsung test devices chosen; emulator marked smoke-only |
| AND-1 | Build unmodified Chromium Android APK from the pinned ref | `chrome_public_apk` installs and launches on a real device |
| AND-2 | Device bridge / runner POC | **partial scaffold**: ADB device parsing, install/start/stop/forward command builders, and bridge sequencing are unit-tested; real APK/device proof remains |
| AND-3 | Add Android fingerprint types + coherence rules | **partial/done in TS**: Android profile emits coherent UA/UA-CH/touch/screen/GPU in tests; native APK consumption still belongs to AND-4..AND-6 |
| AND-4 | Android config-channel delivery | **partial scaffold**: Android config JSON + ADB delivery plan exist; APK reader/app-private bridge remains |
| AND-5 | Android host calibration | Captures device model, Android version, screen/DPR, GPU caps/extensions/precision, fonts, sensors |
| AND-6 | Port native surface hooks | Navigator/WebGL/canvas/audio/screen/touch pass detector assertions on device |
| AND-7 | Android proxy/WebRTC/DNS proof | Configured proxy egress is coherent; direct IP/DNS leak is gated |
| AND-8 | Product UI/API integration | Android appears as experimental only when a mobile runner/device is available |
| AND-9 | Real-device detector gate | Physical-device CI/lab run archives JSON reports and blocks regressions |

## 9. Non-Goals

- iOS/WebKit support.
- Desktop Chromium pretending to be Android.
- Emulator-only production claims.
- Arbitrary Android device strings without matching GPU/caps/sensors.
