import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseAction } from './actions.js';
import {
  assessBrowserConfig,
  assessUiSettingsIntent,
  isVettedBrowserConfigUrl,
  normalizeBrowserPermission,
} from './browser-config-guard.js';
import { actionRisk } from './policy.js';
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
