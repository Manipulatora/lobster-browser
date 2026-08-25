// Copyright 2026 The Lobster Browser Authors.
//
// See lobium_fonts.h.

#include "components/lobium_fp/lobium_fonts.h"

#include <algorithm>

#if BUILDFLAG(IS_WIN)
#include <windows.h>
#include <wrl/client.h>
#endif

#include "base/files/file_enumerator.h"
#include "base/files/file_util.h"
#include "base/logging.h"
#include "base/no_destructor.h"
#include "base/strings/string_util.h"
#include "base/strings/utf_string_conversions.h"
#include "base/threading/scoped_blocking_call.h"
#include "components/lobium_fp/lobium_fp_config.h"

namespace lobium {

namespace {

// Extensions DirectWrite can load. Anything else in the pack directory
// (licences, a manifest, the SHA-256 sidecar) is skipped rather than handed to
// CreateFontFileReference, which would fail the whole collection build and
// leave the profile with NO sideloaded fonts at all.
bool IsFontFile(const base::FilePath &path) {
  // MatchesFinalExtension is case-insensitive and takes the platform's char
  // type, unlike base::ToLowerASCII, which has no std::wstring overload.
  return path.MatchesFinalExtension(FILE_PATH_LITERAL(".ttf")) ||
         path.MatchesFinalExtension(FILE_PATH_LITERAL(".ttc")) ||
         path.MatchesFinalExtension(FILE_PATH_LITERAL(".otf"));
}

// Treat every reparse point as untrusted, not only name-surrogate links. Cloud
// placeholders and other providers can use non-surrogate reparse tags whose
// bytes may change while the process is running. A fingerprint pack must be a
// stable tree of ordinary local files.
bool IsUnsafePackPath(const base::FilePath &path) {
#if BUILDFLAG(IS_WIN)
  const DWORD attributes = ::GetFileAttributes(path.value().c_str());
  return attributes == INVALID_FILE_ATTRIBUTES ||
         (attributes & FILE_ATTRIBUTE_REPARSE_POINT) != 0;
#else
  return base::IsLink(path);
#endif
}

} // namespace

bool FontFamilyAllowed(std::string_view family) {
  const LobiumFpConfig *cfg = LobiumFpConfig::Current();
  // Fail open. No config, or a persona with no font list, behaves exactly like
  // stock Chromium.
  if (!cfg || cfg->fonts.empty()) {
    return true;
  }

  const std::string needle = base::ToLowerASCII(family);
  for (const std::string &configured : cfg->fonts) {
    if (base::EqualsCaseInsensitiveASCII(configured, needle)) {
      return true;
    }
  }
  return false;
}

bool FontFamilyAllowed(std::u16string_view family) {
  // Cheap pre-check before the UTF-16 -> UTF-8 conversion: with no policy in
  // force every name is allowed, and this is on the path of every font lookup
  // the renderer makes.
  const LobiumFpConfig *cfg = LobiumFpConfig::Current();
  if (!cfg || cfg->fonts.empty()) {
    return true;
  }
  // Named local, not a temporary passed straight into a string_view parameter:
  // the lifetime would still be fine here, but the pattern is one refactor away
  // from a dangling view.
  const std::string utf8 = base::UTF16ToUTF8(family);
  return FontFamilyAllowed(std::string_view(utf8));
}

bool FontUniqueNameAllowed(std::string_view unique_name) {
  const LobiumFpConfig *cfg = LobiumFpConfig::Current();
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
  for (const std::string &configured : cfg->fonts) {
    const std::string prefix = squash(configured);
    // Skip empty entries; an empty prefix matches everything and would disable
    // the filter.
    if (!prefix.empty() && needle.starts_with(prefix)) {
      return true;
    }
  }
  return false;
}

std::string FontFamilyForMatching(std::string_view family) {
  const LobiumFpConfig *cfg = LobiumFpConfig::Current();
  if (cfg && FontFamilyAllowed(family)) {
    for (const auto &[claimed, physical] : cfg->font_aliases) {
      if (base::EqualsCaseInsensitiveASCII(claimed, family)) {
        return physical;
      }
    }
  }
  return std::string(family);
}

std::vector<std::string> ConfiguredFontAliasFamilies() {
  std::vector<std::string> families;
  const LobiumFpConfig *cfg = LobiumFpConfig::Current();
  if (!cfg) {
    return families;
  }
  families.reserve(cfg->font_aliases.size());
  for (const auto &[claimed, physical] : cfg->font_aliases) {
    if (!claimed.empty() && !physical.empty() && FontFamilyAllowed(claimed)) {
      families.push_back(claimed);
    }
  }
  return families;
}

std::vector<base::FilePath> FontPackFaces(const base::FilePath &dir) {
  std::vector<base::FilePath> faces;
  if (dir.empty()) {
    return faces;
  }

  // The provisioner deliberately keeps the manifest at the pack root and all
  // loadable bytes below `files/`. Never scan the caller-supplied root: doing
  // so both missed the actual provisioned layout and made an unrelated font
  // dropped beside the manifest loadable.
  const base::FilePath files_dir = dir.AppendASCII("files");
  if (IsUnsafePackPath(dir) || IsUnsafePackPath(files_dir) ||
      !base::DirectoryExists(dir) || !base::DirectoryExists(files_dir)) {
    return faces;
  }

  int file_types =
      base::FileEnumerator::FILES | base::FileEnumerator::DIRECTORIES;
#if BUILDFLAG(IS_POSIX) || BUILDFLAG(IS_FUCHSIA)
  // Report links themselves so IsUnsafePackPath can reject the pack. Without
  // this flag the POSIX enumerator follows directory links, which would let
  // files outside `files/` enter the set.
  file_types |= base::FileEnumerator::SHOW_SYM_LINKS;
#endif
  base::FileEnumerator it(files_dir, /*recursive=*/true, file_types,
                          FILE_PATH_LITERAL("*"),
                          base::FileEnumerator::FolderSearchPolicy::ALL,
                          base::FileEnumerator::ErrorPolicy::STOP_ENUMERATION);
  for (base::FilePath path = it.Next(); !path.empty(); path = it.Next()) {
    // FileEnumerator already refuses to recurse into Windows reparse
    // directories, but returning an apparently valid partial pack would be
    // worse than rejecting it: different host directory layouts would then
    // produce different persona font sets.
    if (IsUnsafePackPath(path)) {
      faces.clear();
      return faces;
    }
    if (!it.GetInfo().IsDirectory() && IsFontFile(path)) {
      faces.push_back(path);
    }
  }
  if (it.GetError() != base::File::FILE_OK) {
    faces.clear();
    return faces;
  }
  std::sort(faces.begin(), faces.end());
  faces.erase(std::unique(faces.begin(), faces.end()), faces.end());
  return faces;
}

#if BUILDFLAG(IS_WIN)

namespace {

namespace mswr = Microsoft::WRL;

HRESULT AddFontFiles(IDWriteFactory3 *factory, IDWriteFontSetBuilder *builder,
                     const std::vector<base::FilePath> &files, bool strict,
                     UINT32 *registered_faces) {
  UINT32 total_registered = 0;
  for (const base::FilePath &path : files) {
    mswr::ComPtr<IDWriteFontFile> font_file;
    HRESULT hr = factory->CreateFontFileReference(path.value().c_str(), nullptr,
                                                  &font_file);
    if (FAILED(hr)) {
      if (strict) {
        return hr;
      }
      continue;
    }

    BOOL supported = FALSE;
    DWRITE_FONT_FILE_TYPE file_type = DWRITE_FONT_FILE_TYPE_UNKNOWN;
    UINT32 face_count = 0;
    hr = font_file->Analyze(&supported, &file_type, nullptr, &face_count);
    if (FAILED(hr) || !supported || face_count == 0) {
      if (strict) {
        return FAILED(hr) ? hr : E_FAIL;
      }
      continue;
    }

    for (UINT32 face_index = 0; face_index < face_count; ++face_index) {
      mswr::ComPtr<IDWriteFontFaceReference> face;
      hr = factory->CreateFontFaceReference(
          font_file.Get(), face_index, DWRITE_FONT_SIMULATIONS_NONE, &face);
      if (FAILED(hr)) {
        if (strict) {
          return hr;
        }
        continue;
      }
      hr = builder->AddFontFaceReference(face.Get());
      if (FAILED(hr)) {
        if (strict) {
          return hr;
        }
        continue;
      }
      ++total_registered;
    }
  }
  if (registered_faces) {
    *registered_faces = total_registered;
  }
  return S_OK;
}

HRESULT AddSystemFonts(IDWriteFontSetBuilder *builder,
                       IDWriteFontSet *system_set) {
  const LobiumFpConfig *cfg = LobiumFpConfig::Current();
  if (!cfg || cfg->fonts.empty()) {
    // No persona policy means byte-for-byte stock visibility and the fast
    // DirectWrite bulk path.
    return builder->AddFontSet(system_set);
  }

  // A full system set plus a by-name filter is insufficient: DirectWrite
  // character fallback can select a face without performing a family lookup.
  // Restrict the actual set so CSS matching, fallback, local(), enumeration,
  // and the legacy proxy share the same subtractive boundary.
  const UINT32 count = system_set->GetFontCount();
  for (UINT32 index = 0; index < count; ++index) {
    mswr::ComPtr<IDWriteLocalizedStrings> family_names;
    BOOL family_names_exist = FALSE;
    HRESULT hr = system_set->GetPropertyValues(
        index, DWRITE_FONT_PROPERTY_ID_FAMILY_NAME, &family_names_exist,
        &family_names);
    if (FAILED(hr) || !family_names_exist || !family_names) {
      // Under an active policy an unclassifiable system face must not leak
      // through fallback.
      continue;
    }

    bool allowed = false;
    for (UINT32 name_index = 0; name_index < family_names->GetCount();
         ++name_index) {
      UINT32 length = 0;
      if (FAILED(family_names->GetStringLength(name_index, &length))) {
        continue;
      }
      std::vector<wchar_t> family(length + 1);
      if (SUCCEEDED(
              family_names->GetString(name_index, family.data(), length + 1)) &&
          FontFamilyAllowed(
              base::WideToUTF8(std::wstring_view(family.data(), length)))) {
        allowed = true;
        break;
      }
    }
    if (!allowed) {
      continue;
    }

    mswr::ComPtr<IDWriteFontFaceReference> face;
    hr = system_set->GetFontFaceReference(index, &face);
    if (FAILED(hr)) {
      return hr;
    }
    hr = builder->AddFontFaceReference(face.Get());
    if (FAILED(hr)) {
      return hr;
    }
  }
  return S_OK;
}

HRESULT BuildFontSet(IDWriteFactory3 *factory,
                     const std::vector<base::FilePath> &pack_files,
                     const std::vector<base::FilePath> &extra_files,
                     IDWriteFontSet **font_set, UINT32 *registered_pack_faces) {
  if (!factory || !font_set) {
    return E_INVALIDARG;
  }
  *font_set = nullptr;
  if (registered_pack_faces) {
    *registered_pack_faces = 0;
  }

  mswr::ComPtr<IDWriteFontSetBuilder> builder;
  HRESULT hr = factory->CreateFontSetBuilder(&builder);
  if (FAILED(hr)) {
    return hr;
  }

  if (pack_files.empty()) {
    mswr::ComPtr<IDWriteFontSet> system_set;
    hr = factory->GetSystemFontSet(&system_set);
    if (FAILED(hr)) {
      return hr;
    }
    hr = AddSystemFonts(builder.Get(), system_set.Get());
    if (FAILED(hr)) {
      return hr;
    }
  }

  // A configured verified stage is the complete physical source. Never union
  // same-name system faces with it: their bytes/styles differ by host even when
  // the family inventory looks identical. The system subset above exists only
  // for Windows' explicit no-pack degraded mode.
  UINT32 pack_faces = 0;
  hr = AddFontFiles(factory, builder.Get(), pack_files, /*strict=*/true,
                    &pack_faces);
  if (FAILED(hr) || (!pack_files.empty() && pack_faces == 0)) {
    return FAILED(hr) ? hr : E_FAIL;
  }
  // Chromium's testing API historically skipped individual malformed sideloads
  // instead of making the whole browser font set unusable. Keep that contract
  // while treating the production pack as an all-or-nothing verified input
  // above.
  hr = AddFontFiles(factory, builder.Get(), extra_files, /*strict=*/false,
                    /*registered_faces=*/nullptr);
  if (FAILED(hr)) {
    return hr;
  }
  hr = builder->CreateFontSet(font_set);
  if (SUCCEEDED(hr) && registered_pack_faces) {
    *registered_pack_faces = pack_faces;
  }
  return hr;
}

HRESULT BuildRestrictedFontFallback(IDWriteFactory3 *factory,
                                    IDWriteFontCollection *collection,
                                    IDWriteFontFallback **fallback) {
  if (!factory || !collection || !fallback) {
    return E_INVALIDARG;
  }
  *fallback = nullptr;

  const UINT32 family_count = collection->GetFontFamilyCount();
  std::vector<std::wstring> family_names;
  const LobiumFpConfig *cfg = LobiumFpConfig::Current();
  if (cfg && !cfg->font_fallback_families.empty()) {
    family_names.reserve(cfg->font_fallback_families.size());
    std::vector<std::string> seen;
    for (const std::string &requested : cfg->font_fallback_families) {
      if (requested.empty() ||
          std::any_of(seen.begin(), seen.end(), [&](const std::string &name) {
            return base::EqualsCaseInsensitiveASCII(name, requested);
          })) {
        return E_INVALIDARG;
      }
      const std::wstring requested_wide = base::UTF8ToWide(requested);
      UINT32 family_index = UINT32_MAX;
      BOOL exists = FALSE;
      HRESULT hr = collection->FindFamilyName(requested_wide.c_str(),
                                              &family_index, &exists);
      if (FAILED(hr) || !exists || family_index == UINT32_MAX) {
        return FAILED(hr) ? hr : E_FAIL;
      }
      seen.push_back(requested);
      family_names.push_back(requested_wide);
    }
  } else {
    family_names.reserve(family_count);
    for (UINT32 family_index = 0; family_index < family_count; ++family_index) {
      mswr::ComPtr<IDWriteFontFamily> family;
      HRESULT hr = collection->GetFontFamily(family_index, &family);
      if (FAILED(hr)) {
        return hr;
      }
      mswr::ComPtr<IDWriteLocalizedStrings> names;
      hr = family->GetFamilyNames(&names);
      if (FAILED(hr) || !names || names->GetCount() == 0) {
        return FAILED(hr) ? hr : E_FAIL;
      }
      UINT32 name_index = 0;
      BOOL en_us_exists = FALSE;
      if (FAILED(names->FindLocaleName(L"en-us", &name_index,
                                      &en_us_exists))) {
        return E_FAIL;
      }
      if (!en_us_exists) {
        name_index = 0;
      }
      UINT32 length = 0;
      hr = names->GetStringLength(name_index, &length);
      if (FAILED(hr)) {
        return hr;
      }
      std::wstring name(length + 1, L'\0');
      hr = names->GetString(name_index, name.data(), length + 1);
      if (FAILED(hr)) {
        return hr;
      }
      name.resize(length);
      if (!name.empty()) {
        family_names.push_back(std::move(name));
      }
    }
  }
  if (family_names.empty()) {
    return E_FAIL;
  }

  std::vector<const wchar_t *> target_names;
  target_names.reserve(family_names.size());
  for (const std::wstring &family : family_names) {
    target_names.push_back(family.c_str());
  }

  mswr::ComPtr<IDWriteFontFallbackBuilder> builder;
  HRESULT hr = factory->CreateFontFallbackBuilder(&builder);
  if (FAILED(hr)) {
    return hr;
  }
  // One explicit mapping for the entire Unicode scalar range. Do not append the
  // system fallback: its mappings are independent of our collection and can
  // return a disallowed host face.
  const DWRITE_UNICODE_RANGE all_unicode = {0, 0x10FFFF};
  hr = builder->AddMapping(&all_unicode, 1, target_names.data(),
                           static_cast<UINT32>(target_names.size()), collection,
                           /*localeName=*/nullptr,
                           /*baseFamilyName=*/nullptr, 1.0f);
  if (FAILED(hr)) {
    return hr;
  }
  return builder->CreateFontFallback(fallback);
}

struct CachedMergedFonts {
  explicit CachedMergedFonts(IDWriteFactory3 *bootstrap_factory)
      : factory(bootstrap_factory) {
    base::ScopedBlockingCall scoped_blocking_call(
        FROM_HERE, base::BlockingType::MAY_BLOCK);

    const LobiumFpConfig *cfg = LobiumFpConfig::Current();
    const bool pack_requested = cfg && !cfg->font_pack_dir.empty();
    const bool policy_active = cfg && !cfg->fonts.empty();

    if (!pack_requested && !policy_active) {
      // Preserve stock Chromium exactly when no font policy is configured.
      HRESULT hr = factory->GetSystemFontSet(&font_set);
      if (SUCCEEDED(hr)) {
        hr = factory->GetSystemFontCollection(&collection);
      }
      if (SUCCEEDED(hr)) {
        hr = factory->GetSystemFontFallback(&fallback);
      }
      result = hr;
      return;
    }

    std::vector<base::FilePath> pack_files;
    if (pack_requested) {
      pack_files =
          FontPackFaces(base::FilePath::FromUTF8Unsafe(cfg->font_pack_dir));
    }

    if (pack_requested && pack_files.empty()) {
      LOG(ERROR)
          << "Lobium: configured Windows font pack has no safe loadable files.";
      result = E_FAIL;
      return;
    }
    if (pack_requested && cfg->font_fallback_families.empty()) {
      LOG(ERROR) << "Lobium: configured Windows font pack has no ordered "
                    "fallback family inventory.";
      result = E_FAIL;
      return;
    }

    HRESULT hr =
        BuildFontSet(factory.Get(), pack_files,
                     /*extra_files=*/{}, &font_set, &registered_pack_faces);
    if (SUCCEEDED(hr)) {
      mswr::ComPtr<IDWriteFontCollection1> collection1;
      hr = factory->CreateFontCollectionFromFontSet(font_set.Get(),
                                                    &collection1);
      if (SUCCEEDED(hr)) {
        hr = collection1.As(&collection);
      }
    }
    if (SUCCEEDED(hr) && pack_requested && registered_pack_faces == 0) {
      hr = E_FAIL;
    }
    if (FAILED(hr)) {
      LOG(ERROR) << (pack_requested ? "Lobium: configured Windows font pack "
                                      "could not be fully registered."
                                    : "Lobium: restricted Windows system font "
                                      "set could not be built.");
      font_set.Reset();
      collection.Reset();
      registered_pack_faces = 0;
      result = hr;
      return;
    }
    hr =
        BuildRestrictedFontFallback(factory.Get(), collection.Get(), &fallback);
    if (FAILED(hr)) {
      LOG(ERROR) << "Lobium: restricted Windows character fallback could not "
                    "be built.";
      font_set.Reset();
      collection.Reset();
      fallback.Reset();
      registered_pack_faces = 0;
      result = hr;
      return;
    }
    result = S_OK;
  }

  HRESULT result = E_FAIL;
  UINT32 registered_pack_faces = 0;
  mswr::ComPtr<IDWriteFactory3> factory;
  mswr::ComPtr<IDWriteFontSet> font_set;
  mswr::ComPtr<IDWriteFontCollection> collection;
  mswr::ComPtr<IDWriteFontFallback> fallback;
};

CachedMergedFonts &MergedFonts(IDWriteFactory3 *factory) {
  // The callers create DWRITE_FACTORY_TYPE_SHARED factories. The cache also
  // retains every returned immutable object, so later consumers receive the
  // exact same process-lifetime font snapshot.
  static base::NoDestructor<CachedMergedFonts> cached(factory);
  return *cached;
}

} // namespace

HRESULT GetCachedMergedFontSet(IDWriteFactory3 *factory,
                               IDWriteFontSet **font_set,
                               UINT32 *registered_pack_faces) {
  if (!factory || !font_set) {
    return E_INVALIDARG;
  }
  *font_set = nullptr;
  CachedMergedFonts &cached = MergedFonts(factory);
  if (registered_pack_faces) {
    *registered_pack_faces = cached.registered_pack_faces;
  }
  if (FAILED(cached.result)) {
    return cached.result;
  }
  return cached.font_set.CopyTo(font_set);
}

HRESULT GetCachedMergedFontCollection(IDWriteFactory3 *factory,
                                      IDWriteFontCollection **collection,
                                      UINT32 *registered_pack_faces,
                                      IDWriteFactory3 **owning_factory) {
  if (!factory || !collection) {
    return E_INVALIDARG;
  }
  *collection = nullptr;
  CachedMergedFonts &cached = MergedFonts(factory);
  if (registered_pack_faces) {
    *registered_pack_faces = cached.registered_pack_faces;
  }
  if (owning_factory) {
    *owning_factory = nullptr;
  }
  if (FAILED(cached.result)) {
    return cached.result;
  }
  HRESULT hr = cached.collection.CopyTo(collection);
  if (SUCCEEDED(hr) && owning_factory) {
    hr = cached.factory.CopyTo(owning_factory);
  }
  return hr;
}

HRESULT GetCachedMergedFontFallback(IDWriteFactory3 *factory,
                                    IDWriteFontFallback **fallback) {
  if (!factory || !fallback) {
    return E_INVALIDARG;
  }
  *fallback = nullptr;
  CachedMergedFonts &cached = MergedFonts(factory);
  if (FAILED(cached.result)) {
    return cached.result;
  }
  return cached.fallback.CopyTo(fallback);
}

std::optional<std::string> GetVisibleLocalizedFontName(
    IDWriteFactory3 *factory,
    std::string_view family,
    std::string_view locale) {
  if (!factory || !FontFamilyAllowed(family)) {
    return std::nullopt;
  }
  for (const std::string &alias : ConfiguredFontAliasFamilies()) {
    if (base::EqualsCaseInsensitiveASCII(alias, family)) {
      // CSS aliases have no fabricated proprietary face metadata. Returning
      // the input without touching DirectWrite makes an installed same-name
      // host face indistinguishable from an absent one.
      return std::string(family);
    }
  }

  mswr::ComPtr<IDWriteFontCollection> collection;
  if (FAILED(GetCachedMergedFontCollection(factory, &collection))) {
    return std::nullopt;
  }

  UINT32 family_index = 0;
  BOOL family_exists = FALSE;
  const std::wstring family_wide = base::UTF8ToWide(family);
  if (FAILED(collection->FindFamilyName(family_wide.c_str(), &family_index,
                                        &family_exists)) ||
      !family_exists) {
    return std::nullopt;
  }

  mswr::ComPtr<IDWriteFontFamily> font_family;
  mswr::ComPtr<IDWriteLocalizedStrings> names;
  if (FAILED(collection->GetFontFamily(family_index, &font_family)) ||
      FAILED(font_family->GetFamilyNames(&names)) || !names ||
      names->GetCount() == 0) {
    return std::nullopt;
  }

  UINT32 name_index = 0;
  if (!locale.empty()) {
    BOOL locale_exists = FALSE;
    const std::wstring locale_wide = base::UTF8ToWide(locale);
    if (FAILED(names->FindLocaleName(locale_wide.c_str(), &name_index,
                                     &locale_exists)) ||
        !locale_exists) {
      return std::nullopt;
    }
  }

  UINT32 length = 0;
  if (FAILED(names->GetStringLength(name_index, &length))) {
    return std::nullopt;
  }
  std::wstring value(length + 1, L'\0');
  if (FAILED(names->GetString(name_index, value.data(), length + 1))) {
    return std::nullopt;
  }
  value.resize(length);
  return base::WideToUTF8(value);
}

HRESULT CreateMergedFontSetWithExtraFaces(
    IDWriteFactory3 *factory, const std::vector<base::FilePath> &extra_faces,
    IDWriteFontSet **font_set, UINT32 *registered_pack_faces) {
  if (!factory || !font_set) {
    return E_INVALIDARG;
  }
  if (extra_faces.empty()) {
    return GetCachedMergedFontSet(factory, font_set, registered_pack_faces);
  }

  mswr::ComPtr<IDWriteFontSet> cached_set;
  HRESULT hr =
      GetCachedMergedFontSet(factory, &cached_set, registered_pack_faces);
  if (FAILED(hr)) {
    return hr;
  }

  CachedMergedFonts &cached = MergedFonts(factory);
  mswr::ComPtr<IDWriteFontSetBuilder> builder;
  hr = cached.factory->CreateFontSetBuilder(&builder);
  if (FAILED(hr)) {
    return hr;
  }
  hr = AddFontFiles(cached.factory.Get(), builder.Get(), extra_faces,
                    /*strict=*/false,
                    /*registered_faces=*/nullptr);
  if (FAILED(hr)) {
    return hr;
  }
  hr = builder->AddFontSet(cached_set.Get());
  if (FAILED(hr)) {
    return hr;
  }
  return builder->CreateFontSet(font_set);
}

HRESULT CreateMergedFontCollectionWithExtraFaces(
    IDWriteFactory3 *factory, const std::vector<base::FilePath> &extra_faces,
    IDWriteFontCollection **collection, UINT32 *registered_pack_faces,
    IDWriteFactory3 **owning_factory) {
  if (!factory || !collection) {
    return E_INVALIDARG;
  }
  if (extra_faces.empty()) {
    return GetCachedMergedFontCollection(factory, collection,
                                         registered_pack_faces, owning_factory);
  }

  mswr::ComPtr<IDWriteFontSet> font_set;
  HRESULT hr = CreateMergedFontSetWithExtraFaces(
      factory, extra_faces, &font_set, registered_pack_faces);
  if (FAILED(hr)) {
    return hr;
  }
  CachedMergedFonts &cached = MergedFonts(factory);
  mswr::ComPtr<IDWriteFontCollection1> collection1;
  hr = cached.factory->CreateFontCollectionFromFontSet(font_set.Get(),
                                                       &collection1);
  if (FAILED(hr)) {
    return hr;
  }
  mswr::ComPtr<IDWriteFontCollection> base_collection;
  hr = collection1.As(&base_collection);
  if (SUCCEEDED(hr)) {
    hr = base_collection.CopyTo(collection);
  }
  if (SUCCEEDED(hr) && owning_factory) {
    hr = cached.factory.CopyTo(owning_factory);
  }
  return hr;
}

#endif // BUILDFLAG(IS_WIN)

} // namespace lobium
