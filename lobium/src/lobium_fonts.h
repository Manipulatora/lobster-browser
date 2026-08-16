// Copyright 2026 The Lobster Browser Authors.
//
// Font-set isolation policy, shared by every Windows surface that can reveal which font families a
// machine has installed.
//
// WHY THIS EXISTS. The installed font set is one of the highest-entropy signals a page can read, and
// it is read WITHOUT permission: a script lays out a string in a candidate family with a known
// fallback, measures the advance width, and concludes the family exists if the width differs. A few
// hundred such probes fingerprint a machine more sharply than the User-Agent does. A VPS, a
// developer workstation and a consumer laptop have visibly different sets, so a persona that claims
// Windows 11 while measuring as "Windows Server with no Office fonts" is caught by arithmetic
// alone.
//
// TWO HALVES, AND ONLY ONE OF THEM IS A FILTER. Making the measurable set equal the persona's set
// requires both directions:
//
//   subtract - host fonts the persona does not claim must stop resolving. That is this file.
//   add      - fonts the persona claims that the host lacks must be made resolvable. Filtering
//              cannot do that; only real font files can. The browser process sideloads the
//              profile's font pack into the DirectWrite collection (see `font_pack_dir`), which is
//              the Windows analogue of the private FONTCONFIG_FILE the launcher writes on Linux.
//
// Subtraction alone would leave a persona measurably MISSING fonts, which is its own tell, so the
// pack is not optional polish - it is the other half of the same mechanism.
//
// FAIL-OPEN. Consistent with every other native hook: with no config, or an empty font list, every
// family resolves exactly as stock Chromium would. A bug here must degrade to honest behaviour, not
// to a browser that cannot find a font to render with.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_FONTS_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_FONTS_H_

#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"

namespace lobium {

// True when `family` may resolve for the active persona.
//
// `family` is a font FAMILY name ("Segoe UI"), compared case-insensitively because CSS font-family
// matching and DirectWrite family lookup are both case-insensitive - a filter that let "segoe ui"
// through while blocking "Segoe UI" would be trivially bypassed by lowercasing the probe.
//
// Returns true unconditionally when no persona font list is configured.
bool FontFamilyAllowed(std::string_view family);

// The same test for a UTF-16 family name, which is the form the DirectWrite proxy receives over
// mojo. Provided so callers do not each hand-roll a conversion (and pick different case rules).
bool FontFamilyAllowed(std::u16string_view family);

// True when a PostScript / full font name may resolve for the active persona.
//
// `src: local("ArialMT")` and the Local Font Access blob API look a face up by its unique name, not
// by its family, so FontFamilyAllowed cannot answer directly: "ArialMT" is not equal to "Arial", and
// requiring equality would block every legitimate local() lookup a persona should satisfy.
//
// A unique name is conventionally the family with separators removed, plus a style suffix
// ("Verdana-Bold", "SegoeUI", "TimesNewRomanPSMT"). So the test is: does some allowed family, with
// spaces and hyphens stripped, PREFIX the equally-stripped unique name? That admits the real
// derivatives of a claimed family and rejects a family the persona never claimed. It is a heuristic
// and deliberately errs toward admitting - a false admit leaks one font, a false reject makes a
// legitimate page render in a fallback face, which is both a functional bug and its own tell.
bool FontUniqueNameAllowed(std::string_view unique_name);

// Every font file in `dir` that DirectWrite can load, non-recursively, sorted by name.
//
// Sorted for determinism: the sideload order becomes the order faces are added to the font set, and
// an order that varied with directory-enumeration order could make family resolution differ between
// launches of the SAME profile - a profile whose fingerprint is not stable is worse than one whose
// fingerprint is wrong, because instability is itself observable.
std::vector<base::FilePath> FontPackFaces(const base::FilePath& dir);

}  // namespace lobium

#endif  // COMPONENTS_LOBIUM_FP_LOBIUM_FONTS_H_
