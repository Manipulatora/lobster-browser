/**
 * navigator.gpu adapter identity, derived from the persona's WebGL renderer.
 *
 * WHY DERIVED RATHER THAN STORED. WebGPU and WebGL are two independent descriptions of the same
 * physical GPU, and a page reads both in two calls. If the catalog carried them as separate fields
 * they could drift — a persona claiming a GeForce in WebGL and an Intel iGPU in WebGPU is a harder
 * tell than either surface being honest. Deriving one from the other makes disagreement impossible
 * by construction.
 *
 * The token vocabulary is Dawn's own: `adapter.info.vendor` is a lowercase vendor slug and
 * `architecture` is a lowercase GPU-family slug, not marketing names. Chrome exposes only vendor,
 * architecture, subgroup sizes and isFallbackAdapter by default; device/description/driver appear
 * with WebGPU developer features enabled, so they are provided too.
 */

import type { WebGlFingerprint } from '@lobster/shared-types';

export interface WebGpuIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  driver: string;
  /** Drives adapter.isFallbackAdapter, which is true only for a CPU adapter. */
  adapterType: 'discrete' | 'integrated' | 'cpu';
}

/**
 * GPU family slugs, matched against the renderer string most-specific-first.
 *
 * These follow Dawn's `architecture` vocabulary. Anything unmatched falls back to a vendor-level
 * default rather than inventing a family — reporting an architecture the vendor never shipped is
 * worse than reporting a generic one.
 */
const ARCHITECTURES: ReadonlyArray<readonly [RegExp, string]> = [
  // NVIDIA
  // 'lovelace', not 'ada-lovelace': Dawn's name for the Ada generation is the bare codename.
  [/RTX\s*40\d\d/i, 'lovelace'],
  [/RTX\s*30\d\d/i, 'ampere'],
  [/RTX\s*20\d\d|GTX\s*16\d\d/i, 'turing'],
  [/GTX\s*10\d\d/i, 'pascal'],
  [/GTX\s*9\d\d/i, 'maxwell'],
  // AMD
  [/RX\s*7\d\d\d/i, 'rdna-3'],
  [/RX\s*6\d\d\d/i, 'rdna-2'],
  [/RX\s*5\d\d\d/i, 'rdna-1'],
  [/Vega/i, 'gcn-5'],
  // Intel. There is no 'xe' architecture in Dawn's vocabulary, and the two parts that were folded
  // under it are different generations: Iris Xe is Tiger Lake (Gen 12 LP), Arc is DG2 (Gen 12 HP).
  [/Arc\s/i, 'gen-12hp'],
  [/Iris\s+Xe/i, 'gen-12lp'],
  [/UHD\s+Graphics|HD\s+Graphics/i, 'gen-9'],
  // Apple. Apple GPUs report no Metal deviceID, so Dawn cannot pattern-match them and instead
  // reports the highest supported family: on macOS 13+ - which is every Mac that runs Chrome 152 -
  // that is 'metal-3'. There is no 'apple-silicon' anywhere in Dawn.
  [/Apple\s+M\d+/i, 'metal-3'],
];

/** Vendor slug plus the architecture used when no family pattern matches. */
const VENDORS: ReadonlyArray<readonly [RegExp, string, string]> = [
  // The fallback is the EMPTY STRING, not 'unknown'. Dawn's generated GetArchitectureName returns
  // "" for an architecture it cannot resolve (and GetVendorName likewise for an unknown vendor), so
  // a literal 'unknown' is a value no WebGPU adapter has ever reported - it identifies the product
  // rather than hiding it. An empty architecture is both truthful and common on real hardware.
  [/NVIDIA/i, 'nvidia', ''],
  [/AMD|ATI\s+Technologies|Radeon/i, 'amd', ''],
  [/Intel/i, 'intel', 'gen-9'],
  [/Apple/i, 'apple', 'metal-3'],
  // Dawn's vendor name_override collapses QualcommPCI/QualcommACPI to 'qualcomm'; its architecture
  // names are adreno-4xx..adreno-8xx, never a bare 'adreno'.
  [/Qualcomm|Adreno/i, 'qualcomm', ''],
  // ARM's architectures are midgard/bifrost/valhall - 'mali' is the product family, not an arch.
  [/ARM|Mali/i, 'arm', ''],
  // Microsoft's software adapter is WARP; 'swiftshader' is Google's, a different vendor entirely.
  [/Microsoft|WARP/i, 'microsoft', 'warp'],
];

/** Pull the human-readable device name out of an ANGLE renderer string. */
function deviceNameFrom(renderer: string): string {
  // "ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 (0x00002503), D3D11-31.0.15.3179)" -> the middle field.
  const angle = /^ANGLE \(([^,]+),\s*(.+?)(?:,\s*[^,]*)?\)$/.exec(renderer);
  const raw = angle ? angle[2]! : renderer;
  return raw
    .replace(/ANGLE Metal Renderer:\s*/i, '')
    .replace(/\s*\(0x[0-9a-fA-F]+\)/, '')
    .replace(/\s+(Direct3D11|OpenGL|Vulkan)\b.*$/i, '')
    .replace(/\s+vs_\d+_\d+.*$/i, '')
    .trim();
}

/** Extract the PCI device id if the renderer string carries one, else synthesise a stable one. */
function deviceIdFrom(renderer: string): string {
  const hex = /\(0x([0-9a-fA-F]{4,8})\)/.exec(renderer);
  if (hex) {
    const v = hex[1]!.toLowerCase().padStart(4, '0');
    return `0x${v.length > 4 ? v.padStart(8, '0') : v}`;
  }
  // Chrome formats the id as 0x%04x / 0x%08x. Derive a stable pseudo-id from the renderer so it does
  // not change between launches of the same persona.
  let h = 2166136261 >>> 0;
  for (let i = 0; i < renderer.length; i += 1) {
    h ^= renderer.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return `0x${(h & 0xffff).toString(16).padStart(4, '0')}`;
}

/** Build the WebGPU adapter identity that matches a persona's WebGL renderer. */
export function webgpuIdentityFor(webgl: WebGlFingerprint): WebGpuIdentity {
  const renderer = webgl.unmaskedRenderer || webgl.renderer;

  let vendor = 'unknown';
  let architecture = 'unknown';
  for (const [re, slug, fallbackArch] of VENDORS) {
    if (re.test(renderer)) {
      vendor = slug;
      architecture = fallbackArch;
      break;
    }
  }
  for (const [re, slug] of ARCHITECTURES) {
    if (re.test(renderer)) {
      architecture = slug;
      break;
    }
  }

  const description = deviceNameFrom(renderer);
  // Integrated parts are the Intel HD/UHD/Iris families and Apple Silicon (unified memory); a
  // discrete card reporting "integrated" (or the reverse) contradicts its own model name.
  const integrated = /Intel|Apple\s+M\d|Iris|UHD|HD Graphics/i.test(renderer);

  return {
    vendor,
    architecture,
    device: deviceIdFrom(renderer),
    description,
    // A short vendor-consistent driver label, not the ANGLE renderer blob. Empty for vendors whose
    // Chrome builds report nothing here — inventing a driver string for Intel or Apple would add a
    // value no real adapter emits, which is worse than the honest empty string.
    driver: vendor === 'nvidia' ? 'NVIDIA' : vendor === 'amd' ? 'AMD proprietary driver' : '',
    adapterType: integrated ? 'integrated' : 'discrete',
  };
}

/**
 * Return the two page-visible GPU identities as one inseparable update.
 *
 * Renderer policy can replace WebGL after the seed-selected catalog identity has already been built
 * (host calibration, normalized-host mode, a validated preset, or a legacy override). Callers must
 * replace WebGPU in the same object spread or the two APIs name different cards.
 */
export function coherentGpuIdentity(webgl: WebGlFingerprint): {
  webgl: WebGlFingerprint;
  webgpu: WebGpuIdentity;
} {
  return { webgl, webgpu: webgpuIdentityFor(webgl) };
}

/** True only when every configured WebGPU identity field is the value derived from this WebGL GPU. */
export function webgpuIdentityMatches(
  webgl: WebGlFingerprint,
  webgpu: WebGpuIdentity | undefined,
): boolean {
  if (!webgpu) return false;
  const expected = webgpuIdentityFor(webgl);
  return (
    webgpu.vendor === expected.vendor &&
    webgpu.architecture === expected.architecture &&
    webgpu.device === expected.device &&
    webgpu.description === expected.description &&
    webgpu.driver === expected.driver &&
    webgpu.adapterType === expected.adapterType
  );
}
