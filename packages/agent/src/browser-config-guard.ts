import type { AgentAction, BrowserConfigOp } from '@lobster/shared-types';
import { isIP } from 'node:net';
import { domainToASCII } from 'node:url';
import { parse as parseDomain } from 'tldts';

/**
 * The anti-detect gate for deep browser-config control.
 *
 * Lobium's whole value proposition is that a profile is indistinguishable from a real browser on a
 * real machine. Deep config gives the agent broad reach over browser settings — so this guard is the
 * hard boundary that keeps that reach from ever touching the identity/spoofing layer. Two rules,
 * neither overridable:
 *
 *   1. FINGERPRINT + PROXY ARE UNTOUCHABLE. Anything that changes the fingerprint the site observes
 *      (user-agent, platform, languages/locale, timezone, screen metrics, canvas/WebGL/WebGPU, audio,
 *      fonts, hardware concurrency, device memory, media-device identities, WebRTC/IP exposure) or the
 *      network path (proxy/PAC/DNS) is BLOCKED, always. There is no allow-list entry, flag, or persona
 *      that unblocks it. Changing these would either contradict the persona (a tell) or leak the real
 *      machine — the exact thing the product prevents.
 *
 *   2. CONFIG NEVER RUNS ON A PAGE TARGET. Phase-1 ops execute over the browser-target CDP session and
 *      pref ops rewrite the on-disk profile — neither enables a page-observable domain, so config adds
 *      no automation tell. (Enforced by the driver; this guard screens intent.)
 *
 * The screen is intentionally conservative: for the free-form surfaces (a pref value, or a
 * chrome://settings/flags field the UI-fallback drives) it DENIES BY DEFAULT on any fingerprint token,
 * because a missed tell is a de-anonymization and a false block is a harmless "can't do that".
 */

export interface ConfigAssessment {
  verdict: 'allow' | 'block';
  /** Human-readable reason (shown to the model as the action outcome) when blocked. */
  reason?: string;
  /**
   * For UI-fallback ops: the vetted `chrome://settings/...` URL the agent should open. The agent then
   * operates the real control with humanized input; Chromium applies the change live (no relaunch).
   */
  settingsUrl?: string;
}

/** Live, page-invisible ops that run over leak-free CDP (applied instantly). */
const LIVE_OPS: ReadonlySet<BrowserConfigOp> = new Set([
  'clear_cookies',
  'clear_all_cookies',
  'clear_site_data',
  'clear_cache',
  'set_permission',
  'set_downloads',
]);

/** UI-fallback ops: open a vetted chrome://settings page and let the agent operate the control. */
const UI_OPS: ReadonlySet<BrowserConfigOp> = new Set([
  'open_settings',
  'set_theme',
  'set_privacy',
  'set_content_default',
]);

/**
 * The settings areas the agent may open. This is the allow-list that defines "all settings" MINUS the
 * hard-blocked identity layer: there is deliberately NO entry for languages, system/proxy, or any page
 * that edits the fingerprint or network path. An area not in this map is refused (with the list), so an
 * arbitrary `chrome://...` string can never be navigated. Keyed by friendly synonyms → settings path.
 */
const SAFE_SETTINGS: ReadonlyMap<string, string> = new Map([
  ['appearance', 'appearance'],
  ['theme', 'appearance'],
  ['dark mode', 'appearance'],
  ['dark', 'appearance'],
  ['light', 'appearance'],
  ['font', 'appearance'],
  ['zoom', 'appearance'],
  ['privacy', 'privacy'],
  ['privacy and security', 'privacy'],
  ['security', 'security'],
  ['safe browsing', 'security'],
  ['cookies', 'cookies'],
  ['third-party cookies', 'cookies'],
  ['content', 'content'],
  ['site settings', 'content'],
  ['javascript', 'content/javascript'],
  ['images', 'content/images'],
  ['popups', 'content/popups'],
  ['pop-ups', 'content/popups'],
  ['notifications', 'content/notifications'],
  ['location', 'content/location'],
  ['camera', 'content/camera'],
  ['microphone', 'content/microphone'],
  ['sound', 'content/sound'],
  ['downloads', 'downloads'],
  ['autofill', 'autofill'],
  ['passwords', 'passwords'],
  ['payment methods', 'payments'],
  ['addresses', 'addresses'],
  ['search', 'search'],
  ['search engine', 'search'],
  ['on startup', 'onStartup'],
  ['startup', 'onStartup'],
  ['home', 'appearance'],
  ['accessibility', 'accessibility'],
  ['performance', 'performance'],
  ['memory', 'performance'],
  // Backgrounds and other New Tab customisation live on the New Tab page, not in Appearance.
  ['new tab', '@new-tab'],
  ['new tab page', '@new-tab'],
  ['background', '@new-tab'],
  ['background image', '@new-tab'],
  ['wallpaper', '@new-tab'],
]);

/** Fixed page for the pref-shortcut ops. */
const OP_PAGE: Partial<Record<BrowserConfigOp, string>> = {
  set_theme: 'appearance',
  set_privacy: 'privacy',
  set_content_default: 'content',
};

/**
 * Fingerprint / network-identity tells. If any appears in a free-form config value (or a UI field the
 * agent tries to drive), the change is blocked. Matched case-insensitively as whole-ish tokens against
 * the normalized text. This is the core anti-detect denylist — extend it, never prune it.
 */
const FINGERPRINT_TELLS: readonly RegExp[] = [
  // Network path / IP exposure. (STUN/TURN/ICE require "server"/webrtc context so plain English like
  // "turn on…" or "ice cream" can't false-trip; webrtc/rtc already cover the surface on their own.)
  /\bproxy\b/,
  /\bsocks\b/,
  /proxy[\s-]?auto[\s-]?config/,
  /\bwebrtc\b/,
  /\brtc\b/,
  /\b(stun|turn|ice)[\s-]?server/,
  /\bdns\b/,
  /\bdoh\b/,
  /\bip[\s-]?(leak|address|handling)\b/,
  // Identity strings
  /user[\s-]?agent/,
  /\bua[\s-]?(string|data|hints?|ch)\b/,
  /\bplatform\b/,
  /\boscpu\b/,
  /app[\s-]?version/,
  /\bvendor\b/,
  // Locale / time
  /\btime[\s-]?zone\b/,
  /\btz\b/,
  /accept[\s-]?language/,
  /\blocale\b/,
  /\blanguages?\b/,
  // Display metrics
  /\bscreen\b/,
  /\bresolution\b/,
  /color[\s-]?depth/,
  /pixel[\s-]?ratio/,
  /device[\s-]?pixel/,
  /\bviewport[\s-]?size\b/,
  /\binner(width|height)\b/,
  // GPU / canvas / render fingerprint
  /\bcanvas\b/,
  /\bwebgl\b/,
  /\bwebgpu\b/,
  /\bgpu\b/,
  /\brenderer\b/,
  /\bunmasked\b/,
  // Audio / media fingerprint
  /audio[\s-]?(context|fingerprint)/,
  /media[\s-]?devices?/,
  /enumerate[\s-]?devices/,
  // Hardware
  /hardware[\s-]?concurrency/,
  /\bcpu[\s-]?cores?\b/,
  /device[\s-]?memory/,
  /\bbattery\b/,
  // Fonts
  /\bfonts?\b/,
  // Automation surface
  /\bwebdriver\b/,
  /\bautomation\b/,
  /navigator\.webdriver/,
  // Do-Not-Track (a mismatched DNT is itself a persona tell)
  /do[\s-]?not[\s-]?track/,
  /\bdnt\b/,
];

/** Permissions-API descriptor names the agent may set (per-site user grants, never spoofing). */
const ALLOWED_PERMISSIONS: ReadonlySet<string> = new Set([
  'geolocation',
  'notifications',
  'camera',
  'microphone',
  'clipboard-read',
  'clipboard-write',
  'midi',
  'push',
  'background-sync',
  'accelerometer',
  'gyroscope',
  'magnetometer',
  'persistent-storage',
  'payment-handler',
]);

/**
 * Canonicalize the natural permission names models/users commonly use to the Permissions-API names
 * accepted by Browser.setPermission. Keep this normalization at the policy boundary and reuse it in
 * the concrete driver so a permission cannot be allowed under one name and executed under another.
 */
export function normalizeBrowserPermission(raw?: string): string {
  if (!raw) return '';
  const key = raw.trim().toLowerCase();
  const aliases: Readonly<Record<string, string>> = {
    location: 'geolocation',
    geo: 'geolocation',
    geolocation: 'geolocation',
    notification: 'notifications',
    notifications: 'notifications',
    camera: 'camera',
    videocapture: 'camera',
    webcam: 'camera',
    mic: 'microphone',
    microphone: 'microphone',
    audiocapture: 'microphone',
    clipboard: 'clipboard-read',
    'clipboard-read': 'clipboard-read',
    'clipboard-write': 'clipboard-write',
    midi: 'midi',
    sensors: 'accelerometer',
    accelerometer: 'accelerometer',
    gyroscope: 'gyroscope',
    magnetometer: 'magnetometer',
    push: 'push',
    'background-sync': 'background-sync',
    'persistent-storage': 'persistent-storage',
    'payment-handler': 'payment-handler',
  };
  return aliases[key] ?? key;
}

/**
 * Canonicalize the origin a site-permission command will actually affect.
 *
 * Browser.setPermission makes `origin` optional, but omitting it changes the meaning from one site to
 * every origin.  Keep that dangerous API default unreachable: only an explicit HTTP(S) origin, or a
 * syntactically valid host promoted to HTTPS, produces a value.  The returned string is always an
 * origin (no credentials, path, query, fragment, trailing root dot, or default port spelling).
 */
export function normalizeBrowserPermissionOrigin(origin?: string, domain?: string): string {
  const explicit = origin?.trim();
  if (explicit) {
    let url: URL;
    try {
      url = new URL(explicit);
    } catch {
      return '';
    }
    if (
      (url.protocol !== 'http:' && url.protocol !== 'https:') ||
      url.username !== '' ||
      url.password !== ''
    ) {
      return '';
    }
    const host = canonicalBrowserHostname(url.hostname);
    if (!host) return '';
    return `${url.protocol}//${originHost(host)}${url.port ? `:${url.port}` : ''}`;
  }

  // An explicitly supplied but empty/malformed origin must not silently fall through to a different
  // scope in direct callers. parseAction already drops whitespace-only strings, so the ordinary
  // domain-only tool form still reaches the branch below.
  if (origin !== undefined) return '';
  const host = canonicalBrowserHostname(domain ?? '');
  return host ? `https://${originHost(host)}` : '';
}

/**
 * Canonicalize a clear-cookies scope and reject public/private suffix boundaries.  Cookie deletion
 * deliberately includes subdomains; accepting `com`, `co.uk`, `github.io`, `pages.dev`, etc. would
 * therefore turn a site-scoped action into a large cross-site wipe.
 */
export function normalizeCookieDomain(raw?: string): string {
  if (!raw) return '';
  const withoutCookieDot = raw.trim().replace(/^\./, '');
  const host = canonicalBrowserHostname(withoutCookieDot);
  if (!host) return '';

  if (isIP(host) === 0) {
    const parsed = parseDomain(host, {
      allowPrivateDomains: true,
      detectSpecialUse: true,
    });
    const deliberatelyLocal = host === 'localhost';
    const unregisteredSingleLabel =
      !host.includes('.') &&
      parsed.isIcann !== true &&
      parsed.isPrivate !== true &&
      parsed.isSpecialUse !== true;
    if (parsed.domain === null && !deliberatelyLocal && !unregisteredSingleLabel) return '';
  }
  return host;
}

/** Return lower-case ASCII/IDNA hostname form, or an empty result for non-host input. */
function canonicalBrowserHostname(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.endsWith('..')) return '';
  const candidate = trimmed.endsWith('.') ? trimmed.slice(0, -1) : trimmed;
  if (!candidate) return '';

  const bracketedIpv6 = /^\[([^\]]+)\]$/.exec(candidate);
  const ipCandidate = bracketedIpv6?.[1] ?? candidate;
  const ipVersion = isIP(ipCandidate);
  if (ipVersion === 4) return ipCandidate;
  if (ipVersion === 6) {
    try {
      return new URL(`http://[${ipCandidate}]/`).hostname.slice(1, -1).toLowerCase();
    } catch {
      return '';
    }
  }
  if (bracketedIpv6 || /[:/\\@?#\s]/u.test(candidate)) return '';

  const ascii = domainToASCII(candidate).toLowerCase();
  if (!ascii || ascii.length > 253 || ascii.startsWith('.') || ascii.endsWith('.')) return '';
  const labels = ascii.split('.');
  if (
    labels.some(
      (label) =>
        label.length === 0 || label.length > 63 || !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
    )
  ) {
    return '';
  }
  return ascii;
}

function originHost(host: string): string {
  return isIP(host) === 6 ? `[${host}]` : host;
}

function hasFingerprintTell(...values: Array<string | undefined>): string | undefined {
  for (const value of values) {
    if (!value) continue;
    const text = value.toLowerCase();
    for (const pattern of FINGERPRINT_TELLS) {
      if (pattern.test(text))
        return text.match(pattern)?.[0]?.trim() ?? 'a fingerprint-sensitive setting';
    }
  }
  return undefined;
}

/**
 * Decide whether a `browser_config` action may run. Called by the executor BEFORE any driver call and
 * BEFORE any pref write. A `block` verdict must be surfaced to the model verbatim and the op skipped.
 */
export function assessBrowserConfig(
  action: Extract<AgentAction, { kind: 'browser_config' }>,
): ConfigAssessment {
  const { op } = action;

  // Live, inherently-safe surfaces (cookies / cache / permissions / downloads). These never touch the
  // fingerprint, so domains are NOT screened for tell-tokens (a site literally named "fonts.google.com"
  // must remain clearable). Only set_permission is constrained, to the real Permissions-API grants.
  if (LIVE_OPS.has(op)) {
    if (op === 'clear_cookies' && !normalizeCookieDomain(action.domain)) {
      return block('clear_cookies needs a specific site domain, not a public/private suffix');
    }
    if (op === 'set_permission') {
      if (!normalizeBrowserPermissionOrigin(action.origin, action.domain)) {
        return block('set_permission needs a valid non-empty HTTP(S) origin');
      }
      const name = normalizeBrowserPermission(action.permission);
      if (!name) return block('set_permission needs a permission name');
      if (!ALLOWED_PERMISSIONS.has(name)) {
        return block(
          `"${name}" is not a grantable site permission. Grantable: ${[...ALLOWED_PERMISSIONS].join(', ')}.`,
        );
      }
    }
    return { verdict: 'allow' };
  }

  // UI-fallback surfaces (theme / privacy / content / any vetted settings area). Resolve the target to
  // a whitelisted chrome://settings URL; unknown or fingerprint/proxy areas are refused. The value is
  // also screened against the denylist as a second layer before it can influence navigation.
  if (UI_OPS.has(op)) {
    const tell = hasFingerprintTell(action.value, action.note);
    if (tell) return block(fingerprintRefusal(tell));
    const resolved = resolveSettingsTarget(op, action.value);
    if (!resolved) {
      return block(
        `no settings area matches ${JSON.stringify(action.value ?? '')}. Openable areas: ${[...new Set(SAFE_SETTINGS.keys())].join(', ')}.`,
      );
    }
    return { verdict: 'allow', settingsUrl: resolved };
  }

  return block(`unsupported browser-config op ${JSON.stringify(op)}`);
}

/**
 * Resolve a UI op to a vetted `chrome://settings/...` URL, or null if the area is unknown/blocked.
 * Pref-shortcut ops map to a fixed page; `open_settings` looks its `value` up in the safe allow-list.
 * A fingerprint token anywhere in the value yields null (never navigate to an identity page).
 */
export function resolveSettingsTarget(op: BrowserConfigOp, value?: string): string | null {
  if (hasFingerprintTell(value)) return null;
  const fixed = OP_PAGE[op];
  if (fixed) return `chrome://settings/${fixed}`;
  if (op !== 'open_settings') return null;
  const key = (value ?? '').trim().toLowerCase();
  if (!key) return null;
  const path =
    SAFE_SETTINGS.get(key) ?? SAFE_SETTINGS.get(key.replace(/\bsettings?\b/g, '').trim());
  if (path === '@new-tab') return 'chrome://new-tab-page/';
  return path ? `chrome://settings/${path}` : null;
}

/**
 * True only for internal browser pages the config guard itself can open. This is intentionally much
 * narrower than `chrome:*`: it lets normal click/type actions continue inside a vetted settings tab
 * without weakening the web-navigation policy for arbitrary internal pages.
 */
export function isVettedBrowserConfigUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'chrome:') return false;
  if (url.hostname === 'new-tab-page' || url.hostname === 'newtab') return true;
  if (url.hostname !== 'settings') return false;
  const path = url.pathname.replace(/^\/+|\/+$/g, '');
  if (/(^|\/)(languages?|fonts?|system|proxy)(\/|$)/i.test(path)) return false;
  const allowed = new Set([...SAFE_SETTINGS.values()].filter((value) => value !== '@new-tab'));
  return [...allowed].some((base) => path === base || path.startsWith(`${base}/`));
}

/**
 * A privileged browser-internal page: one whose JavaScript context is granted the browser's own APIs
 * rather than ordinary web capabilities.
 *
 * These pages are NOT websites and must never be treated as one. `chrome://policy` exposes
 * `setLocalTestPolicies`, which applies enterprise policy — including the proxy — straight past every
 * preference guard in this file; `chrome://flags` can change engine behaviour that the fingerprint
 * layer assumes; `devtools://` and extension pages carry their own privileged surfaces. Verified on the
 * fork (Chrome/152) that these pages load with `chrome.send` available in page context.
 *
 * The agent can arrive on one WITHOUT navigating there — by switching to a tab the human opened, or by
 * the driver adopting a popup — so vetting the navigation alone was never sufficient.
 */
export function isPrivilegedInternalUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  const scheme = url.protocol.replace(/:$/, '').toLowerCase();
  if (scheme === 'about') return url.pathname.replace(/^\/+/, '') !== 'blank';
  return ['chrome', 'chrome-untrusted', 'chrome-search', 'devtools', 'chrome-extension'].includes(
    scheme,
  );
}

/** Whether this is browser configuration UI at all, including a non-vetted/blocked subsection. */
export function isBrowserConfigSurfaceUrl(raw: string): boolean {
  try {
    const url = new URL(raw);
    return (
      url.protocol === 'chrome:' &&
      (url.hostname === 'settings' || url.hostname === 'new-tab-page' || url.hostname === 'newtab')
    );
  } catch {
    return false;
  }
}

/**
 * Screen a free-form settings intent the chrome:// UI-fallback is about to act on (a settings search
 * query, a flag name, a field value). Same denylist as the pref path — the UI fallback is exactly where
 * the long-tail fingerprint tells would otherwise sneak in.
 */
export function assessUiSettingsIntent(...intent: Array<string | undefined>): ConfigAssessment {
  const tell = hasFingerprintTell(...intent);
  return tell ? block(fingerprintRefusal(tell)) : { verdict: 'allow' };
}

function fingerprintRefusal(tell: string): string {
  return (
    `blocked: "${tell}" is part of the anti-detect fingerprint/proxy layer and can never be changed ` +
    `by the agent — altering it would contradict this profile's persona or leak the real machine. ` +
    `This is a hard limit with no override.`
  );
}

function block(reason: string): ConfigAssessment {
  return {
    verdict: 'block',
    reason: reason.startsWith('blocked:') ? reason : `blocked: ${reason}`,
  };
}
