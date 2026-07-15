import assert from 'node:assert/strict';
import test from 'node:test';
import type { CookieImportDraft } from '@lobster/shared-types';
import {
  type CdpCookieParam,
  applyCookieImport,
  cdpCookiesFromDraft,
  exportCookies,
  parseCookieText,
  toCdpCookie,
} from './cookie-inject.js';

const JSON_COOKIES = JSON.stringify([
  {
    name: 'sid',
    value: 'abc123',
    domain: '.example.com',
    path: '/',
    expires: 4102444800,
    httpOnly: true,
    secure: true,
    sameSite: 'Lax',
  },
  { name: 'tmp', value: 'z', domain: 'example.com', path: '/app', expires: -1, secure: false },
]);

const NETSCAPE_COOKIES = [
  '# Netscape HTTP Cookie File',
  '#HttpOnly_.example.com\tTRUE\t/\tTRUE\t4102444800\tsid\tabc123',
  'example.com\tFALSE\t/app\tFALSE\t0\ttmp\tz',
].join('\n');

test('parseCookieText auto-detects JSON vs Netscape', () => {
  assert.equal(parseCookieText(JSON_COOKIES).length, 2);
  assert.equal(parseCookieText(NETSCAPE_COOKIES).length, 2);
  const j = parseCookieText(JSON_COOKIES)[0]!;
  assert.equal(j.name, 'sid');
  assert.equal(j.domain, '.example.com');
  assert.equal(j.httpOnly, true);
});

test('toCdpCookie preserves domain-vs-host-only scope and keeps session cookies expiry-less', () => {
  const withDot = toCdpCookie({
    name: 'a',
    value: '1',
    domain: '.example.com',
    path: '/',
    httpOnly: false,
    secure: true,
  });
  assert.equal(withDot.domain, '.example.com');
  assert.equal(withDot.url, undefined);
  assert.equal(withDot.expires, undefined);
  const withExp = toCdpCookie({
    name: 'a',
    value: '1',
    domain: 'x.com',
    path: '/',
    httpOnly: false,
    secure: true,
    expires: 123,
  });
  assert.equal(withExp.domain, undefined);
  assert.equal(withExp.url, 'https://x.com/');
  assert.equal(withExp.expires, 123);
});

test('invalid cookie security combinations fail before an all-or-nothing CDP injection', () => {
  assert.throws(
    () =>
      cdpCookiesFromDraft({
        mode: 'merge',
        rawText: JSON.stringify([
          {
            name: '__Secure-session',
            value: 'v',
            domain: 'example.com',
            path: '/',
            secure: false,
            sameSite: 'None',
          },
        ]),
      }),
    /SameSite=None requires Secure.*__Secure- cookies require Secure/,
  );
});

test('cdpCookiesFromDraft honors mode and empty/absent drafts', () => {
  assert.deepEqual(cdpCookiesFromDraft(undefined), []);
  assert.deepEqual(cdpCookiesFromDraft({ mode: 'empty' }), []);
  assert.deepEqual(cdpCookiesFromDraft({ mode: 'merge', rawText: '   ' }), []);
  const merged = cdpCookiesFromDraft({ mode: 'merge', rawText: JSON_COOKIES });
  assert.equal(merged.length, 2);
  assert.equal(merged[0]!.name, 'sid');
});

/** A fake CDP session recording the calls the launcher would make. */
function fakeCdp() {
  const calls: Array<{ method: string; params?: unknown }> = [];
  return {
    calls,
    send(method: string, params?: Record<string, unknown>) {
      calls.push({ method, params });
      if (method === 'Network.getAllCookies') {
        return Promise.resolve({
          cookies: [
            {
              name: 'sid',
              value: 'abc',
              domain: '.example.com',
              path: '/',
              expires: 4102444800,
              httpOnly: true,
              secure: true,
              session: false,
              sameSite: 'Lax',
            },
            {
              name: 'tmp',
              value: 'z',
              domain: 'example.com',
              path: '/',
              expires: -1,
              httpOnly: false,
              secure: false,
              session: true,
            },
          ],
        });
      }
      return Promise.resolve(null);
    },
  };
}

test('applyCookieImport injects parsed cookies via Network.setCookies', async () => {
  const cdp = fakeCdp();
  const draft: CookieImportDraft = { mode: 'merge', rawText: JSON_COOKIES };
  const n = await applyCookieImport(cdp, draft);
  assert.equal(n, 2);
  const setCall = cdp.calls.find((c) => c.method === 'Network.setCookies');
  assert.ok(setCall, 'must call Network.setCookies');
  const cookies = (setCall!.params as { cookies: CdpCookieParam[] }).cookies;
  assert.equal(cookies.length, 2);
});

test('applyCookieImport with mode=replace clears the jar first', async () => {
  const cdp = fakeCdp();
  await applyCookieImport(cdp, { mode: 'replace', rawText: JSON_COOKIES });
  assert.equal(cdp.calls[0]!.method, 'Network.clearBrowserCookies');
  assert.ok(cdp.calls.some((c) => c.method === 'Network.setCookies'));
});

test('applyCookieImport with empty draft injects nothing', async () => {
  const cdp = fakeCdp();
  const n = await applyCookieImport(cdp, { mode: 'empty' });
  assert.equal(n, 0);
  assert.equal(cdp.calls.filter((c) => c.method === 'Network.setCookies').length, 0);
  assert.equal(cdp.calls[0]?.method, 'Network.clearBrowserCookies');
});

test('failed injection rejects so the caller can preserve the pending one-shot import', async () => {
  const cdp = {
    send(method: string): Promise<unknown> {
      return method === 'Network.setCookies'
        ? Promise.reject(new Error('browser rejected cookies'))
        : Promise.resolve(null);
    },
  };
  await assert.rejects(
    () => applyCookieImport(cdp, { mode: 'merge', rawText: JSON_COOKIES }),
    /browser rejected cookies/,
  );
});

test('exportCookies maps CDP cookies back to canonical, session cookies expiry-less', async () => {
  const cdp = fakeCdp();
  const cookies = await exportCookies(cdp);
  assert.equal(cookies.length, 2);
  const sid = cookies.find((c) => c.name === 'sid')!;
  const tmp = cookies.find((c) => c.name === 'tmp')!;
  assert.equal(sid.expires, 4102444800);
  assert.equal(tmp.expires, undefined, 'session cookie has no expiry');
});
