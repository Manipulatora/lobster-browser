// Copyright 2026 The Lobster Browser Authors.
//
// The per-profile window identity: a rounded violet square carrying the profile's initials, used
// wherever the operating system asks a window what it looks like.
//
// WHY THE ENGINE DRAWS IT RATHER THAN LOADING AN IMAGE. Every profile is its own Lobium process with
// its own user-data-dir, and the operating system takes a window's identity from that window: on
// Windows through WM_SETICON (ICON_SMALL for the title bar and the window list, ICON_BIG for the
// taskbar button), on Linux through _NET_WM_ICON. Chromium has no switch that points either slot at
// a file on disk, so the alternative - having the sidecar encode a PNG or an .ico per launch - would
// need BOTH an image encoder in the sidecar AND a decode path patched into the engine, to arrive at
// a bitmap the engine can already produce from two strings. Drawing with Skia also gives a crisp
// glyph at every size the platform asks for instead of one bitmap resampled to all of them.
//
// WHY IT DERIVES NOTHING. The mark is a REDUCTION of a profile name (a 16px icon holds one or two
// glyphs, not a 120-character name) and a reduction is only useful if the manager's row avatar and
// the launched window reduce identically. Splitting a name into words and a word into its first
// glyph is Unicode work, so it is done once, in the launcher, and arrives here already reduced on
// --lobium-profile-initials / --lobium-profile-word / --lobium-profile-tint. See
// packages/engine-runner/src/runners/profile-mark.ts.
//
// FAIL-OPEN, like every other Lobium hook: with no switches - a plain dev run, or a launcher older
// than this build - ProfileWindowIcon() returns a null image and the window keeps the stock Chromium
// icon.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_PROFILE_ICON_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_PROFILE_ICON_H_

#include <string>

#include "build/build_config.h"
#include "ui/gfx/image/image_skia.h"

namespace lobium {

// The size, in DIP, of the icon offered to the window's SMALL slot: Windows scales it to
// SM_CXSMICON for the title bar and the alt-tab list, X11 publishes it as the smallest _NET_WM_ICON
// entry. 16 matches what Chromium itself hands that slot (a favicon), so the 1x representation is
// the exact size the platform asks for at 100% scaling.
inline constexpr int kProfileWindowIconSizeDip = 16;

// The size, in DIP, of the icon offered to the window's LARGE slot. The two platforms want
// different things from it and neither answer works for the other:
//
//   Windows - the slot becomes ICON_BIG, an SM_CXICON-sized taskbar icon (32px at 100% scaling), so
//             it must carry the same short mark the small icon does. A word rendered at 48 and then
//             resampled to 32 is unreadable.
//   Linux   - X11Window serializes exactly two images into _NET_WM_ICON and the window manager picks
//             from that list, so this is the only chance to publish a size large enough for
//             GNOME's overview. At 128 there is room for a whole word.
#if BUILDFLAG(IS_WIN)
inline constexpr int kProfileAppIconSizeDip = 48;
#else
inline constexpr int kProfileAppIconSizeDip = 128;
#endif

// The profile's full display name (--lobium-profile-name), or empty when none was supplied. The
// window title is the one surface with room for it.
std::u16string ProfileDisplayName();

// A rounded violet square `size_dip` on a side, carrying this profile's initials - or its first
// word, at sizes where a word is legible. Null when the launcher supplied no mark, which is the
// caller's signal to keep stock Chromium behaviour.
gfx::ImageSkia ProfileWindowIcon(int size_dip);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_PROFILE_ICON_H_
