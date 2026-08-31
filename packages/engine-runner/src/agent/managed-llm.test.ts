import assert from 'node:assert/strict';
import test from 'node:test';
import type { LlmRequest } from '@lobster/agent';
import { createRunLlmClient } from './managed-llm.js';
import {
  __resetManagedCredentialForTests,
  managedEntitlement,
  refusalStatus,
  setCredentialRefresher,
  setManagedCredential,
} from './managed-credential.js';

const BASE_URL = 'https://api.example.test/agent/llm';

function request(): LlmRequest {
  return {
    model: 'test/model',
    system: 'be useful',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    forceTool: '',
    maxTokens: 64,
  };
}

function completion(): Response {
  return new Response(
    JSON.stringify({
      choices: [{ message: { content: 'done' }, finish_reason: 'stop' }],
      usage: { prompt_tokens: 3, completion_tokens: 4 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

function refused(status: number, message: string): Response {
  return new Response(JSON.stringify({ error: { message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function withStubbedFetch(handler: typeof fetch, body: () => Promise<void>): Promise<void> {
  const original = globalThis.fetch;
  globalThis.fetch = handler;
  return body().finally(() => {
    globalThis.fetch = original;
  });
}

test('a token that turns over mid-run is replaced instead of ending the run', async () => {
  __resetManagedCredentialForTests();
  setManagedCredential({
    baseUrl: BASE_URL,
    token: 'first-token',
    expiresInSeconds: 1_800,
    tier: 'plus',
  });
  setCredentialRefresher(() => {
    setManagedCredential({
      baseUrl: BASE_URL,
      token: 'second-token',
      expiresInSeconds: 1_800,
      tier: 'plus',
    });
  });

  const bearers: string[] = [];
  await withStubbedFetch(
    async (_input, init) => {
      const headers = new Headers((init as RequestInit).headers);
      bearers.push(headers.get('authorization') ?? '');
      // The first call carries a token the proxy has already stopped accepting — exactly what a
      // half-hour credential does to an hour-long run.
      return bearers.length === 1 ? refused(401, 'invalid or expired agent token') : completion();
    },
    async () => {
      const client = createRunLlmClient({
        provider: 'openrouter',
        model: 'test/model',
        managed: true,
        baseUrl: BASE_URL,
        apiKey: 'first-token',
      });
      const result = await client.complete(request());
      assert.equal(result.text, 'done');
    },
  );

  assert.deepEqual(bearers, ['Bearer first-token', 'Bearer second-token']);
  __resetManagedCredentialForTests();
});

test('a wallet that empties mid-run leaves the panel with a top-up, not a mystery', async () => {
  __resetManagedCredentialForTests();
  setManagedCredential({
    baseUrl: BASE_URL,
    token: 'live-token',
    expiresInSeconds: 1_800,
    tier: 'pro',
  });

  let calls = 0;
  await withStubbedFetch(
    async () => {
      calls += 1;
      return refused(
        402,
        'Your Credit balance cannot cover the next agent call. Top up to continue.',
      );
    },
    async () => {
      const client = createRunLlmClient({
        provider: 'openrouter',
        model: 'test/model',
        managed: true,
        baseUrl: BASE_URL,
        apiKey: 'live-token',
      });
      await assert.rejects(client.complete(request()), /Top up to continue/);
    },
  );

  // A payment refusal is not a transport fault: retrying it spends nothing and helps nobody.
  assert.equal(calls, 1);
  const entitlement = managedEntitlement();
  assert.equal(entitlement.entitled, false);
  assert.equal(entitlement.code, 'insufficient_credit');
  __resetManagedCredentialForTests();
});

test('BYOK runs are untouched by the managed credential', () => {
  __resetManagedCredentialForTests();
  const client = createRunLlmClient({
    provider: 'anthropic',
    model: 'claude-test',
    apiKey: 'user-own-key',
  });
  assert.equal(client.provider, 'anthropic');
});

/** Word for word the sentence the backend and the panel both use for an operator-side outage. */
const OPERATOR_FAULT_MESSAGE =
  'Lobee is temporarily unavailable — this is on our side, not yours; nothing was charged.';

test('an operator-side outage is not the customer’s empty wallet', async () => {
  __resetManagedCredentialForTests();
  setManagedCredential({
    baseUrl: BASE_URL,
    token: 'live-token',
    expiresInSeconds: 1_800,
    tier: 'pro',
  });
  let refreshes = 0;
  setCredentialRefresher(() => {
    refreshes += 1;
  });

  let calls = 0;
  await withStubbedFetch(
    async () => {
      calls += 1;
      // What the proxy now answers when OpenRouter refuses the OPERATOR's key or finds the
      // OPERATOR's balance empty. It used to forward the provider's own 401/402, which arrived here
      // as "your token expired" and "your Credit ran out" — both about the wrong party.
      return refused(503, OPERATOR_FAULT_MESSAGE);
    },
    async () => {
      const client = createRunLlmClient({
        provider: 'openrouter',
        model: 'test/model',
        managed: true,
        baseUrl: BASE_URL,
        apiKey: 'live-token',
      });
      await assert.rejects(client.complete(request()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, OPERATOR_FAULT_MESSAGE);
        // The two sentences this must never be: neither wallet nor credential belongs to the user.
        assert.doesNotMatch(error.message, /top up/i);
        assert.doesNotMatch(error.message, /credential was rejected/i);
        return true;
      });
    },
  );

  // No re-mint (nothing the client holds is stale) and no retry (nothing about this call changes).
  assert.equal(refreshes, 0);
  assert.equal(calls, 1);
  const entitlement = managedEntitlement();
  assert.equal(entitlement.entitled, false);
  assert.equal(entitlement.code, 'provider_unavailable');
  assert.equal(entitlement.message, OPERATOR_FAULT_MESSAGE);
  assert.equal(refusalStatus('provider_unavailable'), 503);
  __resetManagedCredentialForTests();
});

test('an upstream key rejection wearing a 401 does not spend the run’s one re-mint', async () => {
  __resetManagedCredentialForTests();
  setManagedCredential({
    baseUrl: BASE_URL,
    token: 'live-token',
    expiresInSeconds: 1_800,
    tier: 'plus',
  });
  let refreshes = 0;
  setCredentialRefresher(() => {
    refreshes += 1;
    setManagedCredential({
      baseUrl: BASE_URL,
      token: 'second-token',
      expiresInSeconds: 1_800,
      tier: 'plus',
    });
  });

  let calls = 0;
  await withStubbedFetch(
    async () => {
      calls += 1;
      // Defence in depth against a backend older than the fix that reserves 401 for its own auth
      // rejection: such a backend forwards OpenRouter's status AND OpenRouter's body, and this is
      // what that body says. A fresh agent token cannot fix a key the client has never held.
      return refused(401, 'No auth credentials found');
    },
    async () => {
      const client = createRunLlmClient({
        provider: 'openrouter',
        model: 'test/model',
        managed: true,
        baseUrl: BASE_URL,
        apiKey: 'live-token',
      });
      await assert.rejects(client.complete(request()), (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.equal(error.message, OPERATOR_FAULT_MESSAGE);
        return true;
      });
    },
  );

  assert.equal(refreshes, 0, 'a re-mint here is a wasted round trip and a wrong diagnosis');
  assert.equal(calls, 1);
  assert.equal(managedEntitlement().code, 'provider_unavailable');
  __resetManagedCredentialForTests();
});
