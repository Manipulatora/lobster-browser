import assert from 'node:assert/strict';
import test from 'node:test';
import {
  __resetManagedCredentialForTests,
  clearManagedCredential,
  currentManagedCredential,
  managedEntitlement,
  managedLlmConfig,
  noteManagedRefusal,
  peekManagedCredential,
  refusalStatus,
  setCredentialRefresher,
  setManagedCredential,
} from './managed-credential.js';

function withoutEnvCredential<T>(body: () => T): T {
  const url = process.env.LOBSTER_AGENT_PROXY_URL;
  const token = process.env.LOBSTER_AGENT_PROXY_TOKEN;
  delete process.env.LOBSTER_AGENT_PROXY_URL;
  delete process.env.LOBSTER_AGENT_PROXY_TOKEN;
  try {
    return body();
  } finally {
    if (url === undefined) delete process.env.LOBSTER_AGENT_PROXY_URL;
    else process.env.LOBSTER_AGENT_PROXY_URL = url;
    if (token === undefined) delete process.env.LOBSTER_AGENT_PROXY_TOKEN;
    else process.env.LOBSTER_AGENT_PROXY_TOKEN = token;
  }
}

test('an account with no credential yet is unknown rather than entitled', () => {
  withoutEnvCredential(() => {
    __resetManagedCredentialForTests();
    const entitlement = managedEntitlement();
    assert.equal(entitlement.entitled, false);
    assert.equal(entitlement.code, 'unconfigured');
    assert.deepEqual([...entitlement.requiredTiers], ['plus', 'pro', 'max']);
    assert.equal(entitlement.minimumTier, 'plus');
  });
});

test('a pushed plan refusal names the package and refuses the run before it starts', () => {
  withoutEnvCredential(() => {
    __resetManagedCredentialForTests();
    setManagedCredential({ refusal: 'plan_required', tier: 'light' });

    const entitlement = managedEntitlement();
    assert.equal(entitlement.entitled, false);
    assert.equal(entitlement.tier, 'light');
    // Light is a PAID package that deliberately does not include the agent, so the refusal has to
    // name it — "upgrade" is meaningless to someone who has already paid unless it says to what.
    assert.match(entitlement.message ?? '', /Light/);
    assert.match(entitlement.message ?? '', /Plus/);

    const resolution = managedLlmConfig('test/model');
    assert.equal(resolution.ok, false);
    if (resolution.ok) return;
    assert.equal(resolution.refusal.code, 'plan_required');
    assert.equal(refusalStatus(resolution.refusal.code), 403);
  });
});

test('an empty wallet is a top-up, not an upgrade', () => {
  withoutEnvCredential(() => {
    __resetManagedCredentialForTests();
    setManagedCredential({
      baseUrl: 'https://api.example.test/agent/llm',
      token: 'agent-token',
      expiresInSeconds: 1_800,
      tier: 'pro',
    });
    // Mid-run: the proxy answered 402 and the wrapper recorded it. The next thing the panel asks
    // must say "top up", not "upgrade" — the account's package is fine.
    noteManagedRefusal('insufficient_credit', 'Your Credit balance cannot cover the next call.');
    clearManagedCredential();
    setManagedCredential({ refusal: 'insufficient_credit', tier: 'pro', message: 'Top up.' });

    const entitlement = managedEntitlement();
    assert.equal(entitlement.code, 'insufficient_credit');
    assert.equal(refusalStatus('insufficient_credit'), 402);
  });
});

test('a token minted for a package that cannot run the agent is still refused', () => {
  withoutEnvCredential(() => {
    __resetManagedCredentialForTests();
    // Defence in depth: the mint and every proxy call check the plan, but a credential that says
    // `light` must never be treated as usable just because it carries a token.
    setManagedCredential({
      baseUrl: 'https://api.example.test/agent/llm',
      token: 'agent-token',
      expiresInSeconds: 1_800,
      tier: 'light',
    });
    assert.equal(managedEntitlement().entitled, false);
    assert.equal(managedEntitlement().code, 'plan_required');
  });
});

test('signing out revokes the credential the panel would otherwise keep spending on', () => {
  withoutEnvCredential(() => {
    __resetManagedCredentialForTests();
    setManagedCredential({
      baseUrl: 'https://api.example.test/agent/llm',
      token: 'agent-token',
      expiresInSeconds: 1_800,
      tier: 'max',
    });
    assert.equal(managedEntitlement().entitled, true);
    clearManagedCredential();
    assert.equal(peekManagedCredential(), undefined);
    assert.equal(managedEntitlement().code, 'signed_out');
  });
});

test('a credential that redirects the token somewhere else is refused outright', () => {
  withoutEnvCredential(() => {
    __resetManagedCredentialForTests();
    for (const baseUrl of [
      'http://evil.example/agent/llm',
      'https://user:pass@api.example.test/agent/llm',
      'https://api.example.test/agent/llm?to=elsewhere',
      'not a url',
    ]) {
      assert.throws(() => setManagedCredential({ baseUrl, token: 'agent-token' }), /base URL/);
    }
  });
});

test('a token about to expire is renewed before the call rather than after it fails', async () => {
  await withoutEnvCredential(async () => {
    __resetManagedCredentialForTests();
    setManagedCredential({
      baseUrl: 'https://api.example.test/agent/llm',
      token: 'about-to-expire',
      expiresInSeconds: 10,
      tier: 'plus',
    });
    let requests = 0;
    setCredentialRefresher(() => {
      requests += 1;
      setManagedCredential({
        baseUrl: 'https://api.example.test/agent/llm',
        token: 'freshly-minted',
        expiresInSeconds: 1_800,
        tier: 'plus',
      });
    });

    const credential = await currentManagedCredential();
    assert.equal(requests, 1, 'an expiring token must be renewed, not used');
    assert.equal(credential?.token, 'freshly-minted');

    // A comfortable token asks for nothing: a run must not round-trip to the desktop per model call.
    await currentManagedCredential();
    assert.equal(requests, 1);
    __resetManagedCredentialForTests();
  });
});

test('the operator environment pair still authorises development and CI runs', async () => {
  __resetManagedCredentialForTests();
  const previousUrl = process.env.LOBSTER_AGENT_PROXY_URL;
  const previousToken = process.env.LOBSTER_AGENT_PROXY_TOKEN;
  process.env.LOBSTER_AGENT_PROXY_URL = 'https://proxy.example.test/agent/llm';
  process.env.LOBSTER_AGENT_PROXY_TOKEN = 'operator-token';
  try {
    assert.equal(managedEntitlement().entitled, true);
    const resolution = managedLlmConfig('test/model', 'high');
    assert.equal(resolution.ok, true);
    if (!resolution.ok) return;
    assert.equal(resolution.llm.baseUrl, 'https://proxy.example.test/agent/llm');
    assert.equal(resolution.llm.apiKey, 'operator-token');
    assert.equal(resolution.llm.managed, true);
    assert.equal(resolution.llm.effort, 'high');
  } finally {
    if (previousUrl === undefined) delete process.env.LOBSTER_AGENT_PROXY_URL;
    else process.env.LOBSTER_AGENT_PROXY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LOBSTER_AGENT_PROXY_TOKEN;
    else process.env.LOBSTER_AGENT_PROXY_TOKEN = previousToken;
    __resetManagedCredentialForTests();
  }
});
