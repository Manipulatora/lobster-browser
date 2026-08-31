// Copyright 2026 The Lobster Browser Authors.
//
// Font-set isolation policy, shared by every Windows surface that can reveal
// which font families a machine has installed.
//
// WHY THIS EXISTS. The installed font set is one of the highest-entropy signals
// a page can read, and it is read WITHOUT permission: a script lays out a
// string in a candidate family with a known fallback, measures the advance
// width, and concludes the family exists if the width differs. A few hundred
// such probes fingerprint a machine more sharply than the User-Agent does. A
// VPS, a developer workstation and a consumer laptop have visibly different
// sets, so a persona that claims Windows 11 while measuring as "Windows Server
// with no Office fonts" is caught by arithmetic alone.
//
// TWO HALVES, AND ONLY ONE OF THEM IS A FILTER. Making the measurable set equal
// the persona's set requires both directions:
//
//   subtract - host fonts the persona does not claim must stop resolving;
//   add      - verified open-font faces must be physically registered for
//              deterministic fallback.
//
// The browser process builds one restricted DirectWrite collection from those
// two inputs (see `font_pack_dir`). CSS claimed-family names may be mapped onto
// real pack faces by `font_aliases`; Local Font Access and PostScript names
// remain truthful.
//
// Subtraction alone would leave a persona measurably MISSING fonts, which is
// its own tell, so the pack is not optional polish - it is the other half of
// the same mechanism.
//
// NO POLICY IS STOCK; AN ACTIVE POLICY IS FAIL-CLOSED. With no config or font
// list and no pack, the exact system set is returned. Once the launcher
// supplies a policy/pack, falling back to the full host set would be a privacy
// leak, so an invalid configured pack or an unbuildable restricted set is
// returned as an error rather than silently widening visibility.

#ifndef COMPONENTS_LOBIUM_FP_LOBIUM_FONTS_H_
#define COMPONENTS_LOBIUM_FP_LOBIUM_FONTS_H_

#include <optional>
#include <string>
#include <string_view>
#include <vector>

#include "base/files/file_path.h"
#include "build/build_config.h"

#if BUILDFLAG(IS_WIN)
#include <dwrite_3.h>
#endif

namespace lobium {

// True when `family` may resolve for the active persona.
//
// `family` is a font FAMILY name ("Segoe UI"), compared case-insensitively
// because CSS font-family matching and DirectWrite family lookup are both
// case-insensitive - a filter that let "segoe ui" through while blocking "Segoe
// UI" would be trivially bypassed by lowercasing the probe.
//
// Windows-port generic and last-resort names are not implicit exceptions. An
// unclaimed name must miss normally and fall through to the restricted
// collection; otherwise a macOS/Linux/Android persona would expose Windows
// host families merely because the engine executable runs on Windows.
//
// Returns true unconditionally when no persona font list is configured.
bool FontFamilyAllowed(std::string_view family);

// The same test for a UTF-16 family name, which is the form the DirectWrite
// proxy receives over mojo. Provided so callers do not each hand-roll a
// conversion (and pick different case rules).
bool FontFamilyAllowed(std::u16string_view family);

// True when `family` is one of the persona's PHYSICAL pack families, i.e. a
// member of `font_fallback_families` (case-insensitively).
//
// This exists for the RENDERER, not the browser. Windows font isolation
// substitutes a claimed family onto a metric-compatible physical pack face in
// the browser process, but Blink then re-validates the result in the renderer
// BY FAMILY NAME (see font_cache_skia_win.cc): the SkTypeface it rebuilds from
// the pack bytes carries the physical name, so a request for "Segoe UI" served
// from "Liberation Sans" fails the name check and text falls through to the
// last-resort face; emoji fallback re-resolves "Noto Color Emoji" by name and
// gets nothing. This predicate lets that check accept a typeface whose own
// family is a member of the profile's OWN advertised pack inventory.
//
// Unlike FontFamilyAllowed this fails CLOSED: with no policy (or no pack
// inventory) it returns false, so stock Chromium's by-name verification is left
// exactly as-is. It is a membership test over the profile's own configuration
// and reveals nothing about the host font set.
bool FontFamilyIsPackPhysical(std::string_view family);

// The same test for a UTF-16 family name, mirroring the FontFamilyAllowed pair.
bool FontFamilyIsPackPhysical(std::u16string_view family);

// True when a PostScript / full font name may resolve for the active persona.
//
// `src: local("ArialMT")` and the Local Font Access blob API look a face up by
// its unique name, not by its family, so FontFamilyAllowed cannot answer
// directly: "ArialMT" is not equal to "Arial", and requiring equality would
// block every legitimate local() lookup a persona should satisfy.
//
// A unique name is conventionally the family with separators removed, plus a
// style suffix
// ("Verdana-Bold", "SegoeUI", "TimesNewRomanPSMT"). So the test is: does some
// allowed family, with spaces and hyphens stripped, PREFIX the equally-stripped
// unique name? That admits the real derivatives of a claimed family and rejects
// a family the persona never claimed. It is a heuristic and deliberately errs
// toward admitting - a false admit leaks one font, a false reject makes a
// legitimate page render in a fallback face, which is both a functional bug and
// its own tell.
bool FontUniqueNameAllowed(std::string_view unique_name);

// Returns the verified physical pack family used for CSS matching of a claimed
// family, or `family` unchanged when no alias was configured. This substitution
// is intentionally not used by local() or Local Font Access, whose face-level
// PostScript/full-name metadata must remain truthful.
std::string FontFamilyForMatching(std::string_view family);

// Claimed family names with CSS substitutions, sorted by the config
// writer/parser. These are safe to expose only through FontDataService's
// CSS-family catalog, not Local Font Access.
std::vector<std::string> ConfiguredFontAliasFamilies();

// Every font file below the provisioner's `dir/files/` tree that DirectWrite
// may load, sorted by path. Non-font files are ignored. A missing files
// directory, an enumeration error, or any reparse point/symlink in the
// traversed tree rejects the pack and returns an empty list.
//
// Sorted for determinism: the sideload order becomes the order faces are added
// to the font set, and an order that varied with directory-enumeration order
// could make family resolution differ between launches of the SAME profile - a
// profile whose fingerprint is not stable is worse than one whose fingerprint
// is wrong, because instability is itself observable.
std::vector<base::FilePath> FontPackFaces(const base::FilePath &dir);

#if BUILDFLAG(IS_WIN)

// Returns the process-cached DirectWrite font set/collection. With no policy it
// is the stock system snapshot. A configured verified stage is pack-only, so a
// host-installed same-name face cannot change metrics/styles; no-pack degraded
// mode contains only explicitly allowed system faces. All Windows consumers
// share this snapshot across CSS, fallback, Local Font Access, local(), and the
// legacy DWrite proxy.
// Character/default fallback uses `font_fallback_families` in launcher-defined
// persona order and fails when any requested family is absent from that
// collection; it never inherits the host's independent system fallback.
//
// A configured pack is all-or-nothing: every discovered file must be a
// supported font and every face in it must register. Pack or restricted-set
// failure is logged and returned to the caller; there is no host-wide fallback
// under an active policy. The count out-parameter is optional.
HRESULT GetCachedMergedFontSet(IDWriteFactory3 *factory,
                               IDWriteFontSet **font_set,
                               UINT32 *registered_pack_faces = nullptr);
HRESULT
GetCachedMergedFontCollection(IDWriteFactory3 *factory,
                              IDWriteFontCollection **collection,
                              UINT32 *registered_pack_faces = nullptr,
                              IDWriteFactory3 **owning_factory = nullptr);
HRESULT GetCachedMergedFontFallback(IDWriteFactory3 *factory,
                                    IDWriteFontFallback **fallback);

// Looks up a visible family only in the shared restricted collection and
// returns its localized name. A disallowed or absent family returns nullopt,
// so chrome.fontSettings cannot use host-only localization as an installation
// oracle. CSS-only aliases deliberately remain their claimed names because no
// proprietary face-level metadata is fabricated for them.
std::optional<std::string> GetVisibleLocalizedFontName(
    IDWriteFactory3 *factory,
    std::string_view family,
    std::string_view locale);

// Testing sideloads must remain visible even when the production pack snapshot
// has already been cached. These helpers layer the caller's extra files over
// that snapshot without changing it. Invalid extra files are skipped, matching
// Chromium's historical SideLoadFontForTesting behavior.
HRESULT CreateMergedFontSetWithExtraFaces(
    IDWriteFactory3 *factory, const std::vector<base::FilePath> &extra_faces,
    IDWriteFontSet **font_set, UINT32 *registered_pack_faces = nullptr);
HRESULT CreateMergedFontCollectionWithExtraFaces(
    IDWriteFactory3 *factory, const std::vector<base::FilePath> &extra_faces,
    IDWriteFontCollection **collection, UINT32 *registered_pack_faces = nullptr,
    IDWriteFactory3 **owning_factory = nullptr);

#endif // BUILDFLAG(IS_WIN)

} // namespace lobium

#endif // COMPONENTS_LOBIUM_FP_LOBIUM_FONTS_H_
