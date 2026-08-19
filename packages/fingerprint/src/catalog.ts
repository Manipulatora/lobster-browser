/**
 * Product-facing catalog facade.
 *
 * The generated PCI catalog proves that a model/device ID exists; it does NOT prove that every device
 * can run current Chromium or that the synthesized ANGLE string/capability bucket was captured from
 * that exact GPU. Keep the raw generated arrays for provenance/audits, but expose only contemporary,
 * syntactically clean desktop choices to profile UI consumers.
 */
import {
  LINUX_RENDERER_PRESETS as RAW_LINUX_RENDERER_PRESETS,
  MACOS_ARM_RENDERER_PRESETS as RAW_MACOS_ARM_RENDERER_PRESETS,
  MACOS_INTEL_RENDERER_PRESETS as RAW_MACOS_INTEL_RENDERER_PRESETS,
  WINDOWS_RENDERER_PRESETS as RAW_WINDOWS_RENDERER_PRESETS,
  type RendererCatalogEntry,
} from './catalog.generated.js';

export type ProductRendererCatalogEntry = Omit<RendererCatalogEntry, 'validationLevel'> & {
  /**
   * The upstream source proves only that the model/device ID exists. It is not a captured browser
   * fingerprint and therefore cannot satisfy RendererPolicy `validated_preset`.
   */
  validationLevel: 'model_source_only';
  /** Honest scope: the source verifies the model/device ID, not an exact browser surface capture. */
  validationScope: 'model_device_id_only';
};

export type FullCaptureRendererCatalogEntry = Omit<RendererCatalogEntry, 'validationLevel'> & {
  validationLevel: 'full_browser_capture';
  validationScope: 'full_browser_surface_capture';
  capturedAt: string;
  browserVersion: string;
  captureSha256: string;
};

function cleanModelLabel(label: string): string {
  // pci.ids names a GPU as `<codename> [<marketing name>]` — "Intel(R) Coffee Lake-U GT3e [Iris Plus
  // Graphics 655]". A driver reports only the marketing half, so keep the vendor prefix and that half
  // and drop the codename: an "Intel(R) Alder Lake-UP4 GT2" renderer string is not one any machine has
  // ever produced. Stripping the trailing `]` alone (which is where this started, as a parser artifact
  // that reached the page-visible ANGLE string) left the OPENING bracket behind — worse than either.
  const bracketed = /^(\S+?)(?:\(R\))?\s+.*\[([^\]]+)\]?\s*$/.exec(label);
  if (bracketed) {
    const vendor = bracketed[1] ?? '';
    const model = (bracketed[2] ?? '').trim();
    // "Intel(R) Meteor Lake-P [Intel Arc Graphics]" already names its vendor inside the bracket.
    const prefixed = model.toLowerCase().startsWith(vendor.toLowerCase())
      ? model
      : `${label.slice(0, label.indexOf(' '))} ${model}`;
    return dropCodenameSuffix(prefixed);
  }
  return dropCodenameSuffix(label.replace(/\]+\s*$/, '').trim());
}

/** pci.ids appends the silicon generation to some model names ("Iris Plus Graphics G7 (Ice Lake)"). */
function dropCodenameSuffix(label: string): string {
  return label.replace(/\s*\([^)]*Lake[^)]*\)\s*$/i, '').trim();
}

/**
 * GPUs Apple actually shipped in an Intel Mac (2013–2020). The sourced macOS catalog is a general PC
 * PCI list: it carries Alder Lake iGPUs and Radeon Pro W7900 workstation cards, none of which has ever
 * been behind a Metal driver. "ANGLE Metal Renderer: Intel(R) Iris Xe Graphics" names a pairing that
 * cannot exist, which is a stronger signal than the honest GPU it replaced.
 */
function macEligibleModel(label: string): boolean {
  if (/^Apple\b/.test(label)) return true;
  if (
    /^Intel\(R\) (?:HD Graphics (?:4000|5000|515|530|615|6000|6100)|UHD Graphics (?:617|630)|Iris Graphics (?:540|550|6100)|Iris Pro Graphics (?:5200|6200|580)|Iris Plus Graphics (?:640|645|650|655|G4|G7))\b/.test(
      label,
    )
  ) {
    return true;
  }
  return /^AMD Radeon (?:Pro (?:5[567]0X?\b|580X?\b|5300M|5500M|5600M|5700(?: XT)?\b|W5500X|W5700X|W6800X|W6900X|Vega (?:16|20|48|56|64X?|II))|R9 M(?:290X|295X|370X|380|390|395X?)\b)/.test(
    label,
  );
}

/**
 * Metal reports the chip, not the configuration: a 7-core-GPU M1 and an 8-core-GPU M1 both answer
 * "Apple M1". The catalog carries the SKU rows, so collapse them or every third Apple persona claims a
 * renderer string macOS cannot produce.
 */
function collapseAppleSku(label: string): string {
  return label.replace(/\s+\d+-Core GPU$/, '');
}

function productEligibleModel(label: string): boolean {
  const clean = cleanModelLabel(label);
  if (/Engineering Sample|Mining|Crypto|Emulator|Virtual/i.test(clean)) return false;
  return /(?:GeForce\s+(?:RTX|GTX)\s+(?:10|16|20|30|40|50)\d|(?:Quadro\s+|NVIDIA\s+)?RTX\s+[2-6]\d|Radeon\s+(?:RX|Pro|Vega)|Intel(?:\(R\))?\s+(?:Arc|Iris|UHD|HD Graphics [56]))/i.test(
    clean,
  );
}

function normalizePreset(entry: RendererCatalogEntry): ProductRendererCatalogEntry {
  const label = collapseAppleSku(cleanModelLabel(entry.label));
  const renderer = entry.webgl.renderer.replace(entry.label, label);
  const unmaskedRenderer = entry.webgl.unmaskedRenderer.replace(entry.label, label);
  return {
    ...entry,
    label,
    validationLevel: 'model_source_only',
    validationScope: 'model_device_id_only',
    webgl: { ...entry.webgl, renderer, unmaskedRenderer },
  };
}

function productPresets(entries: readonly RendererCatalogEntry[]): ProductRendererCatalogEntry[] {
  return entries.filter((entry) => productEligibleModel(entry.label)).map(normalizePreset);
}

export const WINDOWS_RENDERER_PRESETS = productPresets(RAW_WINDOWS_RENDERER_PRESETS);
export const LINUX_RENDERER_PRESETS = productPresets(RAW_LINUX_RENDERER_PRESETS);

// Apple's hardware matrix is closed, so the filter here is an allowlist of what it contains rather than
// the model-shape heuristic the PC lists use, and the SKU rows collapse onto the names Metal reports.
function macPresets(entries: readonly RendererCatalogEntry[]): ProductRendererCatalogEntry[] {
  const byRenderer = new Map<string, ProductRendererCatalogEntry>();
  for (const entry of entries.map(normalizePreset)) {
    if (!macEligibleModel(entry.label)) continue;
    if (!byRenderer.has(entry.webgl.renderer)) byRenderer.set(entry.webgl.renderer, entry);
  }
  return [...byRenderer.values()];
}

export const MACOS_INTEL_RENDERER_PRESETS = macPresets(RAW_MACOS_INTEL_RENDERER_PRESETS);
export const MACOS_ARM_RENDERER_PRESETS = macPresets(RAW_MACOS_ARM_RENDERER_PRESETS);

/**
 * Intentionally empty until exact browser-surface captures are checked in with provenance. PCI IDs and
 * synthesized ANGLE strings are not promoted into this list.
 */
export const VALIDATED_RENDERER_PRESETS: readonly FullCaptureRendererCatalogEntry[] = [];

export function resolveValidatedRendererPreset(
  presetId: string,
): FullCaptureRendererCatalogEntry | undefined {
  return VALIDATED_RENDERER_PRESETS.find((preset) => preset.id === presetId);
}

/** Resolve a product-visible, source-backed GPU model preset from the restored catalog. */
export function resolveSourcedRendererPreset(
  presetId: string,
): ProductRendererCatalogEntry | undefined {
  return [
    ...WINDOWS_RENDERER_PRESETS,
    ...MACOS_INTEL_RENDERER_PRESETS,
    ...MACOS_ARM_RENDERER_PRESETS,
    ...LINUX_RENDERER_PRESETS,
  ].find((preset) => preset.id === presetId);
}
