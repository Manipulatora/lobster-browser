import { type Cookie, parseJson, parseNetscape, serializeJson } from '@lobster/cookies';
import type { CookieImportDraft } from '@lobster/shared-types';
import type { CdpSession } from './cdp-fingerprint.js';

/**
 * Cookie inject/export for a launched profile (PROX-1/2).
 *
 * A profile's stored {@link CookieImportDraft} carries the raw cookies the user imported (a Netscape
 * `cookies.txt` or a Playwright/CDP JSON array). At launch we parse it with `@lobster/cookies` and load
 * the cookies into the live browser over CDP (`Network.setCookies`) so the profile opens already
 * logged-in — the core "import my session" feature. Export reads them back (`Network.getAllCookies`) so
 * a warmed-up profile's session can be saved.
 *
 * This module is deliberately split into PURE mapping (unit-tested without a browser) and a thin CDP
 * apply/export that a live launch calls.
 */

/** CDP `Network.CookieParam` shape (what `Network.setCookies` accepts). */
export interface CdpCookieParam {
  name: string;
  value: string;
  domain: string;
  path: string;
  /** Unix seconds. Omitted for a session cookie. */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: 'Strict' | 'Lax' | 'None';
}

/** Detect JSON vs Netscape by the first non-whitespace char, then parse with `@lobster/cookies`. */
export function parseCookieText(rawText: string): Cookie[] {
  const trimmed = rawText.trimStart();
  if (trimmed.startsWith('[') || trimmed.startsWith('{')) {
    // A single object is not a valid export, but tolerate it by wrapping — parseJson requires an array.
    return parseJson(trimmed.startsWith('[') ? trimmed : `[${trimmed}]`);
  }
  return parseNetscape(rawText);
}

/** Map a canonical cookie to the CDP `Network.setCookies` param shape (drops nothing lossily). */
export function toCdpCookie(cookie: Cookie): CdpCookieParam {
  const out: CdpCookieParam = {
    name: cookie.name,
    value: cookie.value,
    // A leading dot is a Netscape "include subdomains" marker; CDP wants the bare domain (it applies
    // subdomain scope itself), so strip exactly one leading dot.
    domain: cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain,
    path: cookie.path || '/',
    httpOnly: cookie.httpOnly,
    secure: cookie.secure,
  };
  if (cookie.expires !== undefined) out.expires = cookie.expires;
  if (cookie.sameSite !== undefined) out.sameSite = cookie.sameSite;
  return out;
}

/**
 * Resolve the CDP cookies to inject for a launch, honoring the draft `mode`:
 *  - `empty`: inject nothing (start with a clean jar).
 *  - `merge` / `replace`: inject the parsed cookies (a persistent user-data-dir is per-profile already,
 *    so "replace" is achieved by clearing first — see {@link applyCookieImport}).
 * Returns an empty array when there is nothing to inject.
 */
export function cdpCookiesFromDraft(draft: CookieImportDraft | undefined): CdpCookieParam[] {
  if (!draft || draft.mode === 'empty' || !draft.rawText || draft.rawText.trim() === '') {
    return [];
  }
  return parseCookieText(draft.rawText).map(toCdpCookie);
}

/**
 * Inject a profile's imported cookies into the live browser over CDP. `replace` clears the existing jar
 * first so the imported set is authoritative. No-op when the draft is absent/empty or parses to nothing.
 * Returns the number of cookies loaded.
 */
export async function applyCookieImport(
  cdp: CdpSession,
  draft: CookieImportDraft | undefined,
): Promise<number> {
  const cookies = cdpCookiesFromDraft(draft);
  if (draft?.mode === 'replace') {
    await cdp.send('Network.clearBrowserCookies');
  }
  if (cookies.length === 0) {
    return 0;
  }
  await cdp.send('Network.setCookies', { cookies });
  return cookies.length;
}

/** CDP `Network.Cookie` (what `Network.getAllCookies` returns). */
interface CdpReadCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  session: boolean;
  sameSite?: string;
}

function fromCdpCookie(c: CdpReadCookie): Cookie {
  const cookie: Cookie = {
    name: c.name,
    value: c.value,
    domain: c.domain,
    path: c.path || '/',
    httpOnly: c.httpOnly === true,
    secure: c.secure === true,
  };
  // CDP marks session cookies with `session: true` and a sentinel `expires` (-1); keep those absent.
  if (!c.session && Number.isFinite(c.expires) && c.expires > 0) cookie.expires = c.expires;
  if (c.sameSite === 'Strict' || c.sameSite === 'Lax' || c.sameSite === 'None') {
    cookie.sameSite = c.sameSite;
  }
  return cookie;
}

/** Read all cookies from the live browser over CDP into canonical cookies (for export/warm-up save). */
export async function exportCookies(cdp: CdpSession): Promise<Cookie[]> {
  const result = (await cdp.send('Network.getAllCookies')) as { cookies?: CdpReadCookie[] } | null;
  return (result?.cookies ?? []).map(fromCdpCookie);
}

/** Export the live browser's cookies as a Playwright/CDP-style JSON document. */
export async function exportCookiesJson(cdp: CdpSession): Promise<string> {
  return serializeJson(await exportCookies(cdp));
}
