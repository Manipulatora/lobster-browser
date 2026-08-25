import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const read = (relative) => readFile(new URL(`../../${relative}`, import.meta.url), 'utf8');

test('native pack discovery follows the provisioner tree and rejects unsafe partial packs', async () => {
  const source = await read('lobium/src/lobium_fonts.cc');
  assert.match(source, /dir\.AppendASCII\("files"\)/);
  assert.match(source, /FileEnumerator::FILES\s*\|\s*base::FileEnumerator::DIRECTORIES/);
  assert.match(source, /recursive=\*\/true/);
  assert.match(source, /FolderSearchPolicy::ALL/);
  assert.match(source, /ErrorPolicy::STOP_ENUMERATION/);
  assert.match(source, /FILE_ATTRIBUTE_REPARSE_POINT/);
  assert.match(source, /it\.GetError\(\)\s*!=\s*base::File::FILE_OK/);
  assert.match(source, /MatchesFinalExtension\(FILE_PATH_LITERAL\("\.ttf"\)\)/);
  assert.match(source, /MatchesFinalExtension\(FILE_PATH_LITERAL\("\.ttc"\)\)/);
  assert.match(source, /MatchesFinalExtension\(FILE_PATH_LITERAL\("\.otf"\)\)/);
  assert.doesNotMatch(source, /MatchesFinalExtension\(FILE_PATH_LITERAL\("\.otc"\)\)/);
});

test('the cached DirectWrite snapshot is restricted, fail-closed, and owns its factory', async () => {
  const source = await read('lobium/src/lobium_fonts.cc');
  assert.match(source, /GetPropertyValues\(\s*index,\s*DWRITE_FONT_PROPERTY_ID_FAMILY_NAME/);
  assert.match(source, /FontFamilyAllowed\(/);
  assert.match(source, /GetFontFaceReference\(index,\s*&face\)/);
  assert.match(source, /builder->AddFontFaceReference\(face\.Get\(\)\)/);
  assert.match(source, /Analyze\(&supported,[\s\S]*!supported\s*\|\|\s*face_count\s*==\s*0/);
  assert.match(source, /pack_requested\s*&&\s*pack_files\.empty\(\)/);
  assert.match(source, /registered_pack_faces\s*==\s*0/);
  assert.match(source, /struct CachedMergedFonts[\s\S]*ComPtr<IDWriteFactory3> factory/);
  assert.match(source, /ComPtr<IDWriteFontSet> font_set/);
  assert.match(source, /ComPtr<IDWriteFontCollection> collection/);
  assert.match(source, /ComPtr<IDWriteFontFallback> fallback/);
  assert.match(source, /cached\.factory->CreateFontSetBuilder/);
  assert.match(source, /cached\.factory\.CopyTo\(owning_factory\)/);
  assert.doesNotMatch(source, /kAlwaysAllowed/);
  const buildStart = source.indexOf('HRESULT BuildFontSet');
  const buildEnd = source.indexOf('HRESULT BuildRestrictedFontFallback', buildStart);
  assert.ok(buildStart >= 0 && buildEnd > buildStart, 'restricted font-set builder is present');
  const build = source.slice(buildStart, buildEnd);
  assert.match(build, /if \(pack_files\.empty\(\)\)[\s\S]*AddSystemFonts/);
  assert.doesNotMatch(
    build,
    /AddSystemFonts[\s\S]*AddFontFiles\([\s\S]*pack_files[\s\S]*else[\s\S]*AddSystemFonts/,
  );
});

test('character fallback is explicitly mapped to the restricted collection', async () => {
  const source = await read('lobium/src/lobium_fonts.cc');
  const start = source.indexOf('HRESULT BuildRestrictedFontFallback');
  const end = source.indexOf('struct CachedMergedFonts', start);
  assert.ok(start >= 0 && end > start, 'restricted fallback builder is present');
  const fallback = source.slice(start, end);
  assert.match(fallback, /CreateFontFallbackBuilder/);
  assert.match(fallback, /cfg->font_fallback_families/);
  assert.match(fallback, /collection->FindFamilyName/);
  assert.match(fallback, /family_names\.push_back\(requested_wide\)/);
  assert.match(fallback, /DWRITE_UNICODE_RANGE all_unicode\s*=\s*\{0,\s*0x10FFFF\}/);
  assert.match(fallback, /AddMapping\([\s\S]*target_names\.data\(\)[\s\S]*collection/);
  assert.doesNotMatch(fallback, /AddMappings/);
  assert.doesNotMatch(fallback, /GetSystemFontFallback/);
});

test('all M152 Windows consumers use the shared collection and fallback', async () => {
  const [patch, source] = await Promise.all([
    read('lobium/patches/fingerprint/windows-font-isolation.patch'),
    read('lobium/src/lobium_fonts.cc'),
  ]);
  assert.match(patch, /components\/services\/font_data\/font_data_service_impl\.cc/);
  assert.match(patch, /font_policy_active[\s\S]*CHECK\(!font_policy_active\)/);
  assert.match(
    patch,
    /SkFontMgr_New_DirectWrite\([\s\S]*collection\.Get\(\)[\s\S]*fallback\.Get\(\)/,
  );
  assert.match(patch, /components\/services\/font_data\/dwrite_local_font_matcher\.cc/);
  assert.match(patch, /GetCachedMergedFontSet/);
  assert.match(patch, /content\/browser\/font_access\/font_enumeration_data_source_win\.cc/);
  assert.match(patch, /GetCachedMergedFontCollection/);
  assert.match(patch, /content\/browser\/renderer_host\/dwrite_font_proxy_impl_win\.cc/);
  assert.match(patch, /GetCachedMergedFontFallback/);
  assert.match(patch, /font_fallback_->MapCharacters/);
  assert.match(patch, /FontFamilyForMatching\(base::UTF16ToUTF8\(family_name\)\)/);
  assert.match(patch, /content\/common\/font_list_win\.cc/);
  assert.match(patch, /GetCachedMergedFontCollection\(factory3\.Get\(\), &collection\)/);
  assert.match(patch, /FontFamilyAllowed\(\*native_name\)/);
  assert.match(patch, /ConfiguredFontAliasFamilies\(\)[\s\S]*GetFontFamilyCount\(\)/);
  assert.match(patch, /content\/common\/BUILD\.gn/);
  assert.match(patch, /deps \+= \[ "\/\/components\/lobium_fp" \]/);
  assert.match(patch, /chrome\/browser\/extensions\/api\/font_settings\/font_settings_api\.cc/);
  assert.match(patch, /GetVisibleLocalizedFontName\(factory3\.Get\(\), \*font_name/);
  assert.match(
    source,
    /GetVisibleLocalizedFontName[\s\S]*FontFamilyAllowed\(family\)[\s\S]*ConfiguredFontAliasFamilies[\s\S]*return std::string\(family\)[\s\S]*GetCachedMergedFontCollection[\s\S]*FindFamilyName/,
  );
});

test('the launcher verifies, persona-stages, and orders a pack before exposing it to native code', async () => {
  const [fonts, launcher] = await Promise.all([
    read('packages/engine-runner/src/fonts.ts'),
    read('packages/engine-runner/src/runners/lobium-launcher.ts'),
  ]);
  assert.match(fonts, /createHash\('sha256'\)[\s\S]*readFile\(absolute\)/);
  assert.match(fonts, /font pack file ledger mismatch/);
  assert.match(fonts, /entryStat\.isSymbolicLink\(\)/);
  assert.match(fonts, /WINDOWS_FONT_EXTENSIONS\s*=\s*new Set\(\['\.ttf', '\.ttc', '\.otf'\]\)/);
  assert.match(fonts, /export async function stageNativeFontPack/);
  assert.match(fonts, /await verifyFontPackFiles\(fontsBaseDir\)/);
  assert.match(fonts, /exposes families outside the \$\{os\} persona/);
  assert.match(fonts, /native-font-packs/);
  assert.match(fonts, /await verifyStagedNativeFontPack\(temporary/);
  assert.match(launcher, /stageNativeFontPack\(userDataDir, persona, base\)/);
  assert.match(launcher, /ctx\.isMobileProfile \? 'android' : ctx\.fingerprint\.os/);
  assert.match(launcher, /planFontAliases\(fontPersona/);
  assert.match(
    launcher,
    /fontPackDir:\s*fontPack\.dir,[\s\S]*fontAliases,[\s\S]*fontFallbackFamilies:\s*fontPack\.physicalFamilies/,
  );
});

test('the live proof distinguishes transport, aliases, local metadata, and fallback', async () => {
  const gate = await read('ci/validation/font-pack-registration-gate.mjs');
  assert.match(gate, /self\.queryLocalFonts\(\)/);
  assert.match(gate, /userGesture:\s*true/);
  assert.match(gate, /new FontFace/);
  assert.match(gate, /CSS\.getPlatformFontsForNode/);
  assert.match(gate, /Segoe UI Emoji/);
  assert.match(gate, /Noto Color Emoji/);
  assert.match(gate, /metric-compatible CSS aliases/);
  assert.match(gate, /class-fallback residual/);
  assert.match(gate, /fontFallbackFamilies:\s*orderFontFallbackFamilies\('windows'/);
});
