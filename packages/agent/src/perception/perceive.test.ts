import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BrowserDriver } from '../driver.js';
import { urlIdentity } from '../security.js';
import { EXTRACT_SCRIPT } from './extract-script.js';
import { perceive } from './perceive.js';

function driverWith(overrides: Partial<BrowserDriver>): BrowserDriver {
  return overrides as BrowserDriver;
}

test('a failed page read redacts and bounds its fallback URL and error', async () => {
  const driver = driverWith({
    evaluate: async () => {
      throw new Error(
        `failed at https://example.test/callback?code=${'secret-code'.repeat(100)}&state=ok`,
      );
    },
    currentUrl: async () =>
      `https://example.test/callback?code=${'secret-code'.repeat(1000)}&state=ok`,
  });
  const raw = await perceive(driver);

  assert.doesNotMatch(JSON.stringify(raw), /secret-code/);
  assert.match(raw.url, /code=%5BREDACTED%5D/);
  assert.match(raw.text ?? '', /code=\[REDACTED\]/);
  assert.ok(raw.url.length <= 8192);
  assert.ok((raw.text ?? '').length < 600);
});

test('an in-page exception is an unreadable page, not a page with nothing on it', async () => {
  // The extract script runs in the page's main world, so a page-defined global or a patched
  // prototype makes the walk throw and its top-level catch returns instead of rejecting. Reporting
  // that as an empty page is a false claim about the page, and it silently satisfies the ONLY check
  // post-action verification makes before certifying an irreversible action as observed.
  const raw = await perceive(
    driverWith({
      evaluate: async <T>() =>
        ({ error: "Cannot read properties of undefined (reading 'escape')" }) as T,
      currentUrl: async () => 'https://shop.example/checkout',
    }),
  );

  assert.deepEqual(raw.elements, []);
  assert.ok(
    raw.signals?.includes('page-unreadable'),
    'a read that produced no page must raise the model-facing unreadable signal',
  );
  assert.match(raw.text ?? '', /could not be read/);
  assert.match(raw.text ?? '', /escape/);
});

test('redacted URLs retain a private identity that distinguishes hidden credential changes', async () => {
  const make = async (token: string) =>
    perceive(
      driverWith({
        evaluate: async <T>() =>
          ({
            url: `https://example.test/callback?code=${token}`,
            title: 'Callback',
            scrollY: 0,
            viewportH: 800,
            docH: 800,
            canScrollUp: false,
            canScrollDown: false,
            truncated: 0,
            elements: [],
          }) as T,
      }),
    );
  const first = await make('first-secret-code');
  const second = await make('second-secret-code');

  assert.equal(first.url, second.url);
  assert.ok(first.urlIdentity);
  assert.notEqual(first.urlIdentity, second.urlIdentity);
  assert.doesNotMatch(JSON.stringify(first), /first-secret-code/);
});

test('page identity is the digest of the same raw URL the driver reports', async () => {
  // The loop compares this digest with `urlIdentity(await driver.currentUrl())` before every action and
  // again after it. `currentUrl()` is unredacted, so an identity taken over the redacted spelling can
  // never match on a page carrying one of the hidden query keys — an OAuth callback, an `?authuser=`
  // Google property, a plain `?keyword=` search — and every action on such a page is refused as drift.
  const live = 'https://example.test/callback?code=live-oauth-code&keyword=shoes';
  const raw = await perceive(
    driverWith({
      evaluate: async <T>() =>
        ({
          url: live,
          title: 'Callback',
          scrollY: 0,
          viewportH: 800,
          docH: 800,
          canScrollUp: false,
          canScrollDown: false,
          truncated: 0,
          elements: [],
        }) as T,
      currentUrl: async () => live,
    }),
  );

  assert.equal(raw.urlIdentity, urlIdentity(live));
  assert.doesNotMatch(raw.url, /live-oauth-code/);
  assert.match(raw.url, /code=%5BREDACTED%5D/);
});

test('the extraction script hands its location over unredacted for the caller to redact', () => {
  // Redacting in the page would give the run two different spellings of "which page is this" and only
  // one of them can match the driver's. This is the seam the identity contract above rests on, and it
  // cannot be exercised without a browser, so pin the source.
  assert.match(EXTRACT_SCRIPT, /\n\s+url: location\.href,\n/);
});

test('about:blank is synthetic and never exposes inherited DOM content', async () => {
  const raw = await perceive(
    driverWith({
      evaluate: async <T>() =>
        ({
          url: 'about:blank',
          title: 'Written by a file opener',
          text: 'PRIVATE-INHERITED-CONTENT',
          scrollY: 0,
          viewportH: 800,
          docH: 800,
          canScrollUp: false,
          canScrollDown: false,
          truncated: 0,
          elements: [
            {
              index: 0,
              tag: 'button',
              role: 'button',
              name: 'Exfiltrate inherited data',
              x: 10,
              y: 10,
              w: 100,
              h: 30,
            },
          ],
        }) as T,
    }),
  );

  assert.equal(raw.url, 'about:blank');
  assert.equal(raw.title, 'Blank page');
  assert.equal(raw.text, undefined);
  assert.deepEqual(raw.elements, []);
  assert.deepEqual(raw.signals, ['blank-page']);
  assert.doesNotMatch(JSON.stringify(raw), /PRIVATE|Exfiltrate/);
});
