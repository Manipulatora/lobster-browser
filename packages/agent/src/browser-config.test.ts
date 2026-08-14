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
import { actionRisk } from './policy.js';
import { describeSafeAction } from './security.js';
import type { AgentAction } from '@lobster/shared-types';
import type { RawPerception } from './types.js';

type BrowserConfigAction = Extract<AgentAction, { kind: 'browser_config' }>;

function cfg(over: Record<string, unknown>): BrowserConfigAction {
  const result = parseAction({ kind: 'browser_config', ...over });
  if (!result.ok) throw new Error(`parse failed for ${JSON.stringify(over)}: ${result.error}`);
  if (result.action.kind !== 'browser_config') throw new Error('unexpected action kind');
  return result.action;
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
  const page = { elements: [] } as unknown as RawPerception;
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
