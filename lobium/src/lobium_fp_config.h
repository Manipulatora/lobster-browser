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
// patches under `lobium/patches/`. The reader has compiled in the existing dev build; newly added
// capability-gated consumers still require a fresh Lobium rebuild and their dedicated probes.

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
  std::string ua_model;
  bool ua_mobile = false;
  // Sec-CH-UA-Form-Factors, exactly one of "Desktop" | "Mobile" | "Tablet" (empty = derive from
  // ua_mobile). A tablet needs this stated: it reports uaMobile=false because real tablet Chrome
  // omits the "Mobile" UA token, so the mobile-bit derivation would label it "Desktop" next to a
  // tablet Sec-CH-UA-Model and an Android platform.
  std::string ua_form_factor;
  // Sec-CH-UA brand list (name, version).
  std::vector<std::pair<std::string, std::string>> ua_brands;
};

struct ScreenConfig {
  int width = 0;
  int height = 0;
  int avail_width = 0;
  int avail_height = 0;
  int avail_left = 0;
  int avail_top = 0;
  int color_depth = 24;
  double device_pixel_ratio = 1;
};

// Numeric WebGL limits (ENG-8). Overridden in getParameter so MAX_* etc. agree with the spoofed
// renderer string instead of leaking the real (or software) backend's caps. `present` gates the override.
struct WebGlCaps {
  bool present = false;
  int max_texture_size = 0;
  int max_cube_map_texture_size = 0;
  int max_renderbuffer_size = 0;
  int max_viewport_dims[2] = {0, 0};
  int max_vertex_attribs = 0;
  int max_vertex_uniform_vectors = 0;
  int max_fragment_uniform_vectors = 0;
  int max_varying_vectors = 0;
  int max_texture_image_units = 0;
  int max_vertex_texture_image_units = 0;
  int max_combined_texture_image_units = 0;
  float aliased_line_width_range[2] = {0, 0};
  float aliased_point_size_range[2] = {0, 0};
};

// One getShaderPrecisionFormat() result (rangeMin/rangeMax/precision).
struct ShaderPrecisionFormat {
  int range_min = 0;
  int range_max = 0;
  int precision = 0;
};

// getShaderPrecisionFormat() buckets for one shader stage (vertex or fragment).
struct ShaderPrecisionStage {
  ShaderPrecisionFormat low_float;
  ShaderPrecisionFormat medium_float;
  ShaderPrecisionFormat high_float;
  ShaderPrecisionFormat low_int;
  ShaderPrecisionFormat medium_int;
  ShaderPrecisionFormat high_int;
};

// Captured shader precision for both shader stages. `present` gates the getShaderPrecisionFormat hook.
struct ShaderPrecisionProfile {
  bool present = false;
  ShaderPrecisionStage vertex;
  ShaderPrecisionStage fragment;
};

struct WebGlConfig {
  std::string vendor;
  std::string renderer;
  std::string unmasked_vendor;
  std::string unmasked_renderer;
  WebGlCaps caps;
  // Deep surfaces that must agree with the spoofed renderer or a detector cross-checks them against the
  // real host GPU (HC-4). Empty/absent = leave the host value (fall back), so a config that omits them
  // never blanks a real surface. `version`/`shading_language_version` back getParameter(VERSION|
  // SHADING_LANGUAGE_VERSION); `extensions` backs getSupportedExtensions()/getExtension(); precision
  // backs getShaderPrecisionFormat().
  std::string version;
  std::string shading_language_version;
  // getSupportedExtensions() for a WebGL1 context, in Chrome's registration order.
  std::vector<std::string> extensions;
  // ...and for a WebGL2 context, which is a genuinely DIFFERENT list rather than a superset: WebGL2
  // folds instanced arrays, VAOs, depth texture, draw buffers and the float texture extensions into
  // core, so they must not be advertised, while EXT_color_buffer_float and friends only exist there.
  // Two lists are required because the hook matches configured names against the context's own
  // registered extensions: feeding the WebGL1 list to a WebGL2 context silently intersects down to
  // the handful of names common to both, which is shorter than any real browser reports.
  std::vector<std::string> extensions2;
  ShaderPrecisionProfile shader_precision;
};

// navigator.gpu adapter identity. `present` gates the hook.
//
// WebGPU is a second, independent GPU identity surface next to WebGL, and leaving it unhooked is
// worse than either alone: adapter.info would name the REAL device while WebGL names the persona's,
// which is a contradiction a page reads in two calls. By default Chrome exposes only vendor,
// architecture, subgroup sizes and isFallbackAdapter here (the reduced-entropy set); device,
// description and driver appear when WebGPU developer features are enabled, so they are carried too.
struct WebGpuConfig {
  bool present = false;
  std::string vendor;         // e.g. "nvidia" - lowercase token, matching Dawn's own convention
  std::string architecture;   // e.g. "ada-lovelace"
  std::string device;         // hex device id string, e.g. "0x2782"
  std::string description;    // human-readable device name
  std::string driver;         // driver description string
  // "discrete" | "integrated" | "cpu". Drives adapter.isFallbackAdapter, which is true only for a
  // CPU adapter. A software backend (SwiftShader, the only option on a GPU-less host) reports CPU,
  // so a persona claiming real silicon must say so or the fallback bit contradicts its own renderer.
  std::string adapter_type;
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
// `client_rects` gates Element getClientRects / getBoundingClientRect noise (0 = off).
struct FarblingSeeds {
  uint32_t canvas = 0;
  uint32_t webgl = 0;
  uint32_t audio = 0;
  uint32_t client_rects = 0;
  // Dedicated always-on identity seed for stable media-device IDs. It must not depend on canvas/WebGL
  // noise toggles: those can both be disabled, while IDs still need to remain distinct per profile.
  uint32_t media_devices = 0;
};

// Mirrors MediaDeviceProfile in @lobster/shared-types. `present` gates the enumerateDevices hook.
struct MediaDevicesConfig {
  bool present = false;
  int cameras = 0;
  int microphones = 0;
  int speakers = 0;
  bool stable_device_ids = true;
};

struct NetConfig {
  // default_public_interface_only | disable_non_proxied_udp | proxy_only | disabled.
  std::string webrtc_policy;
};

// The parsed `lobium-fp.json`. `Current()` returns the process-wide instance parsed at startup.
struct LobiumFpConfig {
  int version = 0;
  // CPU architecture the persona presents ("x86_64" | "arm64"); drives Sec-CH-UA-Arch/bitness so an
  // Apple-Silicon Mac persona reports arm, not the host arch. Empty = fall back to host.
  std::string arch;
  NavigatorConfig navigator;
  ScreenConfig screen;
  WebGlConfig webgl;
  WebGpuConfig webgpu;
  LocaleConfig locale;
  std::vector<std::string> fonts;
  // CSS-only claimed-family -> verified physical pack family substitutions. These preserve the
  // persona's requested name at the service boundary while asking DirectWrite for a real pack face;
  // they do not fabricate PostScript names or Local Font Access entries.
  std::vector<std::pair<std::string, std::string>> font_aliases;
  // Ordered physical pack families eligible for character/default fallback. Populated in BOTH
  // processes: the browser drives DirectWrite character/default fallback with it, and the renderer
  // uses it as the inventory that FontFamilyIsPackPhysical() tests against so Blink's Windows font
  // code accepts a browser-substituted pack typeface (see windows-font-renderer-fallback.patch)
  // instead of re-rejecting it by family name. Unlike `fonts`/`fontPackDir`, it is NOT stripped from
  // the renderer config copy.
  std::vector<std::string> font_fallback_families;
  // Directory holding the profile's verified persona-specific font stage, as an absolute native
  // path. Windows sideloads every face in that stage into a pack-only DirectWrite collection. Empty
  // means no pack was provisioned and only explicitly allowed host faces are available.
  //
  // Linux reaches the same end through FONTCONFIG_FILE, written per profile by the launcher, so this
  // field is consumed only by the Windows DWrite path.
  std::string font_pack_dir;
  FarblingSeeds seeds;
  MediaDevicesConfig media_devices;
  NetConfig net;

  // Parse the config file at `path`. Returns std::nullopt on a missing/invalid/incompatible file
  // (the caller then falls back to default Chromium behavior rather than crashing).
  static std::optional<LobiumFpConfig> Load(const base::FilePath& path);

  // Parse the process's config once from the `--lobium-fp-config` switch; cached for the lifetime of
  // the process. Returns nullptr when the switch is absent (Lobium behaves like stock Chromium).
  static const LobiumFpConfig* Current();
};

// Return `config_json` with the keys only the BROWSER process uses removed.
//
// The browser reads lobium-fp.json from disk, but a sandboxed renderer cannot, so the browser
// forwards the contents base64-encoded on the renderer command line - where Windows caps the ENTIRE
// CreateProcess line at 32767 characters. Exceeding the guard makes the browser skip the switch
// altogether, and a renderer with no config reports the HOST's platform, hardware concurrency and
// screen: total spoofing failure, triggered by a field the renderer never even reads.
//
// `fonts` is exactly that field. A Windows persona lists several hundred families and macOS
// historically listed thousands, while every font hook - DirectWrite family lookup, Local Font
// Access, the pack sideload - runs browser-side. Same for `fontPackDir`. Dropping them keeps the
// renderer payload small enough that the guard never trips, so the font list can be complete on the
// side that actually consumes it. `fontAliases` (the large claimed->physical map) is browser-only
// for the same reason. `fontFallbackFamilies` is the exception: it is NOT stripped, because the
// renderer's alias-aware font-name check needs the physical pack inventory to test against, and at
// ~46 names it is small enough to ride the renderer command line.
//
// Returns `config_json` unchanged if it cannot be parsed: an unparseable config is already handled
// (and logged) downstream, and silently substituting an empty document here would turn a loud
// failure into a quiet host leak.
std::string StripBrowserOnlyKeys(const std::string& config_json);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_FP_CONFIG_H_
