import assert from 'node:assert/strict';
import { test } from 'node:test';
import { selectInitialTarget } from './cdp-driver.js';
import type { CdpTarget } from './persistent-cdp.js';

const target = (id: string, url: string, title = ''): CdpTarget => ({
  id,
  type: 'page',
  title,
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1/${id}`,
});

test('initial target selection never drives Lobee itself and prefers a real web tab', () => {
  const chosen = selectInitialTarget([
    target('panel', 'chrome-extension://lobee/sidepanel.html', 'Lobee'),
    target('blank', 'about:blank'),
    target('settings', 'chrome://settings/privacy', 'Settings'),
    target('web', 'https://example.test/account', 'Account'),
  ]);
  assert.equal(chosen?.id, 'web');
});

test('target selection falls back to safe browser UI then blank, never an extension target', () => {
  assert.equal(
    selectInitialTarget([
      target('panel', 'chrome-extension://lobee/sidepanel.html', 'Lobee'),
      target('settings', 'chrome://settings/privacy', 'Settings'),
    ])?.id,
    'settings',
  );
  assert.equal(
    selectInitialTarget([
      target('panel', 'chrome-extension://lobee/sidepanel.html', 'Lobee'),
      target('blank', 'about:blank'),
    ])?.id,
    'blank',
  );
  assert.equal(
    selectInitialTarget([target('panel', 'chrome-extension://lobee/sidepanel.html', 'Lobee')]),
    undefined,
  );
});
