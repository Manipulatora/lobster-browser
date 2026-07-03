// Copyright 2026 The Lobster Browser Authors.
//
// Lobium fingerprint config channel — native reader implementation (build-machine artifact).
// See lobium_fp_config.h. NOT compiled in the dev sandbox; finalized on the build machine.

#include "third_party/lobium-fp/lobium_fp_config.h"

#include <string_view>
#include <utility>

#include "base/command_line.h"
#include "base/files/file_util.h"
#include "base/json/json_reader.h"
#include "base/no_destructor.h"
#include "base/values.h"

namespace lobium {

namespace {

// The command-line switch the sidecar sets (see lobium-config.ts `lobiumConfigArg`).
constexpr char kConfigSwitch[] = "lobium-fp-config";

// The config-format version this build understands. Bumped with a shared-types migration.
constexpr int kSupportedVersion = 1;

std::vector<std::string> ReadStringList(const base::Value::List* list) {
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

void ReadNavigator(const base::Value::Dict& dict, NavigatorConfig& nav) {
  if (const std::string* s = dict.FindString("userAgent")) nav.user_agent = *s;
  if (const std::string* s = dict.FindString("platform")) nav.platform = *s;
  nav.languages = ReadStringList(dict.FindList("languages"));
  nav.hardware_concurrency = dict.FindInt("hardwareConcurrency").value_or(0);
  nav.device_memory = dict.FindDouble("deviceMemory").value_or(8);
  nav.max_touch_points = dict.FindInt("maxTouchPoints").value_or(0);
  if (const std::string* s = dict.FindString("uaPlatform")) nav.ua_platform = *s;
  if (const std::string* s = dict.FindString("uaPlatformVersion"))
    nav.ua_platform_version = *s;
  if (const std::string* s = dict.FindString("uaFullVersion")) nav.ua_full_version = *s;
  nav.ua_mobile = dict.FindBool("uaMobile").value_or(false);
  if (const base::Value::List* brands = dict.FindList("uaBrands")) {
    for (const base::Value& b : *brands) {
      const base::Value::Dict* bd = b.GetIfDict();
      if (!bd) continue;
      const std::string* brand = bd->FindString("brand");
      const std::string* version = bd->FindString("version");
      if (brand && version) {
        nav.ua_brands.emplace_back(*brand, *version);
      }
    }
  }
}

void ReadScreen(const base::Value::Dict& dict, ScreenConfig& s) {
  s.width = dict.FindInt("width").value_or(0);
  s.height = dict.FindInt("height").value_or(0);
  s.avail_width = dict.FindInt("availWidth").value_or(s.width);
  s.avail_height = dict.FindInt("availHeight").value_or(s.height);
  s.color_depth = dict.FindInt("colorDepth").value_or(24);
  s.device_pixel_ratio = dict.FindDouble("devicePixelRatio").value_or(1);
}

void ReadWebGl(const base::Value::Dict& dict, WebGlConfig& w) {
  if (const std::string* s = dict.FindString("vendor")) w.vendor = *s;
  if (const std::string* s = dict.FindString("renderer")) w.renderer = *s;
  if (const std::string* s = dict.FindString("unmaskedVendor")) w.unmasked_vendor = *s;
  if (const std::string* s = dict.FindString("unmaskedRenderer")) w.unmasked_renderer = *s;
}

void ReadLocale(const base::Value::Dict& dict, LocaleConfig& l) {
  if (const std::string* s = dict.FindString("timezone")) l.timezone = *s;
  if (const std::string* s = dict.FindString("locale")) l.locale = *s;
  if (const std::string* s = dict.FindString("acceptLanguage")) l.accept_language = *s;
  if (const base::Value::Dict* geo = dict.FindDict("geolocation")) {
    l.has_geolocation = true;
    l.latitude = geo->FindDouble("latitude").value_or(0);
    l.longitude = geo->FindDouble("longitude").value_or(0);
    l.accuracy = geo->FindDouble("accuracy").value_or(100);
  }
}

}  // namespace

// static
std::optional<LobiumFpConfig> LobiumFpConfig::Load(const base::FilePath& path) {
  std::string contents;
  if (!base::ReadFileToString(path, &contents)) {
    return std::nullopt;
  }
  std::optional<base::Value> parsed = base::JSONReader::Read(contents);
  if (!parsed || !parsed->is_dict()) {
    return std::nullopt;
  }
  const base::Value::Dict& root = parsed->GetDict();

  LobiumFpConfig cfg;
  cfg.version = root.FindInt("version").value_or(0);
  if (cfg.version != kSupportedVersion) {
    return std::nullopt;  // incompatible — fall back to stock behavior rather than misapply.
  }
  if (const base::Value::Dict* d = root.FindDict("navigator")) ReadNavigator(*d, cfg.navigator);
  if (const base::Value::Dict* d = root.FindDict("screen")) ReadScreen(*d, cfg.screen);
  if (const base::Value::Dict* d = root.FindDict("webgl")) ReadWebGl(*d, cfg.webgl);
  if (const base::Value::Dict* d = root.FindDict("locale")) ReadLocale(*d, cfg.locale);
  cfg.fonts = ReadStringList(root.FindList("fonts"));
  if (const base::Value::Dict* seeds = root.FindDict("seeds")) {
    cfg.seeds.canvas =
        static_cast<uint32_t>(seeds->FindDouble("canvas").value_or(0));
    cfg.seeds.webgl = static_cast<uint32_t>(seeds->FindDouble("webgl").value_or(0));
    cfg.seeds.audio = static_cast<uint32_t>(seeds->FindDouble("audio").value_or(0));
  }
  if (const base::Value::Dict* net = root.FindDict("net")) {
    if (const std::string* p = net->FindString("webrtcPolicy")) cfg.net.webrtc_policy = *p;
  }
  return cfg;
}

// static
const LobiumFpConfig* LobiumFpConfig::Current() {
  static const base::NoDestructor<std::optional<LobiumFpConfig>> instance([]() {
    const base::CommandLine* cmd = base::CommandLine::ForCurrentProcess();
    if (!cmd->HasSwitch(kConfigSwitch)) {
      return std::optional<LobiumFpConfig>();
    }
    return LobiumFpConfig::Load(cmd->GetSwitchValuePath(kConfigSwitch));
  }());
  return instance->has_value() ? &instance->value() : nullptr;
}

}  // namespace lobium
