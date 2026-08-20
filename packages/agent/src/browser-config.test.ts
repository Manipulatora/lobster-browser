import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAction } from './actions.js';
import {
  assessBrowserConfig,
  isPrivilegedInternalUrl,
  assessUiSettingsIntent,
  isVettedBrowserConfigUrl,
  normalizeBrowserPermission,
  normalizeBrowserPermissionOrigin,
  normalizeCookieDomain,
} from './browser-config-guard.js';
import type { BrowserConfigCommand, BrowserDriver } from './driver.js';
import { executeAction } from './executor.js';
import { actionRisk } from './policy.js';
import { describeSafeAction } from './security.js';
import type { AgentAction } from '@lobster/shared-types';
import type { RawPerception } from './types.js';

type BrowserConfigAction = Extract<AgentAction, { kind: 'browser_config' }>;

const page = { elements: [] } as unknown as RawPerception;

function cfg(over: Record<string, unknown>): BrowserConfigAction {
  const result = parseAction({ kind: 'browser_config', ...over });
  if (!result.ok) throw new Error(`parse failed for ${JSON.stringify(over)}: ${result.error}`);
  if (result.action.kind !== 'browser_config') throw new Error('unexpected action kind');
  return result.action;
}

/** A driver that records what the config path actually handed the browser. */
function recordingDriver(commands: BrowserConfigCommand[], reply: string): BrowserDriver {
  return {
    browserConfig: async (command: BrowserConfigCommand) => {
      commands.push(command);
      return reply;
    },
    waitForSettle: async () => {},
  } as unknown as BrowserDriver;
}

test('browser_config parser enforces per-op required fields', () => {
  // clear_cookies needs a domain.
  assert.equal(parseAction({ kind: 'browser_config', op: 'clear_cookies' }).ok, false);
  assert.deepEqual(
    parseAction({ kind: 'browser_config', op: 'clear_cookies', domain: 'example.com' }),
    {
      ok: true,
      action: { kind: 'browser_config', op: 'clear_cookies', domain: 'example.com' },
    },
  );
  // clear_cache needs nothing.
  assert.equal(parseAction({ kind: 'browser_config', op: 'clear_cache' }).ok, true);
  assert.equal(parseAction({ kind: 'browser_config', op: 'clear_all_cookies' }).ok, true);
  // set_permission needs a permission, setting, and an origin/domain.
  assert.equal(parseAction({ kind: 'browser_config', op: 'set_permission' }).ok, false);
  assert.equal(
    parseAction({ kind: 'browser_config', op: 'set_permission', origin: 'https://a.com' }).ok,
    false,
  );
  assert.equal(
    parseAction({
      kind: 'browser_config',
      op: 'set_permission',
      origin: 'https://a.com',
      permission: 'geolocation',
      setting: 'granted',
    }).ok,
    true,
  );
  assert.equal(
    parseAction({
      kind: 'browser_config',
      op: 'set_permission',
      origin: 'https://a.com',
      permission: 'camera',
    }).ok,
    false,
  );
  // Unknown op and bad/missing enums are rejected instead of silently resetting the setting.
  assert.equal(parseAction({ kind: 'browser_config', op: 'nuke_everything' }).ok, false);
  assert.equal(
    parseAction({ kind: 'browser_config', op: 'set_downloads', behavior: 'sideways' }).ok,
    false,
  );
  assert.equal(parseAction({ kind: 'browser_config', op: 'set_downloads' }).ok, false);
  assert.equal(
    parseAction({ kind: 'browser_config', op: 'set_downloads', behavior: 'deny' }).ok,
    true,
  );
});

test('guard ALLOWS safe live ops — including a site literally named after a fingerprint token', () => {
  // A domain that contains "fonts" must still be clearable: live ops are not fingerprint-screened.
  assert.equal(
    assessBrowserConfig(cfg({ op: 'clear_cookies', domain: 'fonts.google.com' })).verdict,
    'allow',
  );
  assert.equal(assessBrowserConfig(cfg({ op: 'clear_cache' })).verdict, 'allow');
  assert.equal(assessBrowserConfig(cfg({ op: 'clear_all_cookies' })).verdict, 'allow');
  assert.equal(
    assessBrowserConfig(
      cfg({
        op: 'set_permission',
        origin: 'https://maps.example',
        permission: 'geolocation',
        setting: 'granted',
      }),
    ).verdict,
    'allow',
  );
});

test('guard REJECTS a non-permission masquerading as a site permission', () => {
  const verdict = assessBrowserConfig(
    cfg({ op: 'set_permission', origin: 'https://a.com', permission: 'webgl', setting: 'granted' }),
  );
  assert.equal(verdict.verdict, 'block');
  assert.match(verdict.reason ?? '', /not a grantable site permission/);
});

test('permission aliases normalize once and remain allowed by the safety guard', () => {
  const cases = [
    ['location', 'geolocation'],
    ['geo', 'geolocation'],
    ['notification', 'notifications'],
    ['mic', 'microphone'],
    ['webcam', 'camera'],
    ['clipboard', 'clipboard-read'],
    ['sensors', 'accelerometer'],
  ] as const;
  for (const [alias, canonical] of cases) {
    assert.equal(normalizeBrowserPermission(alias), canonical);
    const action = cfg({
      op: 'set_permission',
      origin: 'https://a.com',
      permission: alias,
      setting: 'granted',
    });
    assert.equal(action.permission, canonical);
    assert.equal(assessBrowserConfig(action).verdict, 'allow');
  }
});

test('set_permission requires and stores one canonical HTTP(S) origin', () => {
  for (const origin of [':', 'file:///tmp/page.html', 'data:text/html,hello', 'https://', '']) {
    assert.equal(
      parseAction({
        kind: 'browser_config',
        op: 'set_permission',
        origin,
        permission: 'camera',
        setting: 'granted',
      }).ok,
      false,
      origin,
    );
  }
  assert.equal(normalizeBrowserPermissionOrigin('https://user:pass@example.com/'), '');
  assert.equal(
    normalizeBrowserPermissionOrigin('HTTPS://ExAmPlE.COM.:443/a?q=1#x'),
    'https://example.com',
  );
  assert.equal(
    normalizeBrowserPermissionOrigin(undefined, 'BÜCHER.example.'),
    'https://xn--bcher-kva.example',
  );

  assert.deepEqual(
    parseAction({
      kind: 'browser_config',
      op: 'set_permission',
      origin: 'HTTPS://ExAmPlE.COM.:443/path?ignored=1',
      permission: 'camera',
      setting: 'granted',
    }),
    {
      ok: true,
      action: {
        kind: 'browser_config',
        op: 'set_permission',
        origin: 'https://example.com',
        permission: 'camera',
        setting: 'granted',
      },
    },
  );
  assert.deepEqual(
    parseAction({
      kind: 'browser_config',
      op: 'set_permission',
      domain: 'Example.COM.',
      permission: 'camera',
      setting: 'denied',
    }),
    {
      ok: true,
      action: {
        kind: 'browser_config',
        op: 'set_permission',
        origin: 'https://example.com',
        permission: 'camera',
        setting: 'denied',
      },
    },
  );

  const directMalformed = {
    kind: 'browser_config',
    op: 'set_permission',
    origin: ':',
    permission: 'camera',
    setting: 'granted',
  } as BrowserConfigAction;
  assert.equal(assessBrowserConfig(directMalformed).verdict, 'block');
  assert.match(
    describeSafeAction(
      cfg({
        op: 'set_permission',
        origin: 'https://example.com',
        permission: 'camera',
        setting: 'granted',
      }),
    ),
    /camera → granted for https:\/\/example\.com/,
  );
});

test('clear_cookies rejects public/private suffixes and canonicalizes a specific site', () => {
  for (const domain of ['com', 'co.uk', 'github.io', 'pages.dev', 'local', '*.example.com']) {
    assert.equal(
      parseAction({ kind: 'browser_config', op: 'clear_cookies', domain }).ok,
      false,
      domain,
    );
    assert.equal(normalizeCookieDomain(domain), '', domain);
  }
  for (const domain of [
    'example.com',
    'shop.example.com',
    'tenant.github.io',
    'localhost',
    'intranet',
  ]) {
    assert.notEqual(normalizeCookieDomain(domain), '', domain);
  }
  assert.deepEqual(
    parseAction({ kind: 'browser_config', op: 'clear_cookies', domain: '.BÜCHER.example.' }),
    {
      ok: true,
      action: {
        kind: 'browser_config',
        op: 'clear_cookies',
        domain: 'xn--bcher-kva.example',
      },
    },
  );

  const directBroad = {
    kind: 'browser_config',
    op: 'clear_cookies',
    domain: 'github.io',
  } as BrowserConfigAction;
  assert.equal(assessBrowserConfig(directBroad).verdict, 'block');
});

test('guard HARD-BLOCKS fingerprint/proxy tells on the settings surfaces (no override)', () => {
  // A settings op carrying a fingerprint-sensitive value is blocked outright.
  for (const value of [
    'timezone America/New_York',
    'user-agent Firefox',
    'proxy 1.2.3.4',
    'webrtc off',
    'canvas noise',
  ]) {
    const v = assessBrowserConfig(cfg({ op: 'set_privacy', value }));
    assert.equal(v.verdict, 'block', `expected block for ${value}`);
    assert.match(v.reason ?? '', /anti-detect|hard limit|no override/i);
  }
  // The chrome:// UI-intent screen blocks the same tells and allows benign settings.
  assert.equal(assessUiSettingsIntent('change the user agent string').verdict, 'block');
  assert.equal(assessUiSettingsIntent('configure the proxy').verdict, 'block');
  assert.equal(assessUiSettingsIntent('disable webrtc').verdict, 'block');
  assert.equal(assessUiSettingsIntent('turn on dark mode').verdict, 'allow');
  assert.equal(assessUiSettingsIntent('block third-party cookies by default').verdict, 'allow');
});

test('UI-fallback ops resolve to vetted chrome://settings URLs; identity pages are refused', () => {
  // Pref shortcuts map to fixed pages (applied live via the settings UI, not a relaunch).
  assert.equal(
    assessBrowserConfig(cfg({ op: 'set_theme', value: 'dark' })).settingsUrl,
    'chrome://settings/appearance',
  );
  assert.equal(
    assessBrowserConfig(cfg({ op: 'set_privacy' })).settingsUrl,
    'chrome://settings/privacy',
  );
  assert.equal(
    assessBrowserConfig(cfg({ op: 'set_content_default' })).settingsUrl,
    'chrome://settings/content',
  );
  // open_settings looks its area up in the allow-list (synonyms included).
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'notifications' })).settingsUrl,
    'chrome://settings/content/notifications',
  );
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'Downloads' })).settingsUrl,
    'chrome://settings/downloads',
  );
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'site settings' })).settingsUrl,
    'chrome://settings/content',
  );
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'background image' })).settingsUrl,
    'chrome://new-tab-page/',
  );
  // An identity/proxy area is not in the allow-list — hard-refused, and arbitrary chrome:// can't sneak in.
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'languages' })).verdict,
    'block',
  );
  assert.equal(assessBrowserConfig(cfg({ op: 'open_settings', value: 'proxy' })).verdict, 'block');
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'chrome://net-internals' })).verdict,
    'block',
  );
  assert.equal(assessBrowserConfig(cfg({ op: 'open_settings', value: 'system' })).verdict, 'block');
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/privacy?search=cookies'), true);
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content/all'), true);
  assert.equal(isVettedBrowserConfigUrl('chrome://new-tab-page/'), true);
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/languages'), false);
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/appearance/fonts'), false);
  assert.equal(isVettedBrowserConfigUrl('chrome://net-internals/'), false);
});

test('destructive config ops are annotated high-risk for confirm-mode prompts', () => {
  assert.equal(
    actionRisk(cfg({ op: 'clear_site_data', origin: 'https://a.com' }), page).high,
    true,
  );
  assert.equal(actionRisk(cfg({ op: 'clear_cookies', domain: 'a.com' }), page).high, true);
  assert.equal(actionRisk(cfg({ op: 'clear_all_cookies' }), page).high, true);
  assert.equal(actionRisk(cfg({ op: 'clear_cache' }), page).high, false);
});

test('a privileged internal page reached by accident is off limits, not a settings surface', () => {
  // The navigation policy refuses to OPEN these, but the agent can still arrive on one: by switching
  // to a tab the human left open, or by the driver adopting a popup. chrome://policy is the reason
  // this matters — its page context exposes setLocalTestPolicies, which applies enterprise policy
  // (proxy included) past every preference guard in browser-config-guard.ts.
  for (const url of [
    'chrome://policy/',
    'chrome://flags/',
    'chrome://history/',
    'chrome://version/',
    'chrome://settings/languages',
    'chrome://net-export/',
    'devtools://devtools/bundled/inspector.html',
    'chrome-extension://abcdefghijklmnopabcdefghijklmnop/page.html',
    'chrome-untrusted://terminal/',
  ]) {
    assert.equal(isPrivilegedInternalUrl(url), true, `${url} must be treated as privileged`);
    assert.equal(isVettedBrowserConfigUrl(url), false, `${url} must not be vetted`);
  }

  // Ordinary web pages and a blank tab are unaffected — this must not make normal browsing refuse.
  for (const url of ['https://example.com/', 'http://localhost:3000/x', 'about:blank']) {
    assert.equal(isPrivilegedInternalUrl(url), false, `${url} must stay ordinary`);
  }

  // The vetted settings pages the agent legitimately drives remain usable.
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/appearance'), true);
  assert.equal(isPrivilegedInternalUrl('chrome://settings/appearance'), true);
});

test('an allow-listed preference reaches the driver as a typed write', async () => {
  const commands: BrowserConfigCommand[] = [];
  const result = await executeAction(
    cfg({ op: 'set_pref', pref: 'Download.Prompt_For_Download', value: 'TRUE' }),
    page,
    recordingDriver(commands, 'applied and verified download.prompt_for_download'),
    {},
  );
  // The key is canonicalized once, at parse time, and the value arrives as the type Chromium wants —
  // the driver applies what it is given, so anything still ambiguous here would be ambiguous there.
  assert.deepEqual(commands, [
    { op: 'set_prefs', prefs: [{ key: 'download.prompt_for_download', value: true }] },
  ]);
  assert.match(result.outcome, /applied and verified/);
  assert.match(
    describeSafeAction(cfg({ op: 'set_pref', pref: 'safebrowsing.enabled', value: 'false' })),
    /set pref safebrowsing\.enabled → false/,
  );
  assert.equal(
    actionRisk(cfg({ op: 'set_pref', pref: 'safebrowsing.enabled', value: 'false' }), page)
      .consequential,
    true,
  );
});

test('get_pref reads back through the same allow-list, and reading is not a change', async () => {
  const commands: BrowserConfigCommand[] = [];
  const result = await executeAction(
    cfg({ op: 'get_pref', pref: 'safebrowsing.enabled' }),
    page,
    recordingDriver(commands, 'safebrowsing.enabled = true'),
    {},
  );
  assert.deepEqual(commands, [{ op: 'get_prefs', keys: ['safebrowsing.enabled'] }]);
  assert.match(result.outcome, /safebrowsing\.enabled = true/);
  assert.equal(
    actionRisk(cfg({ op: 'get_pref', pref: 'safebrowsing.enabled' }), page).consequential,
    false,
  );
});

test('a fingerprint or network preference is refused with no override, however it is spelled', () => {
  // A pref key writes its words with dots and underscores, so the denylist only sees them if the key is
  // read as the phrase it is. Every one of these is reachable through the settings API.
  for (const pref of [
    'intl.accept_languages',
    'intl.app_locale',
    'proxy',
    'dns_over_https.mode',
    'webrtc.ip_handling_policy',
    'profile.default_zoom_level',
    'webkit.webprefs.default_font_size',
    'webkit.webprefs.fonts.standard.Zyyy',
    'hardware_acceleration_mode.enabled',
    'webkit.webprefs.encrypted_media_enabled',
  ]) {
    const written = assessBrowserConfig(cfg({ op: 'set_pref', pref, value: 'true' }));
    assert.equal(written.verdict, 'block', pref);
    assert.match(written.reason ?? '', /anti-detect|hard limit|no override/i);
    assert.equal(written.prefs, undefined, pref);
    // Reading one is refused for the same reason: the answer leaves the machine in the model's context.
    const read = assessBrowserConfig(cfg({ op: 'get_pref', pref }));
    assert.equal(read.verdict, 'block', pref);
    assert.match(read.reason ?? '', /anti-detect|hard limit|no override/i);
  }
});

test('an unlisted preference is refused, with the settable keys and the way out', () => {
  // A filesystem destination is not a browser setting the agent may choose; the refusal still has to
  // leave the model somewhere useful, so it names the list and the settings-UI path.
  const verdict = assessBrowserConfig(
    cfg({ op: 'set_pref', pref: 'download.default_directory', value: '/tmp/anywhere' }),
  );
  assert.equal(verdict.verdict, 'block');
  assert.match(verdict.reason ?? '', /not a preference the agent may touch/);
  assert.match(verdict.reason ?? '', /download\.prompt_for_download/);
  assert.match(verdict.reason ?? '', /open_settings/);
  assert.equal(assessBrowserConfig(cfg({ op: 'get_pref', pref: 'kiosk.enable' })).verdict, 'block');
});

test('a preference value is closed: coerced to its own domain, or refused with that domain', () => {
  assert.deepEqual(
    assessBrowserConfig(cfg({ op: 'set_pref', pref: 'safebrowsing.enabled', value: 'off' })).prefs,
    [{ key: 'safebrowsing.enabled', value: false }],
  );
  const notBoolean = assessBrowserConfig(
    cfg({ op: 'set_pref', pref: 'safebrowsing.enabled', value: 'sometimes' }),
  );
  assert.equal(notBoolean.verdict, 'block');
  assert.match(notBoolean.reason ?? '', /accepts true or false/);

  assert.deepEqual(
    assessBrowserConfig(cfg({ op: 'set_pref', pref: 'profile.cookie_controls_mode', value: '1' }))
      .prefs,
    [{ key: 'profile.cookie_controls_mode', value: 1 }],
  );
  const notAChoice = assessBrowserConfig(
    cfg({ op: 'set_pref', pref: 'profile.cookie_controls_mode', value: '9' }),
  );
  assert.equal(notAChoice.verdict, 'block');
  assert.match(notAChoice.reason ?? '', /block third-party cookies/);

  // A URL-valued preference is a destination the browser opens unattended, so only http(s) survives:
  // chrome://policy as the home page would put a privileged WebUI one keystroke from every launch.
  assert.deepEqual(
    assessBrowserConfig(cfg({ op: 'set_pref', pref: 'homepage', value: 'Example.COM/start' }))
      .prefs,
    [{ key: 'homepage', value: 'https://example.com/start' }],
  );
  for (const value of [
    'chrome://policy',
    'javascript:alert(1)',
    'file:///etc/passwd',
    'data:text/html,x',
    'https://user:pass@example.com/',
  ]) {
    assert.equal(
      assessBrowserConfig(cfg({ op: 'set_pref', pref: 'homepage', value })).verdict,
      'block',
      value,
    );
  }
  assert.deepEqual(
    assessBrowserConfig(
      cfg({
        op: 'set_pref',
        pref: 'session.startup_urls',
        values: ['example.com', 'https://b.test/x'],
      }),
    ).prefs,
    [{ key: 'session.startup_urls', value: ['https://example.com/', 'https://b.test/x'] }],
  );
  assert.equal(
    assessBrowserConfig(
      cfg({ op: 'set_pref', pref: 'session.startup_urls', values: ['chrome://policy'] }),
    ).verdict,
    'block',
  );
  // The op still needs its arguments: neither half is optional.
  assert.equal(parseAction({ kind: 'browser_config', op: 'set_pref' }).ok, false);
  assert.equal(parseAction({ kind: 'browser_config', op: 'set_pref', pref: 'homepage' }).ok, false);
  assert.equal(parseAction({ kind: 'browser_config', op: 'get_pref' }).ok, false);
});

test('every listed preference and settings area is actually reachable', () => {
  // Both lists sit BEHIND the fingerprint screen, and both are quoted to the model as what it may use.
  // An entry that the screen rejects, or an area whose page the loop then refuses to act on, would be
  // dead weight the model spends steps discovering — so the promise and the reality are checked here.
  const prefRefusal = assessBrowserConfig(cfg({ op: 'get_pref', pref: 'not.a.real.pref' }));
  const keys = (prefRefusal.reason ?? '')
    .replace(/^.*Available: /, '')
    .replace(/\. For anything else.*$/, '')
    .split(', ');
  assert.ok(keys.length > 30, `expected the whole preference list, saw ${keys.length}`);
  for (const key of keys) {
    assert.equal(assessBrowserConfig(cfg({ op: 'get_pref', pref: key })).verdict, 'allow', key);
  }

  const areaRefusal = assessBrowserConfig(cfg({ op: 'open_settings', value: '???' }));
  assert.equal(areaRefusal.verdict, 'block');
  const areas = (areaRefusal.reason ?? '')
    .replace(/^.*Openable areas: /, '')
    .replace(/\.$/, '')
    .split(', ');
  assert.ok(areas.length > 30, `expected the whole area list, saw ${areas.length}`);
  for (const area of areas) {
    const url = assessBrowserConfig(cfg({ op: 'open_settings', value: area })).settingsUrl;
    assert.ok(url, `${area} must resolve to a page`);
    assert.equal(isVettedBrowserConfigUrl(url ?? ''), true, `${area} → ${url} must be actionable`);
  }
});

test('the settings surface reaches more real areas, and an unnamed one searches instead of dead-ending', () => {
  for (const [area, path] of [
    ['password manager', 'passwords'],
    ['clear browsing data', 'clearBrowserData'],
    ['ad privacy', 'adPrivacy'],
    ['safety check', 'safetyCheck'],
    ['automatic downloads', 'content/automaticDownloads'],
    ['default search engine', 'search'],
    ['startup pages', 'onStartup'],
  ] as const) {
    assert.equal(
      assessBrowserConfig(cfg({ op: 'open_settings', value: area })).settingsUrl,
      `chrome://settings/${path}`,
      area,
    );
  }

  // An area nobody wrote a synonym for lands on the settings search, which is a page the agent may
  // legitimately act on — it is the same place a person would start from.
  const searched = assessBrowserConfig(cfg({ op: 'open_settings', value: 'autoplay' }));
  assert.equal(searched.settingsUrl, 'chrome://settings/?search=autoplay');
  assert.equal(isVettedBrowserConfigUrl(searched.settingsUrl ?? ''), true);

  // The search is not a second way to name a destination, and it never survives a fingerprint tell.
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'chrome://net-internals' })).verdict,
    'block',
  );
  assert.equal(
    assessBrowserConfig(cfg({ op: 'open_settings', value: 'font size' })).verdict,
    'block',
  );
  // Identity subsections of an allowed base are not covered by the base.
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content/zoomLevels'), false);
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content/localFonts'), false);
});

test('page zoom is treated as a display-metric change, not an appearance preference', () => {
  // Zoom moves devicePixelRatio and innerWidth/innerHeight off the persona's declared display, so
  // it belongs with screen/resolution rather than with theme and font size.
  assert.equal(assessUiSettingsIntent('set the page zoom to 150%').verdict, 'block');
  assert.equal(assessUiSettingsIntent('zoom in').verdict, 'block');
  // The area itself is no longer reachable, so it cannot be opened and changed by hand either.
  const opened = assessBrowserConfig(cfg({ op: 'open_settings', value: 'zoom' }));
  assert.equal(opened.verdict, 'block');
  // Neighbouring appearance settings are unaffected.
  assert.equal(assessUiSettingsIntent('turn on dark mode').verdict, 'allow');
});

test('a preference URL may not point the browser at the local network', () => {
  // The browser opens a start page by itself, outside the agent loop, so assessNavigation never sees
  // it. This guard is the only fence between a preference and the cloud metadata service.
  for (const host of [
    'http://169.254.169.254/latest/meta-data/iam/security-credentials/',
    'http://127.0.0.1:8080/',
    'http://[::1]/',
    'http://localhost/admin',
    'http://10.0.0.5/',
    'http://192.168.1.1/',
    'http://metadata.google.internal/computeMetadata/v1/',
  ]) {
    assert.equal(
      assessBrowserConfig(cfg({ op: 'set_pref', pref: 'homepage', value: host })).verdict,
      'block',
      `homepage accepted ${host}`,
    );
    assert.equal(
      assessBrowserConfig(cfg({ op: 'set_pref', pref: 'session.startup_urls', values: [host] }))
        .verdict,
      'block',
      `startup_urls accepted ${host}`,
    );
  }
  // A public destination is still allowed, or the setting would be useless.
  assert.equal(
    assessBrowserConfig(cfg({ op: 'set_pref', pref: 'homepage', value: 'https://example.com/' }))
      .verdict,
    'allow',
  );
});

test('the protected-content identity page is not reachable, by URL or by label', () => {
  // A per-device Widevine identifier is exactly what ADR-0002 hard-blocks, and it lives under the
  // `content` page the guard otherwise allows.
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content/protectedContent'), false);
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content/localFonts'), false);
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content/zoomLevels'), false);
  // The pages it does allow keep working, including the base itself.
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content'), true);
  assert.equal(isVettedBrowserConfigUrl('chrome://settings/content/notifications'), true);
  // Chrome's own wording, which is what a model reads off the page.
  for (const phrase of [
    'Sites can play protected content',
    'To play content protected by copyright, sites may need to use a content protection service',
    'open protected content settings',
  ]) {
    assert.equal(assessUiSettingsIntent(phrase).verdict, 'block', `intent allowed: ${phrase}`);
  }
});
