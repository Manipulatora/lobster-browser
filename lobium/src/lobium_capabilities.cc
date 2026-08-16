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
    // Touch points, pointer/hover media features and the rest of the mobile-shaped surfaces. Only
    // required for an Android persona, but always compiled.
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
  // The COMPLETE font-isolation set: the FontDataService family/local-font/enumeration filters, the
  // DirectWrite proxy filters, Local Font Access, and the font-pack sideload.
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
