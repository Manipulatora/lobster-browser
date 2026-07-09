// Copyright 2026 The Lobster Browser Authors.
//
// Lobium fingerprint config channel — native reader implementation (build-machine artifact).
// See lobium_fp_config.h. NOT compiled in the dev sandbox; finalized on the build machine.

#include "components/lobium_fp/lobium_fp_config.h"

#include <string_view>
#include <utility>

#include "base/base64.h"
#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/values.h"

namespace lobium {

namespace {

// The command-line switch the sidecar sets (see lobium-config.ts `lobiumConfigArg`). It names a file
// the BROWSER process reads; the renderer is sandboxed and cannot read it.
constexpr char kConfigSwitch[] = "lobium-fp-config";

// The switch the BROWSER process appends for renderers: the base64 of the config file's contents
// (see render_process_host_impl.cc, mirroring Chromium's own GaiaConfig file→switch serialization).
// This is how the config reaches the sandboxed renderer, which cannot open the file itself.
constexpr char kDataSwitch[] = "lobium-fp-data";

// The config-format version this build understands. Bumped with a shared-types migration.
constexpr int kSupportedVersion = 1;

std::vector<std::string> ReadStringList(const base::ListValue* list) {
  std::vector<std::string> out;
  if (!list) {
    return out;
  }
  for (const base::Value& v : *list) {
    if (v.is_string()) {
      out.push_back(v.GetString());
    }
  }
  return out;
}

void ReadNavigator(const base::DictValue& dict, NavigatorConfig& nav) {
  if (const std::string* s = dict.FindString("userAgent")) nav.user_agent = *s;
  if (const std::string* s = dict.FindString("platform")) nav.platform = *s;
  nav.languages = ReadStringList(dict.FindList("languages"));
  nav.hardware_concurrency = dict.FindInt("hardwareConcurrency").value_or(0);
  nav.device_memory = dict.FindDouble("deviceMemory").value_or(0);
  // Assign the optional directly: present JSON key → value; absent → nullopt (leave host value).
  nav.max_touch_points = dict.FindInt("maxTouchPoints");
  if (const std::string* s = dict.FindString("uaPlatform")) nav.ua_platform = *s;
  if (const std::string* s = dict.FindString("uaPlatformVersion"))
    nav.ua_platform_version = *s;
  if (const std::string* s = dict.FindString("uaFullVersion")) nav.ua_full_version = *s;
  nav.ua_mobile = dict.FindBool("uaMobile").value_or(false);
  if (const base::ListValue* brands = dict.FindList("uaBrands")) {
    for (const base::Value& b : *brands) {
      const base::DictValue* bd = b.GetIfDict();
      if (!bd) continue;
      const std::string* brand = bd->FindString("brand");
      const std::string* version = bd->FindString("version");
      if (brand && version) {
        nav.ua_brands.emplace_back(*brand, *version);
      }
    }
  }
}

void ReadScreen(const base::DictValue& dict, ScreenConfig& s) {
  s.width = dict.FindInt("width").value_or(0);
  s.height = dict.FindInt("height").value_or(0);
  s.avail_width = dict.FindInt("availWidth").value_or(s.width);
  s.avail_height = dict.FindInt("availHeight").value_or(s.height);
  s.avail_left = dict.FindInt("availLeft").value_or(0);
  s.avail_top = dict.FindInt("availTop").value_or(0);
  s.color_depth = dict.FindInt("colorDepth").value_or(24);
  s.device_pixel_ratio = dict.FindDouble("devicePixelRatio").value_or(1);
}

ShaderPrecisionFormat ReadPrecisionFormat(const base::DictValue* dict) {
  ShaderPrecisionFormat f;
  if (!dict) {
    return f;
  }
  f.range_min = dict->FindInt("rangeMin").value_or(0);
  f.range_max = dict->FindInt("rangeMax").value_or(0);
  f.precision = dict->FindInt("precision").value_or(0);
  return f;
}

void ReadPrecisionStage(const base::DictValue* dict, ShaderPrecisionStage& stage) {
  if (!dict) {
    return;
  }
  stage.low_float = ReadPrecisionFormat(dict->FindDict("lowFloat"));
  stage.medium_float = ReadPrecisionFormat(dict->FindDict("mediumFloat"));
  stage.high_float = ReadPrecisionFormat(dict->FindDict("highFloat"));
  stage.low_int = ReadPrecisionFormat(dict->FindDict("lowInt"));
  stage.medium_int = ReadPrecisionFormat(dict->FindDict("mediumInt"));
  stage.high_int = ReadPrecisionFormat(dict->FindDict("highInt"));
}

void ReadWebGl(const base::DictValue& dict, WebGlConfig& w) {
  if (const std::string* s = dict.FindString("vendor")) w.vendor = *s;
  if (const std::string* s = dict.FindString("renderer")) w.renderer = *s;
  if (const std::string* s = dict.FindString("unmaskedVendor")) w.unmasked_vendor = *s;
  if (const std::string* s = dict.FindString("unmaskedRenderer")) w.unmasked_renderer = *s;
  // Deep surfaces (HC-4). Present JSON keys override; absent keys leave the host value.
  if (const std::string* s = dict.FindString("version")) w.version = *s;
  if (const std::string* s = dict.FindString("shadingLanguageVersion"))
    w.shading_language_version = *s;
  w.extensions = ReadStringList(dict.FindList("extensions"));
  if (const base::DictValue* prec = dict.FindDict("shaderPrecision")) {
    w.shader_precision.present = true;
    ReadPrecisionStage(prec->FindDict("vertex"), w.shader_precision.vertex);
    ReadPrecisionStage(prec->FindDict("fragment"), w.shader_precision.fragment);
  }
  if (const base::DictValue* c = dict.FindDict("caps")) {
    WebGlCaps& caps = w.caps;
    caps.present = true;
    caps.max_texture_size = c->FindInt("maxTextureSize").value_or(0);
    caps.max_cube_map_texture_size = c->FindInt("maxCubeMapTextureSize").value_or(0);
    caps.max_renderbuffer_size = c->FindInt("maxRenderbufferSize").value_or(0);
    caps.max_vertex_attribs = c->FindInt("maxVertexAttribs").value_or(0);
    caps.max_vertex_uniform_vectors = c->FindInt("maxVertexUniformVectors").value_or(0);
    caps.max_fragment_uniform_vectors = c->FindInt("maxFragmentUniformVectors").value_or(0);
    caps.max_varying_vectors = c->FindInt("maxVaryingVectors").value_or(0);
    caps.max_texture_image_units = c->FindInt("maxTextureImageUnits").value_or(0);
    caps.max_vertex_texture_image_units = c->FindInt("maxVertexTextureImageUnits").value_or(0);
    caps.max_combined_texture_image_units = c->FindInt("maxCombinedTextureImageUnits").value_or(0);
    if (const base::ListValue* vd = c->FindList("maxViewportDims"); vd && vd->size() == 2) {
      caps.max_viewport_dims[0] = (*vd)[0].GetIfInt().value_or(0);
      caps.max_viewport_dims[1] = (*vd)[1].GetIfInt().value_or(0);
    }
    if (const base::ListValue* lw = c->FindList("aliasedLineWidthRange"); lw && lw->size() == 2) {
      caps.aliased_line_width_range[0] = static_cast<float>((*lw)[0].GetIfDouble().value_or(0));
      caps.aliased_line_width_range[1] = static_cast<float>((*lw)[1].GetIfDouble().value_or(0));
    }
    if (const base::ListValue* ps = c->FindList("aliasedPointSizeRange"); ps && ps->size() == 2) {
      caps.aliased_point_size_range[0] = static_cast<float>((*ps)[0].GetIfDouble().value_or(0));
      caps.aliased_point_size_range[1] = static_cast<float>((*ps)[1].GetIfDouble().value_or(0));
    }
  }
}

void ReadLocale(const base::DictValue& dict, LocaleConfig& l) {
  if (const std::string* s = dict.FindString("timezone")) l.timezone = *s;
  if (const std::string* s = dict.FindString("locale")) l.locale = *s;
  if (const std::string* s = dict.FindString("acceptLanguage")) l.accept_language = *s;
  if (const base::DictValue* geo = dict.FindDict("geolocation")) {
    l.has_geolocation = true;
    l.latitude = geo->FindDouble("latitude").value_or(0);
    l.longitude = geo->FindDouble("longitude").value_or(0);
    l.accuracy = geo->FindDouble("accuracy").value_or(100);
  }
}

// Parse the decoded `lobium-fp.json` text into a config. Returns nullopt on invalid JSON or an
// incompatible schema version (the caller then falls back to stock Chromium rather than misapply).
std::optional<LobiumFpConfig> ParseConfig(std::string_view contents) {
  std::optional<base::DictValue> parsed =
      base::JSONReader::ReadDict(contents, base::JSON_PARSE_RFC);
  if (!parsed) {
    return std::nullopt;
  }
  const base::DictValue& root = *parsed;

  LobiumFpConfig cfg;
  cfg.version = root.FindInt("version").value_or(0);
  // Accept version >= the minimum and ignore unknown fields (forward-compatible), rather than exact
  // match: an exact `== 1` meant a sidecar shipping a newer schema would silently disable ALL spoofing
  // and leak the host fingerprint. A too-OLD config is still rejected.
  if (cfg.version < kSupportedVersion) {
    return std::nullopt;  // incompatible (older than we understand) — fall back rather than misapply.
  }
  if (const std::string* a = root.FindString("arch")) cfg.arch = *a;
  if (const base::DictValue* d = root.FindDict("navigator")) ReadNavigator(*d, cfg.navigator);
  if (const base::DictValue* d = root.FindDict("screen")) ReadScreen(*d, cfg.screen);
  if (const base::DictValue* d = root.FindDict("webgl")) ReadWebGl(*d, cfg.webgl);
  if (const base::DictValue* d = root.FindDict("locale")) ReadLocale(*d, cfg.locale);
  cfg.fonts = ReadStringList(root.FindList("fonts"));
  if (const base::DictValue* seeds = root.FindDict("seeds")) {
    cfg.seeds.canvas = static_cast<uint32_t>(seeds->FindDouble("canvas").value_or(0));
    cfg.seeds.webgl = static_cast<uint32_t>(seeds->FindDouble("webgl").value_or(0));
    cfg.seeds.audio = static_cast<uint32_t>(seeds->FindDouble("audio").value_or(0));
  }
  if (const base::DictValue* net = root.FindDict("net")) {
    if (const std::string* p = net->FindString("webrtcPolicy")) cfg.net.webrtc_policy = *p;
  }
  return cfg;
}

}  // namespace

// static
std::optional<LobiumFpConfig> LobiumFpConfig::Load(const base::FilePath& path) {
  std::string contents;
  if (!base::ReadFileToString(path, &contents)) {
    return std::nullopt;
  }
  return ParseConfig(contents);
}

// static
const LobiumFpConfig* LobiumFpConfig::Current() {
  static const base::NoDestructor<std::optional<LobiumFpConfig>> instance(
      []() -> std::optional<LobiumFpConfig> {
        const base::CommandLine* cmd = base::CommandLine::ForCurrentProcess();
        // Renderer path (sandboxed, cannot read files): the browser process already read the file and
        // forwarded its base64 contents in --lobium-fp-data. Prefer it.
        if (cmd->HasSwitch(kDataSwitch)) {
          std::string decoded;
          if (!base::Base64Decode(cmd->GetSwitchValueASCII(kDataSwitch), &decoded)) {
            // Fail-open (host values) is unavoidable here, but must NOT be silent: this is the
            // "spoof intended but dropped" case, which otherwise leaks the real device fingerprint.
            LOG(ERROR) << "Lobium: --" << kDataSwitch
                       << " is not valid base64; this renderer will report HOST fingerprint values.";
            return std::nullopt;
          }
          std::optional<LobiumFpConfig> cfg = ParseConfig(decoded);
          if (!cfg) {
            LOG(ERROR) << "Lobium: fingerprint config failed to parse (bad JSON or unsupported "
                          "version); this renderer will report HOST fingerprint values.";
          }
          return cfg;
        }
        // Browser / unsandboxed path: read the --lobium-fp-config file directly.
        if (cmd->HasSwitch(kConfigSwitch)) {
          std::optional<LobiumFpConfig> cfg =
              LobiumFpConfig::Load(cmd->GetSwitchValuePath(kConfigSwitch));
          if (!cfg) {
            LOG(ERROR) << "Lobium: --" << kConfigSwitch
                       << " is present but unreadable/invalid; reporting HOST fingerprint values.";
          }
          return cfg;
        }
        return std::nullopt;
      }());
  return instance->has_value() ? &instance->value() : nullptr;
}

}  // namespace lobium
