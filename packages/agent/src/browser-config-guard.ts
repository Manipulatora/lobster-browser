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
 *   2. CONFIG NEVER RUNS ON A PAGE TARGET. Live ops execute over the browser-target CDP session and
 *      pref ops run in a throwaway browser-internal page that is never shown — neither enables a
 *      page-observable domain, so config adds no automation tell. (Enforced by the driver; this guard
 *      screens intent.)
 *
 * The screen is intentionally conservative: for the free-form surfaces (a preference key, or a
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
  /** For `set_pref`: the screened, typed preference writes the driver may apply verbatim. */
  prefs?: Array<{ key: string; value: PrefValue }>;
  /** For `get_pref`: the screened preference keys the driver may read. */
  keys?: string[];
}

/** The value shapes Chromium's settings API accepts for the preferences in {@link SAFE_PREFS}. */
export type PrefValue = boolean | number | string | string[];

/** Live, page-invisible ops that run over leak-free CDP (applied instantly). */
const LIVE_OPS: ReadonlySet<BrowserConfigOp> = new Set([
  'clear_cookies',
  'clear_all_cookies',
  'clear_site_data',
  'clear_cache',
  'set_permission',
  'set_downloads',
]);

/** Preference ops: one key read or written through the browser's own settings API. */
const PREF_OPS: ReadonlySet<BrowserConfigOp> = new Set(['set_pref', 'get_pref']);

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
  ['ads', 'content/ads'],
  ['automatic downloads', 'content/automaticDownloads'],
  ['clipboard', 'content/clipboard'],
  ['sensors', 'content/sensors'],
  ['motion sensors', 'content/sensors'],
  ['pdf', 'content/pdfDocuments'],
  ['pdfs', 'content/pdfDocuments'],
  ['permissions', 'content'],
  ['site permissions', 'content'],
  ['all sites', 'content/all'],
  ['site data', 'content/siteData'],
  ['downloads', 'downloads'],
  ['download', 'downloads'],
  ['autofill', 'autofill'],
  ['passwords', 'passwords'],
  ['password manager', 'passwords'],
  ['saved passwords', 'passwords'],
  ['payment methods', 'payments'],
  ['payments', 'payments'],
  ['credit cards', 'payments'],
  ['addresses', 'addresses'],
  ['address', 'addresses'],
  ['search', 'search'],
  ['search engine', 'search'],
  ['search engines', 'search'],
  ['default search engine', 'search'],
  ['on startup', 'onStartup'],
  ['startup', 'onStartup'],
  ['startup pages', 'onStartup'],
  ['home', 'appearance'],
  ['home page', 'appearance'],
  ['homepage', 'appearance'],
  ['home button', 'appearance'],
  ['bookmarks bar', 'appearance'],
  // Only the unambiguous deletion wordings: "history" on its own is as likely to mean reading it, and
  // this destination is a dialog whose primary button erases data.
  ['clear browsing data', 'clearBrowserData'],
  ['clear browsing history', 'clearBrowserData'],
  ['clear history', 'clearBrowserData'],
  ['safety check', 'safetyCheck'],
  ['ad privacy', 'adPrivacy'],
  ['privacy sandbox', 'adPrivacy'],
  ['accessibility', 'accessibility'],
  ['performance', 'performance'],
  ['memory', 'performance'],
  ['memory saver', 'performance'],
  // Backgrounds and other New Tab customisation live on the New Tab page, not in Appearance.
  ['new tab', '@new-tab'],
  ['new tab page', '@new-tab'],
  ['background', '@new-tab'],
  ['background image', '@new-tab'],
  ['wallpaper', '@new-tab'],
]);

interface SafePref {
  /** How the model's text becomes the typed value the settings API expects. */
  kind: 'boolean' | 'number' | 'string' | 'url' | 'url-list';
  /** For `number`/`string` keys: every accepted value, with what it means (quoted on a bad value). */
  choices?: ReadonlyArray<readonly [value: number | string, meaning: string]>;
}

const BOOLEAN: SafePref = { kind: 'boolean' };
const WEB_URL: SafePref = { kind: 'url' };
const WEB_URL_LIST: SafePref = { kind: 'url-list' };
const oneOf = (
  kind: 'number' | 'string',
  ...choices: Array<readonly [number | string, string]>
): SafePref => ({ kind, choices });

/**
 * The preferences the agent may read or write, and the complete set of values each one accepts.
 *
 * Chromium's settings API reaches hundreds of keys — `proxy`, `intl.accept_languages` and the font
 * families among them — so "whichever key the model names" is not a boundary, it is the absence of one.
 * This is therefore an ALLOW-LIST, built from keys that (a) the real settings UI writes, so the effect is
 * one a human could have produced from the same browser, and (b) have a CLOSED value domain: a boolean,
 * an enumeration, or an http(s) URL. That second property is what makes a value screen unnecessary on
 * this path — nothing free-form reaches the browser, so a page cannot talk the model into writing
 * arbitrary text into the profile the way it could into a settings text field.
 *
 * The identity and network layer is absent BY CONSTRUCTION and screened again by FINGERPRINT_TELLS:
 * languages/locale, timezone, proxy/PAC/DNS, WebRTC, user-agent, zoom, fonts and font sizes, screen
 * metrics. Three omissions are worth naming because they look like ordinary settings:
 *   - `hardware_acceleration_mode.enabled` swaps the GPU for SwiftShader, rewriting the WebGL
 *     vendor/renderer strings the persona declares.
 *   - `webkit.webprefs.encrypted_media_enabled` and the protected-media content default change what a
 *     DRM capability probe reports, and that probe carries a device identity.
 *   - `download.default_directory` names a filesystem path, which is outside the agent's file fence.
 *
 * Reads go through the same list as writes: a run's outcomes travel to a third-party model, so
 * `get_pref` on the proxy or the accept-languages string would be an exfiltration of the identity it
 * exists to protect.
 */
const SAFE_PREFS: ReadonlyMap<string, SafePref> = new Map<string, SafePref>([
  // Downloads.
  ['download.prompt_for_download', BOOLEAN],
  ['download_bubble.partial_view_enabled', BOOLEAN],

  // Autofill and payments.
  ['autofill.profile_enabled', BOOLEAN],
  ['autofill.credit_card_enabled', BOOLEAN],
  ['autofill.payment_cvc_storage', BOOLEAN],
  ['payments.can_make_payment_enabled', BOOLEAN],

  // Password manager.
  ['credentials_enable_service', BOOLEAN],
  ['credentials_enable_autosignin', BOOLEAN],
  ['profile.password_manager_leak_detection', BOOLEAN],

  // Safe Browsing and connection security.
  ['safebrowsing.enabled', BOOLEAN],
  ['safebrowsing.enhanced', BOOLEAN],
  ['safebrowsing.scout_reporting_enabled', BOOLEAN],
  ['https_only_mode_enabled', BOOLEAN],

  // Privacy.
  [
    'profile.cookie_controls_mode',
    oneOf(
      'number',
      [0, 'allow third-party cookies'],
      [1, 'block third-party cookies'],
      [2, 'block third-party cookies in Incognito only'],
    ),
  ],
  [
    'generated.cookie_default_content_setting',
    oneOf(
      'string',
      ['allow', 'sites may store cookies'],
      ['session_only', 'cookies are cleared when the browser closes'],
      ['block', 'no site may store cookies'],
    ),
  ],
  ['search.suggest_enabled', BOOLEAN],
  ['alternate_error_pages.enabled', BOOLEAN],
  ['url_keyed_anonymized_data_collection.enabled', BOOLEAN],
  ['privacy_sandbox.m1.topics_enabled', BOOLEAN],
  ['privacy_sandbox.m1.fledge_enabled', BOOLEAN],
  ['privacy_sandbox.m1.ad_measurement_enabled', BOOLEAN],
  ['safety_hub.unused_site_permissions_revocation.enabled', BOOLEAN],

  // Site settings. The allow/block DEFAULT for a content type is not a preference — the settings UI
  // writes it through its own site-settings handler — so these two reach the prompting style only, and
  // "block notifications for every site" stays a job for the content pages in SAFE_SETTINGS.
  [
    'generated.notification',
    oneOf(
      'number',
      [0, 'sites may ask, with the normal prompt'],
      [1, 'sites may ask, with a quieter prompt'],
      [2, 'quieter prompts on sites where they are usually dismissed'],
    ),
  ],
  [
    'generated.geolocation',
    oneOf(
      'number',
      [0, 'sites may ask, with the normal prompt'],
      [1, 'sites may ask, with a quieter prompt'],
      [2, 'quieter prompts on sites where they are usually dismissed'],
    ),
  ],
  ['plugins.always_open_pdf_externally', BOOLEAN],

  // Startup, home, and appearance.
  [
    'session.restore_on_startup',
    oneOf(
      'number',
      [1, 'continue where you left off'],
      [4, 'open the pages in session.startup_urls'],
      [5, 'open the New Tab page'],
    ),
  ],
  ['session.startup_urls', WEB_URL_LIST],
  ['homepage', WEB_URL],
  ['homepage_is_newtabpage', BOOLEAN],
  ['browser.show_home_button', BOOLEAN],
  ['bookmark_bar.show_on_all_tabs', BOOLEAN],
  ['browser.ctrl_tab_mru', BOOLEAN],

  // Text services. The language LIST is identity and stays out; whether the browser offers to translate
  // or checks spelling at all is not, and neither is observable to a page.
  ['translate.enabled', BOOLEAN],
  ['browser.enable_spellchecking', BOOLEAN],
  ['spellcheck.use_spelling_service', BOOLEAN],

  // Accessibility.
  ['settings.a11y.caretbrowsing.enabled', BOOLEAN],
  ['settings.a11y.focus_highlight', BOOLEAN],
  ['settings.a11y.enable_accessibility_image_labels', BOOLEAN],
  ['settings.a11y.overscroll_history_navigation', BOOLEAN],
  ['accessibility.captions.live_caption_enabled', BOOLEAN],

  // Performance and system.
  [
    'performance_tuning.high_efficiency_mode.state',
    oneOf('number', [0, 'memory saver off'], [2, 'memory saver on']),
  ],
  ['background_mode.enabled', BOOLEAN],
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
  // "System" is where Chromium keeps the proxy and the graphics stack, and on Linux the window frame
  // too — three different ways into the identity layer behind one innocuous word.
  /\bsystem\b/,
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
  // Page zoom is not a cosmetic preference: it moves devicePixelRatio and innerWidth/innerHeight
  // off the values the persona declares, so the page measures a display the profile never claimed.
  /\bzoom\b/,
  /\bviewport[\s-]?size\b/,
  /\binner(width|height)\b/,
  // GPU / canvas / render fingerprint
  /\bcanvas\b/,
  /\bwebgl\b/,
  /\bwebgpu\b/,
  /\bgpu\b/,
  /\brenderer\b/,
  /\bunmasked\b/,
  // Turning hardware acceleration off is not a performance preference: Chromium falls back to
  // SwiftShader, and the WebGL vendor/renderer strings the persona declares change with it.
  /hardware[\s-]?acceleration/,
  // Audio / media fingerprint
  /audio[\s-]?(context|fingerprint)/,
  /media[\s-]?devices?/,
  /enumerate[\s-]?devices/,
  // A CDM capability probe carries a device identity, and its availability is directly observable.
  /(protected|encrypted)[\s-]?media/,
  /\bwidevine\b/,
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

/**
 * Canonicalize a preference key at the parse boundary, so the allow-list lookup, the approval prompt and
 * the journal entry all name the same setting. Chromium's keys are lower-case throughout.
 */
export function normalizePrefKey(raw?: string): string {
  return (raw ?? '').trim().toLowerCase();
}

/**
 * Read a key as the phrase it is. A tell written with dots and underscores — `intl.accept_languages`,
 * `webkit.webprefs.fonts.standard` — walks straight past patterns that expect words, so the separators
 * become spaces before the denylist sees it.
 */
function prefKeyPhrase(key: string): string {
  return key.replace(/[._-]+/g, ' ');
}

/**
 * Canonicalize a URL a preference will point the browser at (home page, startup pages).
 *
 * Only http(s) survives, and a bare host is promoted rather than rejected. A preference is not an
 * ordinary navigation: `chrome://policy` as the startup page would open a privileged WebUI on every
 * launch — the one page that can set enterprise policy, proxy included — and `javascript:` / `data:` /
 * `file:` would run supplied content with the browser's own first-party feel, all without the
 * navigation policy ever seeing a destination.
 */
function normalizePrefUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2_048) return '';
  const candidate = /^[a-z][a-z0-9+.-]*:/i.test(trimmed) ? trimmed : `https://${trimmed}`;
  let url: URL;
  try {
    url = new URL(candidate);
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
  const port = url.port ? `:${url.port}` : '';
  return `${url.protocol}//${originHost(host)}${port}${url.pathname}${url.search}${url.hash}`;
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

  // Preference surface. The key is screened for tells FIRST, so a request for the proxy or the language
  // list is refused as the hard limit it is rather than as an unknown key, and only then looked up in
  // the allow-list. Nothing unlisted reaches the browser, in either direction.
  if (PREF_OPS.has(op)) {
    const key = normalizePrefKey(action.pref);
    if (!key) return block(`${op} needs a "pref" naming the browser setting`);
    const tell = hasFingerprintTell(prefKeyPhrase(key));
    if (tell) return block(fingerprintRefusal(tell));
    const spec = SAFE_PREFS.get(key);
    if (!spec) {
      return block(
        `${JSON.stringify(key)} is not a preference the agent may touch. Available: ${[...SAFE_PREFS.keys()].join(', ')}. For anything else, open the area with open_settings and use the control.`,
      );
    }
    if (op === 'get_pref') return { verdict: 'allow', keys: [key] };
    const coerced = coercePrefValue(spec, action.value, action.values);
    if ('error' in coerced) return block(`${key} ${coerced.error}`);
    return { verdict: 'allow', prefs: [{ key, value: coerced.value }] };
  }

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

type CoercedPref = { value: PrefValue } | { error: string };

/**
 * Turn the model's text into the typed value the settings API expects, or explain what the preference
 * accepts. The rejection is deterministic and happens BEFORE the durable write barrier, so a mistyped
 * value costs a step and never a half-applied setting: the driver verifies by read-back, and a value the
 * browser silently coerced would read back as "applied" while meaning something else.
 */
function coercePrefValue(
  spec: SafePref,
  raw: string | undefined,
  list: string[] | undefined,
): CoercedPref {
  if (spec.kind === 'url-list') {
    const entries = list ?? (raw ? [raw] : []);
    const urls = entries.map((entry) => normalizePrefUrl(entry));
    if (urls.length === 0 || urls.some((url) => !url)) {
      return { error: 'takes http(s) page URLs in "values"' };
    }
    return { value: urls };
  }
  const text = (raw ?? '').trim();
  if (!text) return { error: 'needs a "value"' };
  if (spec.kind === 'url') {
    const url = normalizePrefUrl(text);
    return url ? { value: url } : { error: 'takes one http(s) page URL' };
  }
  if (spec.kind === 'boolean') {
    const lower = text.toLowerCase();
    if (['true', 'on', 'yes', 'enable', 'enabled', '1'].includes(lower)) return { value: true };
    if (['false', 'off', 'no', 'disable', 'disabled', '0'].includes(lower)) return { value: false };
    return { error: 'accepts true or false' };
  }
  const choices = spec.choices ?? [];
  const wanted = spec.kind === 'number' ? Number(text) : text.toLowerCase();
  const chosen = choices.find(([value]) => value === wanted);
  return chosen
    ? { value: chosen[0] }
    : {
        error: `accepts ${choices.map(([value, meaning]) => `${JSON.stringify(value)} (${meaning})`).join(', ')}`,
      };
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
  if (path) return `chrome://settings/${path}`;
  // A named area is a destination; anything with URL punctuation is an attempt to pick the destination
  // directly, and that is what the allow-list exists to prevent. Refuse it rather than searching for it.
  if (/[:/\\?#]/.test(key)) return null;
  return settingsSearchTarget(key);
}

/**
 * The last resort for a control whose area simply has no synonym above.
 *
 * The allow-list enumerates DESTINATIONS, not settings, so a perfectly safe control could dead-end just
 * because nobody had thought of the word for it. Searching lands on `chrome://settings/` — a page that
 * changes nothing by itself — and lets the agent find the control the way a person would. It does not
 * widen the boundary: the words have already cleared the denylist, only plain words survive (so a query
 * can never smuggle a path or a second URL), and the moment a result navigates into a non-vetted
 * subsection the loop refuses to act there.
 */
function settingsSearchTarget(value: string): string | null {
  const terms = value
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .slice(0, 60)
    .trim();
  return terms ? `chrome://settings/?search=${encodeURIComponent(terms)}` : null;
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
  // Matched on any part of a segment, not the whole word: `content/localFonts` and `content/zoomLevels`
  // are subsections of an allowed base, so a whole-segment test would have let the fingerprint layer in
  // through the front door of the page it guards.
  if (/(^|\/)\p{L}*(languages?|fonts?|zoom|system|proxy)/iu.test(path)) return false;
  // The settings root — with or without a `?search=` query — is the landing page of the search fallback.
  // It carries no control of its own, and every subsection it links to is judged on its own URL.
  if (path === '') return true;
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
