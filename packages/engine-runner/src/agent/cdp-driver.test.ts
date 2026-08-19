import assert from 'node:assert/strict';
import { test } from 'node:test';
import { CdpBrowserDriver, selectInitialTarget } from './cdp-driver.js';
import type { CdpTarget, PersistentCdpSession } from './persistent-cdp.js';

const target = (id: string, url: string, title = ''): CdpTarget => ({
  id,
  type: 'page',
  title,
  url,
  webSocketDebuggerUrl: `ws://127.0.0.1/${id}`,
});

function session(send: PersistentCdpSession['send'] = async () => ({})): PersistentCdpSession {
  return { send, closed: new Promise<void>(() => {}), close() {} };
}

function driver(
  browser: PersistentCdpSession,
  page: PersistentCdpSession = session(),
): CdpBrowserDriver {
  const initial = target('web', 'https://example.test/');
  const Constructor = CdpBrowserDriver as unknown as new (
    browserWs: string,
    browser: PersistentCdpSession,
    page: PersistentCdpSession,
    target: CdpTarget,
    targets: CdpTarget[],
  ) => CdpBrowserDriver;
  return new Constructor('ws://127.0.0.1/browser', browser, page, initial, [initial]);
}

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

test('permission CDP calls always carry a canonical site origin', async () => {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  const instance = driver(
    session(async (method, params) => {
      calls.push({ method, ...(params ? { params } : {}) });
      return {};
    }),
  );

  await assert.rejects(
    instance.browserConfig({
      op: 'set_permission',
      origin: ':',
      permission: 'camera',
      setting: 'granted',
    }),
    /valid non-empty HTTP\(S\) origin/,
  );
  assert.equal(calls.length, 0, 'invalid input must never reach Browser.setPermission');

  await instance.browserConfig({
    op: 'set_permission',
    origin: 'HTTPS://Example.COM.:443/path?ignored=1',
    permission: 'camera',
    setting: 'granted',
  });
  assert.deepEqual(calls, [
    {
      method: 'Browser.setPermission',
      params: {
        permission: { name: 'camera' },
        setting: 'granted',
        origin: 'https://example.com',
      },
    },
  ]);
});

test('cookie CDP calls reject broad public/private suffix scopes before reading the store', async () => {
  let browserCalls = 0;
  const instance = driver(
    session(async () => {
      browserCalls += 1;
      return { cookies: [] };
    }),
  );

  for (const domain of ['com', 'co.uk', 'github.io', 'pages.dev']) {
    await assert.rejects(
      instance.browserConfig({ op: 'clear_cookies', domain }),
      /specific site domain/,
      domain,
    );
  }
  assert.equal(browserCalls, 0);
});

test('modifier chords dispatch as shortcuts, not as typed characters', async () => {
  const events: Array<Record<string, unknown>> = [];
  const instance = driver(
    session(),
    session(async (method, params) => {
      if (method === 'Input.dispatchKeyEvent') events.push(params as Record<string, unknown>);
      return {};
    }),
  );

  // A site whose primary submit is Ctrl+Enter — every modern composer — could not be driven at all,
  // and sending `text` under a Control/Meta modifier types the letter instead of invoking the
  // shortcut, so Ctrl+C would have inserted "c" into the focused field.
  await instance.pressKey('Control+Enter');
  await instance.pressKey('Meta+C');
  await instance.pressKey('Shift+Enter');

  const down = events.filter((event) => event.type === 'keyDown');
  assert.deepEqual(
    down.map((event) => [event.key, event.code, event.modifiers, event.text]),
    [
      ['Enter', 'Enter', 2, undefined],
      ['c', 'KeyC', 4, undefined],
      ['Enter', 'Enter', 8, undefined],
    ],
  );
  assert.equal(events.filter((event) => event.type === 'keyUp').length, 3);
});
