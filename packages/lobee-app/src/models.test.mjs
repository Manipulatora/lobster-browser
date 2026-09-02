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

const { FALLBACK_MODELS, newThreadId, parseAllowedDomains, store } = await import('./models.ts');

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

test('the offline fallback roster is pinned to the seven managed models, all unavailable', () => {
  assert.deepEqual(
    FALLBACK_MODELS.map((model) => model.id),
    [
      'openai/gpt-5.6-sol',
      'openai/gpt-5.6-terra',
      'openai/gpt-5.6-luna',
      'anthropic/claude-fable-5',
      'anthropic/claude-opus-5',
      'anthropic/claude-opus-4.8',
      'anthropic/claude-sonnet-5',
    ],
  );
  assert.deepEqual(
    FALLBACK_MODELS.map((model) => model.label),
    [
      'GPT 5.6 Sol',
      'GPT 5.6 Terra',
      'GPT 5.6 Luna',
      'Claude Fable 5',
      'Claude Opus 5',
      'Claude Opus 4.8',
      'Claude Sonnet 5',
    ],
  );
  // Fallback entries must stay unselectable until the live roster confirms them (see App.tsx).
  assert.equal(
    FALLBACK_MODELS.every((model) => !model.available && !model.agentCapable),
    true,
  );
});

test('settings no longer persist a conversation: none stored loads cleanly, legacy ids are ignored', async () => {
  bin = {};
  const fresh = await store.get();
  assert.equal('threadId' in fresh, false);

  // A panel that last ran before per-submit conversations may still have a threadId in storage.
  bin = { threadId: 'tlegacyabc123', mode: 'ask' };
  const migrated = await store.get();
  assert.equal(migrated.mode, 'ask', 'the rest of the stored settings still load');
  assert.equal('threadId' in migrated, false, 'the stale conversation id is not resurrected');
});

test('every conversation id is minted fresh — two submits can never share one', () => {
  const first = newThreadId();
  const second = newThreadId();
  assert.notEqual(first, second);
  // The sidecar accepts these as memory filenames, so the charset is part of the contract.
  assert.match(first, /^[a-zA-Z0-9_-]{1,128}$/);
  assert.match(second, /^[a-zA-Z0-9_-]{1,128}$/);
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
