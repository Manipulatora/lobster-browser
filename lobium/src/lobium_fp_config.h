// Copyright 2026 The Lobster Browser Authors.
//
// Lobium fingerprint config channel — NATIVE READER (build-machine artifact).
//
// This is the C++ counterpart to `packages/engine-runner/src/lobium-config.ts`: the sidecar writes a
// per-profile `lobium-fp.json`, launches Lobium with `--lobium-fp-config=<path>`, and this module
// parses it once at startup. Each fingerprint subsystem (navigator/UA-CH, screen, WebGL, canvas &
// audio farbling, timezone/locale, WebRTC) reads from the returned `LobiumFpConfig` instead of the
// host device — so every deep surface is spoofed *natively*, with no JS tell.
//
// It builds into `//components/lobium_fp` (an ADDED directory, so it survives upstream rebases with
// zero patch rejects). The small diffs that call into it from existing Chromium files are the quilt
// patches under `lobium/patches/`. NOTE: this file has NOT been compiled in the dev sandbox — it is
// authored against the pinned Chromium ref and is finalized/compiled on the build machine (T-010/T-011).

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_FP_CONFIG_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_FP_CONFIG_H_

#include <cstdint>
#include <optional>
#include <string>
#include <utility>
#include <vector>

#include "base/files/file_path.h"

namespace lobium {

// Mirrors `NavigatorFingerprint` in @lobster/shared-types.
struct NavigatorConfig {
  std::string user_agent;
  std::string platform;
  std::vector<std::string> languages;
  int hardware_concurrency = 0;
  // 0 = unconfigured (fall back to the host value), mirroring hardware_concurrency's sentinel — so a
  // future deviceMemory hook only overrides when the config actually specifies it.
  double device_memory = 0;
  // std::optional because 0 is a LEGITIMATE value (desktop personas report maxTouchPoints=0) and must
  // be distinguishable from "unconfigured" — the parser sets it only when the JSON key is present.
  std::optional<int> max_touch_points;
  std::string ua_platform;
  std::string ua_platform_version;
  std::string ua_full_version;
  bool ua_mobile = false;
  // Sec-CH-UA brand list (name, version).
  std::vector<std::pair<std::string, std::string>> ua_brands;
};

struct ScreenConfig {
  int width = 0;
  int height = 0;
  int avail_width = 0;
  int avail_height = 0;
  int color_depth = 24;
  double device_pixel_ratio = 1;
};

struct WebGlConfig {
  std::string vendor;
  std::string renderer;
  std::string unmasked_vendor;
  std::string unmasked_renderer;
};

struct LocaleConfig {
  std::string timezone;   // IANA, e.g. "America/New_York"
  std::string locale;     // BCP-47, e.g. "en-US"
  std::string accept_language;
  bool has_geolocation = false;
  double latitude = 0;
  double longitude = 0;
  double accuracy = 100;
};

// Per-profile farbling seeds (uint32) — stable per profile, so canvas/WebGL/audio hashes are steady.
struct FarblingSeeds {
  uint32_t canvas = 0;
  uint32_t webgl = 0;
  uint32_t audio = 0;
};

struct NetConfig {
  // "disable_non_proxied_udp" (proxied) or "default_public_interface_only".
  std::string webrtc_policy;
};

// The parsed `lobium-fp.json`. `Current()` returns the process-wide instance parsed at startup.
struct LobiumFpConfig {
  int version = 0;
  NavigatorConfig navigator;
  ScreenConfig screen;
  WebGlConfig webgl;
  LocaleConfig locale;
  std::vector<std::string> fonts;
  FarblingSeeds seeds;
  NetConfig net;

  // Parse the config file at `path`. Returns std::nullopt on a missing/invalid/incompatible file
  // (the caller then falls back to default Chromium behavior rather than crashing).
  static std::optional<LobiumFpConfig> Load(const base::FilePath& path);

  // Parse the process's config once from the `--lobium-fp-config` switch; cached for the lifetime of
  // the process. Returns nullptr when the switch is absent (Lobium behaves like stock Chromium).
  static const LobiumFpConfig* Current();
};

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_FP_CONFIG_H_
