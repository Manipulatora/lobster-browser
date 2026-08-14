import assert from 'node:assert/strict';
import { test } from 'node:test';

let bin = {};
globalThis.window = {
  chrome: {
    storage: {
      local: {
        get: (defaults) =>
          Promise.resolve(
            Object.fromEntries(
              Object.entries(defaults).map(([key, value]) => [
                key,
                Object.prototype.hasOwnProperty.call(bin, key) ? bin[key] : value,
              ]),
            ),
          ),
        set: (values) => {
          Object.assign(bin, values);
          return Promise.resolve();
        },
      },
    },
  },
};
globalThis.chrome = globalThis.window.chrome;

const { parseAllowedDomains, store } = await import('./models.ts');

test('new panels use a review-first bounded policy', async () => {
  bin = {};
  const settings = await store.get();
  assert.equal(settings.autonomy, 'confirm');
  assert.deepEqual(settings.allowedDomains, []);
  assert.equal(settings.tokenBudget, 100_000);
});

test('run-policy settings survive panel storage and invalid values fail back to safe defaults', async () => {
  bin = {};
  store.set({
    autonomy: 'auto',
    allowedDomains: ['Example.COM', '*.accounts.example.com.'],
    tokenBudget: 50_000,
  });
  assert.deepEqual(await store.get(), {
    mode: 'agent',
    model: 'anthropic/claude-opus-4.8',
    effort: 'medium',
    autonomy: 'auto',
    allowedDomains: ['example.com', 'accounts.example.com'],
    tokenBudget: 50_000,
    threadId: '',
  });

  bin.autonomy = 'unsafe';
  bin.tokenBudget = -1;
  bin.allowedDomains = ['com'];
  const repaired = await store.get();
  assert.equal(repaired.autonomy, 'confirm');
  assert.equal(repaired.tokenBudget, 100_000);
  assert.deepEqual(
    repaired.allowedDomains,
    ['com'],
    'an invalid stored fence remains visible/blocked instead of becoming unrestricted',
  );

  bin.tokenBudget = null;
  assert.equal((await store.get()).tokenBudget, null, 'unlimited is an explicit persisted choice');
});

test('allowed-domain input is normalized, deduplicated, and bounded', () => {
  assert.deepEqual(parseAllowedDomains(' Example.com,*.EXAMPLE.com.  accounts.example.com '), {
    ok: true,
    domains: ['example.com', 'accounts.example.com'],
  });
  assert.deepEqual(parseAllowedDomains(''), { ok: true, domains: [] });
  assert.equal(parseAllowedDomains('com').ok, false, 'a public-suffix-like label is not a fence');
  assert.equal(
    parseAllowedDomains('co.uk').ok,
    false,
    'a multi-label public suffix is not a fence',
  );
  assert.equal(
    parseAllowedDomains('com.au').ok,
    false,
    'common country suffixes fail in the editor',
  );
  assert.equal(parseAllowedDomains('https://example.com').ok, false);
  const tooMany = parseAllowedDomains(
    Array.from({ length: 51 }, (_, index) => `d${index}.test`).join(','),
  );
  assert.equal(tooMany.ok, false, 'an oversized fence is rejected, never silently truncated');
});
