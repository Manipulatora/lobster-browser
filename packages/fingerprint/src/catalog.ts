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
  // A pci.ids parser artifact left thousands of NVIDIA labels ending in `]`, which then appeared in
  // both the UI and the page-visible ANGLE renderer string.
  return label.replace(/\]+\s*$/, '').trim();
}

function productEligibleModel(label: string): boolean {
  const clean = cleanModelLabel(label);
  if (/Engineering Sample|Mining|Crypto|Emulator|Virtual/i.test(clean)) return false;
  return /(?:GeForce\s+(?:RTX|GTX)\s+(?:10|16|20|30|40|50)\d|(?:Quadro\s+|NVIDIA\s+)?RTX\s+[2-6]\d|Radeon\s+(?:RX|Pro|Vega)|Intel(?:\(R\))?\s+(?:Arc|Iris|UHD|HD Graphics [56]))/i.test(
    clean,
  );
}

function normalizePreset(entry: RendererCatalogEntry): ProductRendererCatalogEntry {
  const label = cleanModelLabel(entry.label);
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

// Intel Macs and Apple Silicon have a closed hardware matrix; keep their sourced models, while still
// normalizing any parser artifacts and declaring the limited validation scope honestly.
export const MACOS_INTEL_RENDERER_PRESETS = RAW_MACOS_INTEL_RENDERER_PRESETS.map(normalizePreset);
export const MACOS_ARM_RENDERER_PRESETS = RAW_MACOS_ARM_RENDERER_PRESETS.map(normalizePreset);

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
