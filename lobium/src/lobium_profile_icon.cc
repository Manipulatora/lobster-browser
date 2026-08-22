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
#include "cc/paint/paint_shader.h"
#include "third_party/skia/include/core/SkColor.h"
#include "third_party/skia/include/core/SkPoint.h"
#include "third_party/skia/include/core/SkTileMode.h"
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

// At and above this size the NAME is legible, because it is wrapped over two lines rather than
// squeezed onto one; below it, only the initials are. 128 was the old floor and it meant every
// taskbar and alt-tab slot - the places a user actually distinguishes profiles - fell back to two
// letters. Wrapping buys roughly twice the glyph budget per line, which is what makes 64 readable.
constexpr int kWordLabelMinSizeDip = 64;

// Rows the name may wrap onto. Two: a third line on a square leaves each line too short to hold a
// word, so names break mid-word and read worse than the same name on two lines at a smaller size.
constexpr int kLabelMaxLines = 2;

// Corner radius as a fraction of the side. Enough to read as rounded at 128px, little enough that
// the shape still reads as a SQUARE at 16px, where a larger radius rounds into a circle.
constexpr float kCornerRadiusRatio = 0.22f;

// The share of the side the label may occupy, in each axis. The margin is what keeps a two-glyph
// mark from touching the rounded corners.
constexpr float kLabelWidthRatio = 0.82f;
constexpr float kLabelHeightRatio = 0.54f;

// A single line may use the full height ratio; two lines share it, so each starts smaller.
constexpr float kMultiLineHeightRatio = 0.30f;

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
gfx::FontList FitLabelFont(const std::u16string& label, int side, bool multi_line) {
  const float max_width = static_cast<float>(side) * kLabelWidthRatio;
  const float height_ratio = multi_line ? kMultiLineHeightRatio : kLabelHeightRatio;
  int size_px = std::max(
      kMinLabelFontSize,
      static_cast<int>(std::lround(static_cast<float>(side) * height_ratio)));
  gfx::FontList font = LabelFont(size_px);
  // A wrapped label may use the full width kLabelMaxLines times over before it has to shrink; a
  // single-line one has only the one row. Measuring against that budget is what lets a two-word
  // name stay large instead of being shrunk as though it had to fit on one line.
  const float width_budget = max_width * (multi_line ? kLabelMaxLines : 1);
  while (size_px > kMinLabelFontSize && gfx::GetStringWidthF(label, font) > width_budget) {
    size_px -= 1;
    font = LabelFont(size_px);
  }
  return font;
}

class ProfileIconSource : public gfx::CanvasImageSource {
 public:
  ProfileIconSource(int side, std::u16string label, SkColor tint, bool multi_line);

  ProfileIconSource(const ProfileIconSource&) = delete;
  ProfileIconSource& operator=(const ProfileIconSource&) = delete;

  ~ProfileIconSource() override;

  // gfx::CanvasImageSource:
  void Draw(gfx::Canvas* canvas) override;

 private:
  const std::u16string label_;
  const SkColor tint_;
  const bool multi_line_;
};

ProfileIconSource::ProfileIconSource(int side,
                                     std::u16string label,
                                     SkColor tint,
                                     bool multi_line)
    : gfx::CanvasImageSource(gfx::Size(side, side)),
      label_(std::move(label)),
      tint_(tint),
      multi_line_(multi_line) {}

ProfileIconSource::~ProfileIconSource() = default;

void ProfileIconSource::Draw(gfx::Canvas* canvas) {
  const int side = size().width();

  cc::PaintFlags flags;
  flags.setAntiAlias(true);
  flags.setStyle(cc::PaintFlags::kFill_Style);
  // A vertical gradient rather than a flat fill. The mark sits next to real application icons in a
  // taskbar, all of which have some depth to them; a single flat violet square reads as a
  // placeholder that failed to load. Two stops of the SAME hue - the tint, and the tint darkened -
  // so the shade still identifies the profile and the icon does not become a second colour.
  const SkColor bottom = SkColorSetRGB(static_cast<U8CPU>(SkColorGetR(tint_) * 0.72f),
                                       static_cast<U8CPU>(SkColorGetG(tint_) * 0.72f),
                                       static_cast<U8CPU>(SkColorGetB(tint_) * 0.72f));
  // SkColor4f, not SkColor: MakeLinearGradient takes float colours.
  const SkColor4f stops[] = {SkColor4f::FromColor(tint_), SkColor4f::FromColor(bottom)};
  const SkPoint ends[] = {SkPoint::Make(0.0f, 0.0f),
                          SkPoint::Make(0.0f, static_cast<SkScalar>(side))};
  flags.setShader(cc::PaintShader::MakeLinearGradient(ends, stops, /*pos=*/nullptr,
                                                      /*count=*/2, SkTileMode::kClamp));
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
  int text_flags = gfx::Canvas::TEXT_ALIGN_CENTER | gfx::Canvas::NO_ELLIPSIS |
                   gfx::Canvas::NO_SUBPIXEL_RENDERING;
  if (multi_line_) {
    text_flags |= gfx::Canvas::MULTI_LINE;
  }
  // Inset so a wrapped line cannot touch the rounded corners.
  const int inset = static_cast<int>(static_cast<float>(side) * (1.0f - kLabelWidthRatio) / 2.0f);
  canvas->DrawStringRectWithFlags(
      label_, FitLabelFont(label_, side, multi_line_), SK_ColorWHITE,
      gfx::Rect(inset, 0, side - inset * 2, side), text_flags);
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
  const bool use_name = size_dip >= kWordLabelMinSizeDip && !mark.word.empty();
  const std::u16string& label = use_name ? mark.word : mark.initials;
  return cache
      ->emplace(size_dip, gfx::CanvasImageSource::MakeImageSkia<ProfileIconSource>(
                              size_dip, label, mark.tint, use_name))
      .first->second;
}

}  // namespace lobium
