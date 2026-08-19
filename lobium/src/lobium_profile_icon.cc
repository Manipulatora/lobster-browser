// Copyright 2026 The Lobster Browser Authors.

#include "components/lobium_fp/lobium_profile_icon.h"

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <string>
#include <string_view>
#include <utility>

#include "base/command_line.h"
#include "base/containers/flat_map.h"
#include "base/no_destructor.h"
#include "base/strings/string_number_conversions.h"
#include "base/strings/utf_string_conversions.h"
#include "build/build_config.h"
#include "cc/paint/paint_flags.h"
#include "third_party/skia/include/core/SkColor.h"
#include "ui/gfx/canvas.h"
#include "ui/gfx/font.h"
#include "ui/gfx/font_list.h"
#include "ui/gfx/geometry/rect.h"
#include "ui/gfx/geometry/rect_f.h"
#include "ui/gfx/geometry/size.h"
#include "ui/gfx/image/canvas_image_source.h"
#include "ui/gfx/text_utils.h"

namespace lobium {

namespace {

constexpr char kProfileNameSwitch[] = "lobium-profile-name";
constexpr char kProfileInitialsSwitch[] = "lobium-profile-initials";
constexpr char kProfileWordSwitch[] = "lobium-profile-word";
constexpr char kProfileTintSwitch[] = "lobium-profile-tint";

// --brand-500 from the product's design tokens. Used when the launcher supplied initials but no
// usable tint, so a malformed colour costs the shade rather than the whole icon.
constexpr SkColor kFallbackTint = SkColorSetRGB(0x7c, 0x3a, 0xed);

// At and above this size a word is legible; below it, only the initials are. Nothing in between
// reads as a compromise - a word at 48px is a smear, and initials at 128px are a placeholder.
constexpr int kWordLabelMinSizeDip = 128;

// Corner radius as a fraction of the side. Enough to read as rounded at 128px, little enough that
// the shape still reads as a SQUARE at 16px, where a larger radius rounds into a circle.
constexpr float kCornerRadiusRatio = 0.22f;

// The share of the side the label may occupy, in each axis. The margin is what keeps a two-glyph
// mark from touching the rounded corners.
constexpr float kLabelWidthRatio = 0.76f;
constexpr float kLabelHeightRatio = 0.54f;

// Below this the glyphs are noise, so the label is drawn small rather than shrunk further.
constexpr int kMinLabelFontSize = 6;

// The mark switches carry a profile NAME, so they are not ASCII: GetSwitchValueASCII returns empty
// for anything outside it, which would silently drop the mark for every Cyrillic, Greek or CJK
// profile. The native value is UTF-16 on Windows and UTF-8 everywhere else.
std::u16string SwitchValueUTF16(std::string_view name) {
  const base::CommandLine::StringType value =
      base::CommandLine::ForCurrentProcess()->GetSwitchValueNative(name);
#if BUILDFLAG(IS_WIN)
  return base::WideToUTF16(value);
#else
  return base::UTF8ToUTF16(value);
#endif
}

SkColor ParseTint(std::string_view value) {
  std::string_view digits = value;
  if (!digits.empty() && digits.front() == '#') {
    digits.remove_prefix(1);
  }
  uint32_t rgb = 0;
  if (digits.size() != 6 || !base::HexStringToUInt(digits, &rgb)) {
    return kFallbackTint;
  }
  return SkColorSetRGB(static_cast<uint8_t>((rgb >> 16) & 0xff),
                       static_cast<uint8_t>((rgb >> 8) & 0xff),
                       static_cast<uint8_t>(rgb & 0xff));
}

struct ProfileMark {
  std::u16string display_name;
  std::u16string initials;
  std::u16string word;
  SkColor tint = kFallbackTint;
};

// Read once: the command line cannot change after startup, and every branding surface reads this
// rather than the switches, so they cannot disagree about whether a mark is present.
const ProfileMark& CurrentMark() {
  static const base::NoDestructor<ProfileMark> mark([] {
    ProfileMark read;
    read.display_name = SwitchValueUTF16(kProfileNameSwitch);
    read.initials = SwitchValueUTF16(kProfileInitialsSwitch);
    read.word = SwitchValueUTF16(kProfileWordSwitch);
    read.tint = ParseTint(base::CommandLine::ForCurrentProcess()->GetSwitchValueASCII(
        kProfileTintSwitch));
    return read;
  }());
  return *mark;
}

gfx::FontList LabelFont(int size_px) {
  const gfx::FontList base_font;
  return base_font.Derive(size_px - base_font.GetFontSize(), gfx::Font::NORMAL,
                          gfx::Font::Weight::BOLD);
}

// The largest font the box holds, found by measuring rather than by assuming a glyph width: two
// Latin initials, two CJK ideographs and a twelve-letter word are all legal labels and none of them
// has the advance width of the others.
gfx::FontList FitLabelFont(const std::u16string& label, int side) {
  const float max_width = static_cast<float>(side) * kLabelWidthRatio;
  int size_px = std::max(
      kMinLabelFontSize,
      static_cast<int>(std::lround(static_cast<float>(side) * kLabelHeightRatio)));
  gfx::FontList font = LabelFont(size_px);
  while (size_px > kMinLabelFontSize && gfx::GetStringWidthF(label, font) > max_width) {
    size_px -= 1;
    font = LabelFont(size_px);
  }
  return font;
}

class ProfileIconSource : public gfx::CanvasImageSource {
 public:
  ProfileIconSource(int side, std::u16string label, SkColor tint);

  ProfileIconSource(const ProfileIconSource&) = delete;
  ProfileIconSource& operator=(const ProfileIconSource&) = delete;

  ~ProfileIconSource() override;

  // gfx::CanvasImageSource:
  void Draw(gfx::Canvas* canvas) override;

 private:
  const std::u16string label_;
  const SkColor tint_;
};

ProfileIconSource::ProfileIconSource(int side, std::u16string label, SkColor tint)
    : gfx::CanvasImageSource(gfx::Size(side, side)),
      label_(std::move(label)),
      tint_(tint) {}

ProfileIconSource::~ProfileIconSource() = default;

void ProfileIconSource::Draw(gfx::Canvas* canvas) {
  const int side = size().width();

  cc::PaintFlags flags;
  flags.setAntiAlias(true);
  flags.setStyle(cc::PaintFlags::kFill_Style);
  flags.setColor(tint_);
  canvas->DrawRoundRect(
      gfx::RectF(0.0f, 0.0f, static_cast<float>(side), static_cast<float>(side)),
      static_cast<float>(side) * kCornerRadiusRatio, flags);

  if (label_.empty()) {
    return;
  }
  // NO_SUBPIXEL_RENDERING because the square has transparent corners and the whole image is later
  // blended - by the taskbar, by the window manager - against a background this process never sees;
  // subpixel coverage computed against the violet fill would fringe there. NO_ELLIPSIS because the
  // font was already sized to fit, and an ellipsis would spend a glyph slot saying nothing.
  canvas->DrawStringRectWithFlags(
      label_, FitLabelFont(label_, side), SK_ColorWHITE, gfx::Rect(0, 0, side, side),
      gfx::Canvas::TEXT_ALIGN_CENTER | gfx::Canvas::NO_ELLIPSIS |
          gfx::Canvas::NO_SUBPIXEL_RENDERING);
}

}  // namespace

std::u16string ProfileDisplayName() {
  return CurrentMark().display_name;
}

gfx::ImageSkia ProfileWindowIcon(int size_dip) {
  const ProfileMark& mark = CurrentMark();
  if (size_dip <= 0 || mark.initials.empty()) {
    return gfx::ImageSkia();
  }
  // Cached per size. BrowserView::UpdateTitleBar asks for both icons again on every tab switch and
  // every page title change, and a fresh ImageSkia would re-shape the text and re-rasterize each
  // time; the mark itself cannot change for the lifetime of the process. gfx::ImageSkia is a
  // refcounted handle, so handing out copies shares the rasterization the first caller paid for.
  static base::NoDestructor<base::flat_map<int, gfx::ImageSkia>> cache;
  const auto existing = cache->find(size_dip);
  if (existing != cache->end()) {
    return existing->second;
  }
  const std::u16string& label =
      (size_dip >= kWordLabelMinSizeDip && !mark.word.empty()) ? mark.word : mark.initials;
  return cache
      ->emplace(size_dip, gfx::CanvasImageSource::MakeImageSkia<ProfileIconSource>(
                              size_dip, label, mark.tint))
      .first->second;
}

}  // namespace lobium
