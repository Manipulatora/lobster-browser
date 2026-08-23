import type { Fingerprint, FingerprintOverrides } from '@lobster/shared-types';
import { coherentGpuIdentity } from './webgpu-identity.js';

/**
 * Merge user-editable overrides on top of a seed-derived fingerprint (shallow per section). Used by
 * the sidecar to apply a profile's `fingerprintOverrides` before launch. Returns the input unchanged
 * when there are no overrides.
 */
export function applyOverrides(fp: Fingerprint, overrides?: FingerprintOverrides): Fingerprint {
  if (!overrides) return fp;
  const gpuIdentity = overrides.webgl
    ? coherentGpuIdentity({ ...fp.webgl, ...overrides.webgl })
    : { webgl: fp.webgl, ...(fp.webgpu ? { webgpu: fp.webgpu } : {}) };
  return {
    ...fp,
    navigator: overrides.navigator ? { ...fp.navigator, ...overrides.navigator } : fp.navigator,
    screen: overrides.screen ? { ...fp.screen, ...overrides.screen } : fp.screen,
    locale: overrides.locale ? { ...fp.locale, ...overrides.locale } : fp.locale,
    ...gpuIdentity,
    fonts: overrides.fonts ?? fp.fonts,
  };
}
