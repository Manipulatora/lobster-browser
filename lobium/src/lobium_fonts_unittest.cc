// Copyright 2026 The Lobster Browser Authors.

#include "components/lobium_fp/lobium_fonts.h"

#include <algorithm>
#include <vector>

#include "base/files/file_path.h"
#include "base/files/file_util.h"
#include "base/files/scoped_temp_dir.h"
#include "components/lobium_fp/lobium_fp_config.h"
#include "testing/gtest/include/gtest/gtest.h"

namespace lobium {
namespace {

TEST(LobiumFontsTest, EnumeratesOnlyRecursiveProvisionerFilesTree) {
  base::ScopedTempDir temp;
  ASSERT_TRUE(temp.CreateUniqueTempDir());
  const base::FilePath pack = temp.GetPath().AppendASCII("pack");
  const base::FilePath files = pack.AppendASCII("files");
  const base::FilePath nested = files.AppendASCII("nested");
  ASSERT_TRUE(base::CreateDirectory(nested));

  const base::FilePath root_font = pack.AppendASCII("not-in-files.ttf");
  const base::FilePath first = files.AppendASCII("first.TTF");
  const base::FilePath second = nested.AppendASCII("second.otf");
  ASSERT_TRUE(base::WriteFile(root_font, "root"));
  ASSERT_TRUE(base::WriteFile(first, "first"));
  ASSERT_TRUE(base::WriteFile(second, "second"));
  ASSERT_TRUE(base::WriteFile(files.AppendASCII("license.txt"), "license"));

  std::vector<base::FilePath> expected = {first, second};
  std::sort(expected.begin(), expected.end());
  EXPECT_EQ(FontPackFaces(pack), expected);
}

TEST(LobiumFontsTest, MissingProvisionerFilesTreeRejectsPack) {
  base::ScopedTempDir temp;
  ASSERT_TRUE(temp.CreateUniqueTempDir());
  const base::FilePath pack = temp.GetPath().AppendASCII("pack");
  ASSERT_TRUE(base::CreateDirectory(pack));
  ASSERT_TRUE(base::WriteFile(pack.AppendASCII("font.ttf"), "font"));

  EXPECT_TRUE(FontPackFaces(pack).empty());
}

TEST(LobiumFontsTest, OrderedFallbackFamiliesParseAndReachRenderer) {
  base::ScopedTempDir temp;
  ASSERT_TRUE(temp.CreateUniqueTempDir());
  const base::FilePath config_path = temp.GetPath().AppendASCII("lobium-fp.json");
  const std::string config = R"({
    "version": 1,
    "fonts": ["Roboto"],
    "fontPackDir": "C:\\staged-pack",
    "fontAliases": {"Droid Sans": "Roboto"},
    "fontFallbackFamilies": ["Roboto", "Noto Serif", "Noto Sans Mono"]
  })";
  ASSERT_TRUE(base::WriteFile(config_path, config));

  const std::optional<LobiumFpConfig> parsed =
      LobiumFpConfig::Load(config_path);
  ASSERT_TRUE(parsed.has_value());
  EXPECT_EQ(parsed->font_fallback_families,
            (std::vector<std::string>{"Roboto", "Noto Serif",
                                      "Noto Sans Mono"}));

  // fontFallbackFamilies now REACHES the renderer: the renderer-side alias-aware
  // font-name check (windows-font-renderer-fallback.patch) tests against it, so
  // it must survive the browser-only strip. fonts/fontPackDir/fontAliases stay
  // browser-only. This mirror is also enforced from the TS side by
  // lobium-config.test.ts ("the browser-only key list mirrors ...").
  const std::string renderer = StripBrowserOnlyKeys(config);
  EXPECT_NE(renderer.find("fontFallbackFamilies"), std::string::npos);
  EXPECT_EQ(renderer.find("fontPackDir"), std::string::npos);
  EXPECT_EQ(renderer.find("fontAliases"), std::string::npos);
  // "fonts" as an exact key is gone, but "fontFallbackFamilies" contains no
  // "fonts" substring, so a plain find() would not be fooled either way.
  EXPECT_EQ(renderer.find("\"fonts\""), std::string::npos);
}

} // namespace
} // namespace lobium
