// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_capabilities.h.

#include "components/lobium_fp/lobium_capabilities.h"

#include <string_view>
#include <vector>

#include "base/strings/strcat.h"
#include "base/strings/string_number_conversions.h"
#include "build/build_config.h"

namespace lobium {

namespace {

// Hooks compiled on every platform.
//
// Each name corresponds to a patch in lobium/patches/series; the mapping is documented per hook in
// lobium/hooks.md and enforced by ci/validation/patch-series.test.mjs.
constexpr std::string_view kPortableCapabilities[] = {
    // The config channel itself. Everything below is inert without it, so a build that reports any
    // capability must report this one.
    "config-channel-v1",
    // navigator.userAgent/platform/hardwareConcurrency/deviceMemory/maxTouchPoints, the outgoing
    // User-Agent header and the whole Sec-CH-UA family. Reported separately from the config channel
    // because the two are genuinely separable: core/navigator-ua-ch.patch hooks five upstream files
    // that core/config-channel.patch does not touch, so a tree with the transport applied and this
    // patch rejected still parses the persona and still reports the HOST on every one of those
    // surfaces - a failure that looks exactly like a working launch from the outside.
    "navigator-ua-ch",
    // navigator.webdriver is a separate Blink hook. Keeping it separate prevents a build that has
    // the UA/UA-CH patch but missed navigator-webdriver.patch from claiming automation protection.
    "navigator-webdriver",
    "navigator-languages",
    "network-accept-language",
    "process-locale-timezone",
    "native-geolocation",
    "webrtc-policy",
    // WebGL1: vendor/renderer, VERSION, SHADING_LANGUAGE_VERSION, MAX_* caps, shader precision, and
    // the registration-ordered extension list.
    "webgl-deep",
    // WebGL2: the per-context extension list, plus the uniform/varying COMPONENT limits derived from
    // the persona's vector limits so the two contexts cannot contradict each other.
    "webgl2-deep",
    // screen.*, window.devicePixelRatio, and the CSS device-size media values, which must agree with
    // each other and with the persona's claimed display.
    "screen-metrics",
    // Android persona parity in Blink: suppression of the desktop PDF plugin surface when the config
    // declares uaMobile. Only required for an Android persona, but always compiled.
    //
    // NARROWED 2026-08-26. This used to read "Touch points, pointer/hover media features and the
    // rest of the mobile-shaped surfaces", which over-claimed by a wide margin:
    // fingerprint/mobile-persona.patch hooks exactly one upstream file,
    // third_party/blink/renderer/modules/plugins/dom_plugin_array.cc, and nothing else.
    //
    // Where those surfaces actually come from:
    //   * navigator.maxTouchPoints -> navigator-ua-ch, which reports it with the rest of navigator.
    //   * (pointer: coarse) / (hover: none) -> NOT from the binary at all. They come from the CDP
    //     Emulation.setDeviceMetricsOverride{mobile:true} that the Android path installs
    //     (packages/engine-runner/src/mobile-emulation.ts).
    //
    // Measured on the Windows host: an Android persona launched with only --lobium-fp-config - the
    // desktop path, no CDP emulation - reports uaMobile true, maxTouchPoints 5 and a 393x873 screen
    // while (pointer: coarse) and (hover: none) both answer FALSE. Over-reporting is the dangerous
    // direction for this contract: the sidecar requires mobile-persona for a mobile launch, and if
    // anyone trusted the old wording and dropped the CDP layer, pointer and hover would silently
    // revert to desktop next to an Android UA.
    "mobile-persona",
    "canvas-farbling",
    "webgl-farbling",
    "audio-farbling",
    "client-rects",
    "media-devices",
    // navigator.gpu adapter identity, derived from the same GPU the WebGL renderer names.
    "webgpu-adapter",
    // The persona timezone applied inside the engine. Distinct from process-locale-timezone: the TZ
    // environment variable is POSIX-only, and on Windows ICU reads the registry instead, so the
    // env-var route silently does nothing there.
    "native-timezone",
};

}  // namespace

std::string CapabilityManifestJson() {
  std::vector<std::string_view> names(std::begin(kPortableCapabilities),
                                      std::end(kPortableCapabilities));

#if BUILDFLAG(IS_WIN)
  // Native Windows font-isolation machinery: one restricted DirectWrite collection shared by
  // FontDataService, character fallback, local(), Local Font Access, chrome.fontSettings, and the
  // legacy proxy, plus verified-pack transport and CSS claimed-family alias plumbing.
  //
  // This capability says the binary has those hooks. It does NOT claim that a pack was supplied at
  // this launch, that every claimed family has a metric-exact substitute, or that physical pack
  // faces fabricate proprietary PostScript/full names in Local Font Access. Runtime gates prove
  // pack registration and report alias residuals separately.
  //
  // Windows-only on purpose, and deliberately conservative. The FontDataService half also compiles
  // on Linux (kFontDataServiceLinux is enabled by default there too), so a Linux build does carry
  // part of this. But Linux isolates fonts through the launcher's per-profile FONTCONFIG_FILE, which
  // is not a property of the binary at all, and claiming the capability there would assert coverage
  // the binary alone cannot provide. Under-reporting costs nothing — requiredLobiumCapabilities only
  // asks for it on win32 — while over-reporting would let the sidecar launch believing in isolation
  // that is not there.
  names.push_back("font-isolation");
#endif

#if BUILDFLAG(IS_LINUX) || BUILDFLAG(IS_WIN)
  // The Android phone/tablet stage: LobiumDeviceFrameView is constructed by BrowserView and kept
  // locked to the renderer emulation scale.
  //
  // This is a UI feature in a fingerprint contract on purpose. An Android persona whose window is
  // a desktop-shaped rectangle at desktop dimensions contradicts the persona it just claimed, so
  // the frame is a fingerprint surface in effect even though it is drawn rather than reported.
  //
  // It is here because of how its absence failed. The launcher emits --lobium-device-frame
  // unconditionally for a mobile profile, Chromium ignores switches it does not know, and the
  // capability contract did not cover the feature - so a binary built without it launched, reported
  // success, and simply had no frame. That shipped and went unnoticed for days. Declaring it here
  // means such a binary now refuses a mobile launch instead of quietly degrading it.
  //
  // Guarded to the platforms whose BrowserView call sites are compiled: macOS has none, so a macOS
  // build must not claim it. requiredLobiumCapabilities only asks for it on an emulated Android
  // launch, so under-reporting elsewhere costs nothing.
  names.push_back("device-frame");
#endif

  std::string out = base::StrCat(
      {"{\"contractVersion\":",
       base::NumberToString(kCapabilityContractVersion),
       ",\"product\":\"Lobium\",\"capabilities\":["});
  for (size_t i = 0; i < names.size(); ++i) {
    if (i > 0) {
      out += ',';
    }
    // The names are compile-time literals from this file, so no JSON escaping is needed - and any
    // name requiring escaping would fail the CI cross-check against the TypeScript mirror first.
    base::StrAppend(&out, {"\"", names[i], "\""});
  }
  out += "]}";
  return out;
}

}  // namespace lobium
