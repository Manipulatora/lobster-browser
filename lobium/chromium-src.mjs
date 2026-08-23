import { resolve } from 'node:path';

/**
 * Resolve the checkout shared by the Lobium patch/build tools.
 *
 * A Chromium checkout is too large and too host-specific for a repository default: a drive-letter
 * or named-user fallback silently targets the wrong tree on another build host. Keep one explicit
 * cross-language contract instead. CHROMIUM_SRC remains accepted for compatibility with Chromium
 * tooling, while LOBIUM_CHROMIUM_SRC is the canonical Lobster variable.
 */
export function resolveChromiumSrc({ required = true } = {}) {
  const configured = process.env.LOBIUM_CHROMIUM_SRC || process.env.CHROMIUM_SRC;
  if (!configured) {
    if (!required) return undefined;
    throw new Error(
      'Chromium checkout is not configured. Set LOBIUM_CHROMIUM_SRC to the directory containing .gn.',
    );
  }
  return resolve(configured);
}
