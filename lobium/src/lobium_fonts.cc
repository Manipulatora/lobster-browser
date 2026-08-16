// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_fonts.h.

#include "components/lobium_fp/lobium_fonts.h"

#include <algorithm>

#include "base/files/file_enumerator.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "components/lobium_fp/lobium_fp_config.h"

namespace lobium {

namespace {

// Families that resolve no matter what the persona claims.
//
// Two groups, both load-bearing:
//
// 1. Chromium's own `kLastResortFontNames` from dwrite_font_proxy_impl_win.cc, which
//    getLastResortFallbackFont walks and CRASHES the renderer if none can be loaded. A persona list
//    that happened to omit all of them would take the browser down, so the policy must not be able
//    to express that.
//
// 2. The families Blink resolves the CSS generic keywords to on Windows. If `monospace` cannot
//    resolve Consolas, code and <pre> render in a proportional face: visibly broken, and a tell in
//    its own right since no real Windows Chrome does that. The default persona catalog contains all
//    of these, but a user-supplied font list (persona mode `manual`) need not, and a browser whose
//    monospace is broken by a settings choice is a worse outcome than one extra measurable family.
//
// The cost is small either way: every one is a stock Windows family present on any real Windows
// machine, so allowing them adds no entropy a Windows persona would not already have.
constexpr std::string_view kAlwaysAllowed[] = {
    // Chromium's last-resort chain.
    "sans", "arial", "ms ui gothic", "microsoft sans serif",
    "segoe ui", "calibri", "times new roman", "courier new",
    // Blink's generic-family defaults on Windows.
    "consolas", "comic sans ms", "impact", "cambria math",
};

// Extensions DirectWrite can load. Anything else in the pack directory (licences, a manifest, the
// SHA-256 sidecar) is skipped rather than handed to CreateFontFileReference, which would fail the
// whole collection build and leave the profile with NO sideloaded fonts at all.
bool IsFontFile(const base::FilePath& path) {
  // MatchesFinalExtension is case-insensitive and takes the platform's char type, unlike
  // base::ToLowerASCII, which has no std::wstring overload.
  return path.MatchesFinalExtension(FILE_PATH_LITERAL(".ttf")) ||
         path.MatchesFinalExtension(FILE_PATH_LITERAL(".ttc")) ||
         path.MatchesFinalExtension(FILE_PATH_LITERAL(".otf")) ||
         path.MatchesFinalExtension(FILE_PATH_LITERAL(".otc"));
}

}  // namespace

bool FontFamilyAllowed(std::string_view family) {
  const LobiumFpConfig* cfg = LobiumFpConfig::Current();
  // Fail open. No config, or a persona with no font list, behaves exactly like stock Chromium.
  if (!cfg || cfg->fonts.empty()) {
    return true;
  }

  const std::string needle = base::ToLowerASCII(family);
  for (const std::string_view allowed : kAlwaysAllowed) {
    if (needle == allowed) {
      return true;
    }
  }
  for (const std::string& configured : cfg->fonts) {
    if (base::EqualsCaseInsensitiveASCII(configured, needle)) {
      return true;
    }
  }
  return false;
}

bool FontFamilyAllowed(std::u16string_view family) {
  // Cheap pre-check before the UTF-16 -> UTF-8 conversion: with no policy in force every name is
  // allowed, and this is on the path of every font lookup the renderer makes.
  const LobiumFpConfig* cfg = LobiumFpConfig::Current();
  if (!cfg || cfg->fonts.empty()) {
    return true;
  }
  // Named local, not a temporary passed straight into a string_view parameter: the lifetime would
  // still be fine here, but the pattern is one refactor away from a dangling view.
  const std::string utf8 = base::UTF16ToUTF8(family);
  return FontFamilyAllowed(std::string_view(utf8));
}

bool FontUniqueNameAllowed(std::string_view unique_name) {
  const LobiumFpConfig* cfg = LobiumFpConfig::Current();
  if (!cfg || cfg->fonts.empty()) {
    return true;
  }

  const auto squash = [](std::string_view s) {
    std::string out;
    out.reserve(s.size());
    for (const char c : s) {
      if (c != ' ' && c != '-' && c != '_') {
        out.push_back(base::ToLowerASCII(c));
      }
    }
    return out;
  };

  const std::string needle = squash(unique_name);
  for (const std::string_view allowed : kAlwaysAllowed) {
    if (needle.starts_with(squash(allowed))) {
      return true;
    }
  }
  for (const std::string& configured : cfg->fonts) {
    const std::string prefix = squash(configured);
    // Skip empty entries; an empty prefix matches everything and would disable the filter.
    if (!prefix.empty() && needle.starts_with(prefix)) {
      return true;
    }
  }
  return false;
}

std::vector<base::FilePath> FontPackFaces(const base::FilePath& dir) {
  std::vector<base::FilePath> faces;
  if (dir.empty()) {
    return faces;
  }
  base::FileEnumerator it(dir, /*recursive=*/false, base::FileEnumerator::FILES);
  for (base::FilePath path = it.Next(); !path.empty(); path = it.Next()) {
    if (IsFontFile(path)) {
      faces.push_back(path);
    }
  }
  std::sort(faces.begin(), faces.end());
  return faces;
}

}  // namespace lobium
