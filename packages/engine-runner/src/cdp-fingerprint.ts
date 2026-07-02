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
 *
 * The geolocation override is the last leg of the geo-coherence cluster: timezone/locale/languages
 * are derived from the proxy exit IP by `applyGeoToFingerprint`, and this sends the matching
 * coordinates so `navigator.geolocation` agrees with them (the caller grants the geolocation
 * permission at the context level so a page that asks actually reads the override).
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
  // Pass the CLEAN, ordered language list (not the q-weighted Accept-Language header value): Chromium
  // derives navigator.languages from this string by a naive comma-split, so a q-weighted value would
  // leak "de;q=0.9" into navigator.languages. The comma-joined list yields a clean, coherent
  // navigator.languages that matches the header's leading languages.
  await cdp.send('Emulation.setUserAgentOverride', {
    userAgent: emu.userAgent,
    acceptLanguage: fingerprint.navigator.languages.join(','),
    platform: emu.platform,
    userAgentMetadata: emu.userAgentMetadata,
  });
  // Geo-coherence: keep navigator.geolocation consistent with the proxy-derived timezone/locale.
  // Only sent when the profile carries coordinates (i.e. a geo/proxy was applied).
  if (emu.geolocation) {
    await cdp.send('Emulation.setGeolocationOverride', {
      latitude: emu.geolocation.latitude,
      longitude: emu.geolocation.longitude,
      accuracy: emu.geolocation.accuracy,
    });
  }
  // Main-world init script for the remaining navigator surfaces (languages, deviceMemory,
  // platform, maxTouchPoints) — runs on every new document in the page's real world.
  await cdp.send('Page.addScriptToEvaluateOnNewDocument', {
    source: buildFingerprintInitScript(fingerprint),
  });
}
