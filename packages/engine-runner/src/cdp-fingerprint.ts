import type { Fingerprint } from '@lobster/shared-types';
import { buildCdpEmulation, buildFingerprintInitScript } from './launch.js';

/** Minimal view of a CDP session (a Playwright/patchright `CDPSession`). */
export interface CdpSession {
  send(method: string, params?: Record<string, unknown>): Promise<unknown>;
}

/**
 * Apply the JS-safe fingerprint surfaces to a page via **real CDP overrides** + a **main-world**
 * init script.
 *
 * This is more reliable than Playwright/patchright `addInitScript`, which patchright runs in an
 * isolated world the page's `navigator` cannot see (so JS-only overrides silently don't take —
 * caught by the validation harness for `hardwareConcurrency`). Deep surfaces (canvas/WebGL/audio/TLS)
 * are intentionally NOT touched here — they are native (handled by Lobium).
 */
export async function applyCdpFingerprint(
  cdp: CdpSession,
  fingerprint: Fingerprint,
): Promise<void> {
  const emu = buildCdpEmulation(fingerprint);

  await cdp.send('Emulation.setHardwareConcurrencyOverride', {
    hardwareConcurrency: fingerprint.navigator.hardwareConcurrency,
  });
  await cdp.send('Emulation.setTimezoneOverride', { timezoneId: emu.timezoneId });
  try {
    await cdp.send('Emulation.setLocaleOverride', { locale: emu.locale });
  } catch {
    // setLocaleOverride is best-effort across Chromium versions.
  }
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: emu.userAgent,
    acceptLanguage: emu.acceptLanguage,
    platform: emu.platform,
    userAgentMetadata: emu.userAgentMetadata,
  });
  // Main-world init script for the remaining navigator surfaces (languages, deviceMemory,
  // platform, maxTouchPoints) — runs on every new document in the page's real world.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: buildFingerprintInitScript(fingerprint),
  });
}
