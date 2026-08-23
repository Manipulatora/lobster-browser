import type {
  CpuArch,
  EngineKind,
  Fingerprint,
  FingerprintSeed,
  NavigatorFingerprint,
  OsFamily,
  ScreenFingerprint,
  WebGlFingerprint,
} from '@lobster/shared-types';
import { SeededRandom } from './prng.js';
import { languagesToAcceptLanguage } from './coherence.js';
import { buildChromeBrands, ENGINE_CHROME, chromeVersionForms, DEVICE_TEMPLATES } from './pools.js';
import { deriveCoherentDevice } from './device-tiers.js';
import { defaultFontsForOs } from './defaults.js';
import {
  isAppleSiliconRenderer,
  webgl1ExtensionsFor,
  webgl2ExtensionsFor,
} from './webgl-extensions.js';
import { coherentGpuIdentity } from './webgpu-identity.js';

export interface DeriveOptions {
  os: OsFamily;
  /** Product engine. Kept in the API so all callers explicitly bind derivation to Lobium. */
  engine: EngineKind;
  arch?: CpuArch;
  /**
   * The full Chrome build the running engine actually is (e.g. "152.0.7977.42"). The UA version MUST
   * match the engine or a feature-probe / fullVersionList read catches it as a lie, so this is pinned
   * to the engine — never a random pool. Defaults to the Lobium build ({@link ENGINE_CHROME}).
   */
  browserVersion?: string;
}

/**
 * Derive a coherent Chrome fingerprint from a seed, using Lobster's OWN internal device catalog
 * (pools.ts) — no third-party fingerprint-generation API. Deterministic: the same (seed, os) always
 * produces the same fingerprint (a profile's identity is stable across restarts), while different
 * seeds select distinct-but-coherent device classes.
 *
 * Realism comes from curated device CLASSES, not random field-mixing: a seed picks one whole
 * {@link DeviceProfile} (GPU + screen + cores + memory bundled as a real machine), so no field can
 * drift out of its device's plausible range.
 *
 * Locale/timezone default to en-US and are meant to be overwritten by {@link applyGeoToFingerprint}
 * once the proxy exit IP is known — the network identity is applied as an overlay ON TOP of this base
 * device identity, never mixed into device generation.
 */
export function deriveFingerprint(seed: FingerprintSeed, opts: DeriveOptions): Fingerprint {
  const { os, arch = 'x86_64', browserVersion } = opts;
  return deriveFromPools(seed, os, arch, browserVersion);
}

function buildUserAgent(osToken: string, reducedVersion: string): string {
  return `Mozilla/5.0 (${osToken}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${reducedVersion} Safari/537.36`;
}

// Chrome derives the brand list (decoy token AND order) from the UA major; see buildChromeBrands.
// Never hardcode it — the GREASE spelling rotates every release and a stale one is a free tell.
function buildBrands(major: string): NavigatorFingerprint['uaBrands'] {
  return buildChromeBrands(major);
}

/**
 * Deterministically derive a coherent fingerprint by selecting ONE device class from the OS's catalog
 * and one Chrome version, both seeded. Every catalog entry is itself coherent, so the result always
 * passes validateFingerprintCoherence. Exported so tests can assert that guarantee and the seed→device
 * determinism/diversity directly.
 */
export function deriveFromPools(
  seed: FingerprintSeed,
  os: OsFamily,
  arch: CpuArch,
  browserVersion?: string,
): Fingerprint {
  const tpl = DEVICE_TEMPLATES[os];
  const device = deriveDevicePersona(seed, { os, arch });
  // The Chrome version is NOT seed-diverse — it is pinned to the running engine (all profiles share one
  // binary), so the UA never contradicts a feature-probe or the fullVersionList high-entropy read. The UA
  // string carries the reduced form (major.0.0.0); uaFullVersion carries the real build, as Chrome 152 does.
  const ver = chromeVersionForms(browserVersion ?? ENGINE_CHROME.full);

  const primaryLocale = 'en-US';
  const languages = [primaryLocale, 'en'];

  const navigator: NavigatorFingerprint = {
    userAgent: buildUserAgent(tpl.osToken, ver.reduced),
    platform: tpl.platform,
    languages,
    hardwareConcurrency: device.hardwareConcurrency,
    deviceMemory: device.deviceMemory,
    maxTouchPoints: 0,
    uaBrands: buildBrands(ver.major),
    uaPlatform: tpl.uaPlatform,
    uaPlatformVersion: tpl.uaPlatformVersion,
    uaMobile: false,
    uaFullVersion: ver.full,
    uaFormFactor: 'Desktop',
  };

  // Build the final WebGL object first. Renderer-policy paths use the same atomic helper whenever
  // they replace it, so navigator.gpu can never retain the identity of an earlier catalog card.
  const webgl: WebGlFingerprint = {
    ...device.webgl,
    version: 'WebGL 1.0 (OpenGL ES 2.0 Chromium)',
    shadingLanguageVersion: 'WebGL GLSL ES 1.0 (OpenGL ES GLSL ES 1.0 Chromium)',
    extensions: webgl1ExtensionsFor(os, {
      appleSilicon: isAppleSiliconRenderer(device.webgl.renderer),
    }),
    extensions2: webgl2ExtensionsFor(os, {
      appleSilicon: isAppleSiliconRenderer(device.webgl.renderer),
    }),
  };

  return {
    os,
    arch: device.arch,
    navigator,
    screen: device.screen,
    // The deep WebGL surfaces, not just vendor/renderer/caps. Without these four the engine falls
    // back to the HOST for version, GLSL version and the extension list — so a persona claiming one
    // GPU shipped another GPU's extension set, which is precisely the cross-check a detector runs.
    //
    // VERSION and SHADING_LANGUAGE_VERSION are Chromium's own constants, identical on every desktop
    // platform and GPU (they describe the WebGL/GLSL level, not the driver), so pinning them costs
    // no plausibility and removes any backend-dependent variance — notably a software renderer,
    // which would otherwise report a different string here than the persona's GPU implies.
    ...coherentGpuIdentity(webgl),
    locale: {
      timezone: 'America/New_York',
      locale: primaryLocale,
      acceptLanguage: languagesToAcceptLanguage(languages),
    },
    // NOT `tpl.fonts`. The pools carry raw catalog rows, and a persona built from them claimed
    // things no machine has: macOS advertised 2,565 "families" including documentation artefacts
    // like `Academy Engraved LET Plain:1.0 16.0d1e1` and a bare `Accessories`, Windows advertised
    // 506 entries of which ~300 were style faces (`Angsana New Bold Italic`) rather than families,
    // and Linux advertised 7. A page enumerating fonts is doing exactly this measurement, so a hit
    // on `Accessories` is not a small inaccuracy — it is a globally unique marker that no real
    // machine produces. `defaultFontsForOs` is the curated per-OS set and was already correct; it
    // simply was not what derivation used.
    fonts: device.fonts,
  };
}

/**
 * The machine a seed describes: GPU, panel + scaling, cores, memory and fonts, before any browser or
 * network identity is layered on.
 *
 * This is the value the profile UI shows as the default device. Showing it is only half the point —
 * the other half is that the UI must then NOT write those values into `fingerprintOverrides`. A profile
 * whose overrides pin the screen, cores, memory and GPU it was shown is a profile whose device stops
 * being seed-derived, which is how every profile created with default settings ended up describing the
 * same machine and differing only in its farble seed. Overrides are for values the user deliberately
 * changed; everything else stays derived here, at launch, from the seed.
 */
export interface DerivedDevicePersona {
  os: OsFamily;
  /** Implied by the GPU, not chosen: an "Apple M<n>" renderer is arm64, everything else x86_64. */
  arch: CpuArch;
  /** Stable id of the selected machine (catalog entry or generated pairing); never page-visible. */
  deviceId: string;
  /**
   * The sourced GPU preset behind this device, present when the seed drew from the generated catalog.
   * It is the id the UI's renderer picker uses, so "pin the derived GPU" is a lossless choice.
   */
  rendererPresetId?: string;
  /** GPU model for display, e.g. "NVIDIA GeForce RTX 4070". */
  gpuLabel: string;
  webgl: WebGlFingerprint;
  screen: ScreenFingerprint;
  hardwareConcurrency: number;
  deviceMemory: number;
  fonts: string[];
}

export interface DeriveDeviceOptions {
  os: OsFamily;
  arch?: CpuArch;
}

/**
 * Select the whole machine a seed maps to. Deterministic for a given (seed, os, arch) and shared with
 * {@link deriveFromPools}, so what the profile UI previews is byte-for-byte what launches.
 */
export function deriveDevicePersona(
  seed: FingerprintSeed,
  opts: DeriveDeviceOptions,
): DerivedDevicePersona {
  const { os, arch = 'x86_64' } = opts;
  const rng = new SeededRandom(seed);
  const tpl = DEVICE_TEMPLATES[os];

  // Pick a whole machine (GPU + screen + cores + memory stay a coherent set).
  // Diversity: draw from the sourced renderer catalog (hundreds of real, current GPUs per OS) paired with
  // tier-coherent hardware (device-tiers.ts), so every seed can land on a distinct real machine. A ~15%
  // share still draws the curated flagship pool so popular exact machines stay well-represented, and it is
  // the fallback when a catalog is empty for an OS/arch. Both sources yield a coherent whole device, so the
  // result still always passes validateFingerprintCoherence.
  const macCandidates =
    os === 'macos'
      ? tpl.devices.filter((device) => deviceArchFromRenderer(device.webgl.renderer) === arch)
      : tpl.devices;
  const flagship = () => rng.pick(macCandidates.length > 0 ? macCandidates : tpl.devices);
  const generated = rng.int(0, 99) >= 15 ? deriveCoherentDevice(rng, os, arch) : null;
  const device = generated ?? flagship();

  // Architecture is a PROPERTY OF THE PICKED DEVICE, not a free parameter: an Apple-Silicon Mac (Metal
  // renderer "Apple M<n>") is arm64, and every other catalog device (Windows/Linux/Intel-Mac GPUs) is
  // x86_64. Deriving it from the GPU keeps Sec-CH-UA-Arch coherent with the WebGL renderer — otherwise an
  // "Apple M2 Pro" persona reporting arch=x86 is a glaring cross-check tell (FP-3). The `arch` option is
  // a REQUEST (it selects the macOS candidate pool); the device is authoritative (there is no
  // ARM-Windows device).
  const deviceArch = deviceArchFromRenderer(device.webgl.renderer);

  // Available rect = screen minus OS chrome, laid out per-OS so screen.availTop is COHERENT with the
  // claimed platform: macOS reserves a top menu bar (~25px, dock auto-hidden), so availTop=25 and the
  // deficit is at the TOP; Windows/Linux reserve a bottom taskbar (~40px), so availTop=0 and the deficit
  // is at the bottom. (A Mac persona reporting availTop=0 with availHeight<height is a detectable tell —
  // the missing pixels would imply a bottom dock and no menu bar, impossible on default macOS.)
  const menuBarTop = os === 'macos' ? 25 : 0;
  // Windows 11's taskbar is 48 CSS px, not Windows 10's 40 - and this persona announces Windows 11
  // (pools.ts sets uaPlatformVersion 15.0.0, which is the UniversalApiContract version Chromium
  // reports for Win11 22H2/23H2). A 1920x1080 Win11 persona was reporting availHeight 1040 where a
  // real machine reports 1032, next to a platform-version hint that says Windows 11 - two one-line
  // page reads that disagree. The inset is NOT divided by dpr: Windows scales the taskbar with DPI
  // and Chromium converts the shell work rect to DIP (ui/display/win/screen_win.cc), so 48 CSS px
  // holds at 100%, 125% and 150% alike.
  const bottomBar = os === 'macos' ? 0 : os === 'windows' ? 48 : 40;
  // Apple-Silicon MacBooks ship wide-gamut (P3) displays that report a 30-bit colorDepth; every other
  // catalog device is standard 24-bit sRGB. Reporting 24 on a P3 MacBook is a small but real realism
  // miss (M7), so tie colorDepth to the device like arch.
  const colorDepth = deviceArch === 'arm64' ? 30 : 24;

  return {
    os,
    arch: deviceArch,
    deviceId: device.id,
    ...('presetId' in device ? { rendererPresetId: device.presetId } : {}),
    gpuLabel: 'label' in device ? device.label : gpuModelLabel(device.webgl.renderer),
    webgl: device.webgl,
    screen: {
      width: device.screen.width,
      height: device.screen.height,
      availWidth: device.screen.width,
      availHeight: device.screen.height - menuBarTop - bottomBar,
      availLeft: 0,
      availTop: menuBarTop,
      colorDepth,
      devicePixelRatio: device.screen.dpr,
    },
    hardwareConcurrency: device.hardwareConcurrency,
    deviceMemory: device.deviceMemory,
    fonts: defaultFontsForOs(os),
  };
}

/** Pull the GPU model out of an ANGLE renderer string for display (the whole string is unreadable). */
function gpuModelLabel(renderer: string): string {
  return (
    /ANGLE Metal Renderer: (.+?), Unspecified Version/.exec(renderer)?.[1] ??
    /ANGLE \([^,]+, (.+?) Direct3D11/.exec(renderer)?.[1] ??
    /ANGLE \([^,]+, (.+?), OpenGL/.exec(renderer)?.[1] ??
    renderer
  );
}

function deviceArchFromRenderer(renderer: string): CpuArch {
  return /Apple M\d/.test(renderer) ? 'arm64' : 'x86_64';
}
