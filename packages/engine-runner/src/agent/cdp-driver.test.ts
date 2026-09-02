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

test('an empty preference batch never opens the privileged settings page', async () => {
  // The WebUI page is the one context where the browser's own settings API exists, so it is only ever
  // worth creating for work that exists. A batch with nothing in it is a caller bug, and answering it
  // with a target creation would put a privileged page on screen for no change at all.
  let calls = 0;
  const instance = driver(
    session(async () => {
      calls += 1;
      return {};
    }),
  );

  await assert.rejects(
    instance.browserConfig({ op: 'set_prefs', prefs: [] }),
    /at least one preference/,
  );
  await assert.rejects(instance.browserConfig({ op: 'get_prefs', keys: [] }), /at least one key/);
  assert.equal(calls, 0);
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

const MICROSOFT_STORE = [
  { name: 'pref', domain: '.outlook.com', path: '/' },
  { name: 'MSPAuth', domain: 'login.live.com', path: '/' },
  { name: 'ESTSAUTH', domain: 'login.microsoftonline.com', path: '/' },
  { name: 'RPS', domain: '.office.com', path: '/' },
  { name: 'sid', domain: '.example.test', path: '/' },
];

test('list_cookies reports the store per registrable domain, most cookies first', async () => {
  const instance = driver(session(async () => ({ cookies: MICROSOFT_STORE })));
  const all = await instance.browserConfig({ op: 'list_cookies' });
  assert.match(all, /5 cookie\(s\) across 5 domain\(s\)/);
  assert.match(all, /live\.com \(1\)/);
  const one = await instance.browserConfig({ op: 'list_cookies', domain: 'outlook.com' });
  assert.equal(one, '1 cookie(s) across 1 domain(s): outlook.com (1)');
  assert.equal(
    await instance.browserConfig({ op: 'list_cookies', domain: 'nothing.test' }),
    'no cookies are set for nothing.test',
  );
});

test('clear_cookies with nothing to clear is an error that says where the session lives', async () => {
  // The owner's failure: "remove all cookies of outlook.com" while the login sits on live.com. A zero
  // count reported as success let the run finish "done" with Outlook still signed in.
  const store = MICROSOFT_STORE.filter((c) => c.domain !== '.outlook.com');
  const instance = driver(session(async () => ({ cookies: store })));
  await assert.rejects(
    instance.browserConfig({ op: 'clear_cookies', domain: 'outlook.com' }),
    (error: Error) => {
      assert.match(error.message, /no cookies are set for outlook\.com/);
      assert.match(error.message, /related cookies exist on .*live\.com \(1\)/);
      assert.match(error.message, /clear_session/);
      return true;
    },
  );
});

test('clear_session signs out of the whole login family, clears storage and reloads the tab', async () => {
  const pageCalls: Array<{ method: string; params?: Record<string, unknown> }> = [];
  let reads = 0;
  const browser = session(async (method) => {
    if (method !== 'Storage.getCookies') return {};
    reads += 1;
    // The first read is the live store; after deletion only the unrelated site remains.
    return { cookies: reads === 1 ? MICROSOFT_STORE : MICROSOFT_STORE.slice(4) };
  });
  const page = session(async (method, params) => {
    pageCalls.push({ method, ...(params ? { params } : {}) });
    if (method === 'Runtime.evaluate')
      return { result: { value: 'https://outlook.live.com/mail/0/' } };
    return {};
  });
  const instance = driver(browser, page);
  const outcome = await instance.browserConfig({ op: 'clear_session', site: 'outlook.com' });

  const deleted = pageCalls
    .filter((c) => c.method === 'Network.deleteCookies')
    .map((c) => c.params?.domain);
  assert.deepEqual(deleted, [
    '.outlook.com',
    'login.live.com',
    'login.microsoftonline.com',
    '.office.com',
  ]);
  assert.ok(!deleted.includes('.example.test'), "another site's session is untouched");
  const storageOrigins = pageCalls
    .filter((c) => c.method === 'Storage.clearDataForOrigin')
    .map((c) => c.params?.origin);
  assert.ok(storageOrigins.includes('https://live.com'));
  assert.ok(storageOrigins.includes('https://outlook.com'));
  assert.ok(!storageOrigins.includes('https://example.test'));
  assert.ok(
    pageCalls.some((c) => c.method === 'Page.reload'),
    'the tab on the site is reloaded',
  );
  assert.match(outcome, /cleared 4 cookie\(s\) and site storage for outlook\.com/);
  assert.match(outcome, /live\.com \(1\)/);
  assert.match(outcome, /reloaded the tab/);
  assert.doesNotMatch(outcome, /came back/);
});

test('clear_session on a site the user is not signed in to is an error, not a quiet success', async () => {
  const instance = driver(session(async () => ({ cookies: MICROSOFT_STORE.slice(4) })));
  await assert.rejects(
    instance.browserConfig({ op: 'clear_session', site: 'outlook.com' }),
    /no cookies are set for outlook\.com or its login domains/,
  );
});
