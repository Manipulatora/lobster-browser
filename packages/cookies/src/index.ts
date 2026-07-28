/**
 * @lobster/cookies — parse/serialize browser cookies for profile import/export.
 *
 * A canonical in-memory {@link Cookie} shape both formats convert to/from:
 *   - Netscape `cookies.txt` (`parseNetscape` / `serializeNetscape`)
 *   - Playwright/CDP-style JSON (`parseJson` / `serializeJson`)
 *
 * Session cookies are represented canonically by an *absent* `expires` field, so that a
 * `parse(serialize(x))` round-trip is an identity for well-formed input.
 */

export type SameSite = 'Lax' | 'Strict' | 'None';

/**
 * Canonical in-memory cookie. Both import/export formats map to and from this shape.
 *
 * `expires` is unix seconds. A session cookie (no explicit expiry) is represented by the
 * field being absent — external `-1` (Playwright) or `0` (Netscape) sentinels normalize to this.
 */
export interface Cookie {
  name: string;
  value: string;
  domain: string;
  /** Request path scope. Defaults to '/' when a source omits it. */
  path: string;
  /** Unix seconds. Absent = session cookie (expires when the browser closes). */
  expires?: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite?: SameSite;
}

const SAME_SITE_VALUES: readonly SameSite[] = ['Lax', 'Strict', 'None'];

/** Prefix a Netscape line carries when the cookie is HttpOnly (a Firefox/curl convention). */
const HTTP_ONLY_PREFIX = '#HttpOnly_';

function isSameSite(value: unknown): value is SameSite {
  return typeof value === 'string' && (SAME_SITE_VALUES as readonly string[]).includes(value);
}

/** True when an expiry sentinel means "session" (absent, -1, or 0). */
function isSessionExpiry(expires: number | undefined): boolean {
  return expires === undefined || expires === -1 || expires === 0;
}

/** Validate a canonical cookie before it is sent to Chromium's all-or-nothing setCookies call. */
export function validateCookie(cookie: Cookie): string[] {
  const issues: string[] = [];
  if (typeof cookie.name !== 'string' || /[\u0000-\u001f\u007f;=]/.test(cookie.name)) {
    issues.push('name contains a control character, semicolon, or equals sign');
  }
  if (typeof cookie.value !== 'string' || /[\u0000-\u0008\u000a-\u001f\u007f]/.test(cookie.value)) {
    issues.push('value contains a forbidden control character');
  }
  const bareDomain = cookie.domain.startsWith('.') ? cookie.domain.slice(1) : cookie.domain;
  if (
    !bareDomain ||
    /\s|[\u0000-\u001f\u007f/@?#]/.test(bareDomain) ||
    bareDomain.includes('://')
  ) {
    issues.push(`domain "${cookie.domain}" is invalid`);
  } else {
    try {
      const host =
        bareDomain.includes(':') && !bareDomain.startsWith('[') ? `[${bareDomain}]` : bareDomain;
      if (!new URL(`http://${host}/`).hostname) issues.push(`domain "${cookie.domain}" is invalid`);
    } catch {
      issues.push(`domain "${cookie.domain}" is invalid`);
    }
  }
  if (typeof cookie.path !== 'string' || !cookie.path.startsWith('/')) {
    issues.push('path must start with /');
  }
  if (cookie.expires !== undefined && (!Number.isFinite(cookie.expires) || cookie.expires <= 0)) {
    issues.push('expires must be positive Unix seconds or absent for a session cookie');
  }
  if (cookie.sameSite === 'None' && !cookie.secure) {
    issues.push('SameSite=None requires Secure');
  }
  if (cookie.name.startsWith('__Secure-') && !cookie.secure) {
    issues.push('__Secure- cookies require Secure');
  }
  if (cookie.name.startsWith('__Host-')) {
    if (!cookie.secure) issues.push('__Host- cookies require Secure');
    if (cookie.path !== '/') issues.push('__Host- cookies require path=/');
    if (cookie.domain.startsWith('.')) issues.push('__Host- cookies must be host-only');
  }
  return issues;
}

export function validateCookies(cookies: readonly Cookie[]): string[] {
  return cookies.flatMap((cookie, index) =>
    validateCookie(cookie).map((issue) => `cookie[${index}] "${cookie.name}": ${issue}`),
  );
}

// ---------------------------------------------------------------------------
// Netscape cookies.txt
// ---------------------------------------------------------------------------

/**
 * Parse a Netscape `cookies.txt` document into canonical cookies.
 *
 * Each data line is 7 tab-separated fields:
 *   domain, includeSubdomains(TRUE/FALSE), path, secure(TRUE/FALSE), expiry(unix), name, value.
 *
 * Blank lines and `#` comments are skipped, except the `#HttpOnly_` prefix which marks an
 * HttpOnly cookie (the prefix is stripped and `httpOnly` set). Malformed lines (wrong field
 * count or non-numeric expiry) are silently skipped so a partially-corrupt file still imports.
 */
export function parseNetscape(text: string): Cookie[] {
  const cookies: Cookie[] = [];

  for (const rawLine of text.split(/\r?\n/)) {
    // A blank line (possibly padded with whitespace) carries no cookie.
    if (rawLine.trim() === '') continue;

    let httpOnly = false;
    let line = rawLine;
    if (line.startsWith(HTTP_ONLY_PREFIX)) {
      httpOnly = true;
      line = line.slice(HTTP_ONLY_PREFIX.length);
    } else if (line.startsWith('#')) {
      // Ordinary comment.
      continue;
    }

    const fields = line.split('\t');
    if (fields.length !== 7) continue; // Malformed: not the canonical 7-column shape.

    const [rawDomain, includeSubdomainsField, path, secureField, expiryField, name, value] =
      fields as [string, string, string, string, string, string, string];

    const expiry = Number(expiryField);
    if (!Number.isFinite(expiry)) continue; // Malformed expiry column.
    if (includeSubdomainsField !== 'TRUE' && includeSubdomainsField !== 'FALSE') continue;
    if (secureField !== 'TRUE' && secureField !== 'FALSE') continue;
    const domain =
      includeSubdomainsField === 'TRUE' && !rawDomain.startsWith('.') ? `.${rawDomain}` : rawDomain;

    const cookie: Cookie = {
      name,
      value,
      domain,
      path: path === '' ? '/' : path,
      httpOnly,
      secure: secureField === 'TRUE',
    };
    if (!isSessionExpiry(expiry)) cookie.expires = expiry;

    cookies.push(cookie);
  }

  return cookies;
}

/**
 * Serialize canonical cookies to a Netscape `cookies.txt` document (trailing newline included).
 *
 * `includeSubdomains` is derived from the leading-dot convention (`.example.com` => TRUE).
 * Session cookies emit expiry `0`, and HttpOnly cookies gain the `#HttpOnly_` line prefix.
 */
export function serializeNetscape(cookies: readonly Cookie[]): string {
  const lines: string[] = [
    '# Netscape HTTP Cookie File',
    '# https://curl.se/docs/http-cookies.html',
    '# This file was generated by @lobster/cookies. Edit at your own risk.',
    '',
  ];

  for (const cookie of cookies) {
    const includeSubdomains = cookie.domain.startsWith('.') ? 'TRUE' : 'FALSE';
    const secure = cookie.secure ? 'TRUE' : 'FALSE';
    const expiry = isSessionExpiry(cookie.expires) ? '0' : String(cookie.expires);
    const row = [
      cookie.domain,
      includeSubdomains,
      cookie.path,
      secure,
      expiry,
      cookie.name,
      cookie.value,
    ].join('\t');
    lines.push(cookie.httpOnly ? `${HTTP_ONLY_PREFIX}${row}` : row);
  }

  return `${lines.join('\n')}\n`;
}

// ---------------------------------------------------------------------------
// Playwright / CDP-style JSON
// ---------------------------------------------------------------------------

/** Wire shape of a single cookie in the JSON array (Playwright's `storageState().cookies`). */
interface JsonCookie {
  name: string;
  value: string;
  domain: string;
  path?: string;
  /** Playwright uses -1 for a session cookie. */
  expires?: number;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: string;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/**
 * Parse a Playwright/CDP-style JSON array of cookies into canonical cookies.
 *
 * Playwright's `expires === -1` (and an absent expiry) map to a session cookie. Entries that
 * are not objects with string `name`/`value`/`domain` are skipped as malformed. Throws if the
 * top-level JSON is not an array.
 */
export function parseJson(text: string): Cookie[] {
  const parsed: unknown = JSON.parse(text);
  if (!Array.isArray(parsed)) {
    throw new Error('parseJson: expected a top-level JSON array of cookies.');
  }

  const cookies: Cookie[] = [];
  for (const entry of parsed) {
    if (typeof entry !== 'object' || entry === null) continue;
    const raw = entry as Record<string, unknown>;

    const name = asString(raw['name']);
    const value = asString(raw['value']);
    const domain = asString(raw['domain']);
    if (name === undefined || value === undefined || domain === undefined) continue;

    const path = asString(raw['path']);
    const expires = typeof raw['expires'] === 'number' ? raw['expires'] : undefined;

    const cookie: Cookie = {
      name,
      value,
      domain,
      path: path === undefined || path === '' ? '/' : path,
      httpOnly: raw['httpOnly'] === true,
      secure: raw['secure'] === true,
    };
    if (expires !== undefined && !isSessionExpiry(expires)) cookie.expires = expires;
    if (isSameSite(raw['sameSite'])) cookie.sameSite = raw['sameSite'];

    cookies.push(cookie);
  }

  return cookies;
}

/**
 * Serialize canonical cookies to a Playwright/CDP-style JSON array (2-space indented).
 *
 * Session cookies emit `expires: -1` (Playwright's sentinel); `sameSite` is emitted only when set.
 */
export function serializeJson(cookies: readonly Cookie[]): string {
  const wire: JsonCookie[] = cookies.map((cookie) => {
    const out: JsonCookie = {
      name: cookie.name,
      value: cookie.value,
      domain: cookie.domain,
      path: cookie.path,
      expires: isSessionExpiry(cookie.expires) ? -1 : (cookie.expires as number),
      httpOnly: cookie.httpOnly,
      secure: cookie.secure,
    };
    if (cookie.sameSite !== undefined) out.sameSite = cookie.sameSite;
    return out;
  });

  return JSON.stringify(wire, null, 2);
}
