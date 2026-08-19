import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import test from 'node:test';
import { FileMemoryStore, RunJournalStore } from '@lobster/agent';
import type { AgentStartParams } from '@lobster/shared-types';
import type { AgentEvent, AgentRunSnapshot } from '@lobster/shared-types';
import { AgentBridge, uploadRoots } from './bridge.js';
import { forgetProfile, issueBridgeToken, provisionProfile } from './bridge-registry.js';
import { __resetManagedCredentialForTests, setManagedCredential } from './managed-credential.js';
import type { AgentManager } from './manager.js';

test('loopback bridge authenticates status and replays SSE events after a cursor', async () => {
  const profileId = `bridge-test-${Date.now()}`;
  const token = issueBridgeToken(profileId);
  const snapshot: AgentRunSnapshot = {
    sessionId: 'session-1',
    profileId,
    threadId: 'thread-1',
    task: 'test task',
    status: 'running',
    step: 2,
    startedAt: new Date(0).toISOString(),
    usage: { tokensIn: 1, tokensOut: 2 },
  };
  const presenceProbes: Array<(id: string) => boolean> = [];
  const agents = {
    status: (requested?: string) => ({ runs: requested === profileId ? [snapshot] : [] }),
    setPresenceProbe: (probe: (id: string) => boolean) => presenceProbes.push(probe),
  } as unknown as AgentManager;
  const bridge = new AgentBridge(agents);
  const origin = await bridge.start();
  try {
    const unauthorized = await fetch(`${origin}/status`);
    assert.equal(unauthorized.status, 401);

    const status = await fetch(`${origin}/status`, { headers: { 'x-lobee-token': token } });
    assert.equal(status.status, 200);
    assert.deepEqual(((await status.json()) as { runs: AgentRunSnapshot[] }).runs, [snapshot]);

    const first: AgentEvent = {
      type: 'step.thinking',
      sessionId: 'session-1',
      profileId,
      step: 1,
      ts: new Date(1).toISOString(),
    };
    const second: AgentEvent = {
      type: 'step.thinking',
      sessionId: 'session-1',
      profileId,
      step: 2,
      ts: new Date(2).toISOString(),
    };
    bridge.dispatch(first);
    bridge.dispatch(second);

    const queryCredential = await fetch(
      `${origin}/events?token=${encodeURIComponent(token)}&since=1`,
    );
    assert.equal(queryCredential.status, 401, 'credentials in URLs must never authenticate');

    const response = await fetch(`${origin}/events?since=1`, {
      headers: { 'x-lobee-token': token },
    });
    assert.equal(response.status, 200);
    const reader = response.body!.getReader();
    const chunk = await reader.read();
    await reader.cancel();
    const text = new TextDecoder().decode(chunk.value);
    assert.doesNotMatch(text, /id: 1\n/);
    assert.match(text, /id: 2\n/);
    assert.match(text, /"step":2/);
    // The bridge is the only component that knows whether a human is still watching, so it installs
    // the probe the manager consults before pausing a panel run for input nobody can supply.
    assert.equal(presenceProbes.length, 1, 'starting the bridge must install a presence probe');
    assert.equal(
      presenceProbes[0]!(`${profileId}-never-subscribed`),
      false,
      'a profile with no attached panel must report absent',
    );
  } finally {
    await bridge.close();
    forgetProfile(profileId);
  }
});

test('loopback run requests preserve validated panel policy', async () => {
  const profileId = `bridge-policy-${Date.now()}`;
  const token = issueBridgeToken(profileId);
  const root = await mkdtemp(join(tmpdir(), 'lobee-bridge-policy-'));
  const memoryDir = join(root, 'agent');
  const memoryKey = randomBytes(32).toString('base64');
  provisionProfile(profileId, {
    memoryDir,
    memoryKey,
  });
  const starts: AgentStartParams[] = [];
  const agents = {
    setPresenceProbe: () => {},
    start: async (params: AgentStartParams) => {
      starts.push(params);
      return { sessionId: 'session-policy', profileId };
    },
  } as unknown as AgentManager;
  const bridge = new AgentBridge(agents);
  const previousUrl = process.env.LOBSTER_AGENT_PROXY_URL;
  const previousToken = process.env.LOBSTER_AGENT_PROXY_TOKEN;
  process.env.LOBSTER_AGENT_PROXY_URL = 'https://proxy.example.test/agent/llm';
  process.env.LOBSTER_AGENT_PROXY_TOKEN = 'managed-test-token';
  const origin = await bridge.start();
  try {
    const response = await fetch(`${origin}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobee-token': token },
      body: JSON.stringify({
        requestId: 'run-policy-request-0000000001',
        task: 'stay inside the fence',
        mode: 'agent',
        model: 'test/model',
        threadId: 'thread_policy',
        autonomy: 'confirm',
        allowedDomains: ['Example.COM', '*.accounts.example.com'],
        tokenBudget: 50_000,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal(starts.length, 1);
    assert.equal(starts[0]!.threadId, 'thread_policy');
    assert.equal(starts[0]!.config?.autonomy, 'confirm');
    assert.deepEqual(starts[0]!.config?.allowedDomains, ['example.com', 'accounts.example.com']);
    assert.equal(starts[0]!.config?.tokenBudget, 50_000);

    const defaulted = await fetch(`${origin}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobee-token': token },
      body: JSON.stringify({
        requestId: 'run-policy-request-0000000002',
        task: 'use server defaults',
        model: 'test/model',
      }),
    });
    assert.equal(defaulted.status, 200);
    assert.equal(starts[1]!.config?.mode, 'agent');
    assert.equal(starts[1]!.config?.autonomy, 'confirm');
    assert.equal(starts[1]!.config?.tokenBudget, 100_000);

    const unlimited = await fetch(`${origin}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobee-token': token },
      body: JSON.stringify({
        requestId: 'run-policy-request-0000000003',
        task: 'explicit unlimited ask',
        mode: 'ask',
        model: 'test/model',
        autonomy: 'auto',
        tokenBudget: null,
      }),
    });
    assert.equal(unlimited.status, 200);
    assert.equal(starts[2]!.config?.mode, 'ask');
    assert.equal(starts[2]!.config?.autonomy, 'auto');
    assert.equal(starts[2]!.config?.tokenBudget, undefined);

    const memory = new FileMemoryStore(memoryDir, { encryptionKey: memoryKey });
    await memory.appendThreadTurn('thread_policy', {
      user: 'private request',
      assistant: 'private answer',
      status: 'done',
    });
    const threadResponse = await fetch(`${origin}/thread?id=thread_policy`, {
      headers: { 'x-lobee-token': token },
    });
    const thread = (await threadResponse.json()) as {
      ok: boolean;
      messages: Array<{ role: string; turnId?: string }>;
    };
    assert.equal(thread.ok, true);
    assert.match(thread.messages[0]!.turnId ?? '', /^[A-Za-z0-9_-]{43}$/);
    assert.equal(thread.messages[0]!.turnId, thread.messages[1]!.turnId);
    const reread = (await (
      await fetch(`${origin}/thread?id=thread_policy`, {
        headers: { 'x-lobee-token': token },
      })
    ).json()) as { messages: Array<{ turnId?: string }> };
    assert.equal(reread.messages[1]!.turnId, thread.messages[1]!.turnId);

    const missingThread = (await (
      await fetch(`${origin}/thread?id=thread_missing`, {
        headers: { 'x-lobee-token': token },
      })
    ).json()) as { ok: boolean; messages: unknown[] };
    assert.deepEqual(missingThread, { ok: true, messages: [] });

    provisionProfile(profileId, { memoryKey: randomBytes(32).toString('base64') });
    const wrongKeyThreadResponse = await fetch(`${origin}/thread?id=thread_policy`, {
      headers: { 'x-lobee-token': token },
    });
    const wrongKeyThread = (await wrongKeyThreadResponse.json()) as {
      ok: boolean;
      messages: unknown[];
      error?: string;
    };
    assert.equal(wrongKeyThread.ok, false);
    assert.deepEqual(wrongKeyThread.messages, []);
    assert.match(wrongKeyThread.error ?? '', /authentication failed/);
    provisionProfile(profileId, { memoryKey });

    let invalidIndex = 0;
    for (const invalid of [
      { mode: 'browse' },
      { effort: 'maximum' },
      { effort: null },
      { autonomy: 'sometimes' },
      { allowedDomains: 'example.com' },
      { allowedDomains: [42] },
      { allowedDomains: ['com'] },
      { allowedDomains: ['co.uk'] },
      { tokenBudget: 999 },
      { threadId: null },
      { threadId: '' },
      { threadId: 42 },
      { requestId: undefined },
      { requestId: 'short' },
    ]) {
      const requestId = `invalid-policy-request-00000000${invalidIndex++}`;
      const rejected = await fetch(`${origin}/run`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-lobee-token': token },
        body: JSON.stringify({
          requestId,
          task: 'invalid policy',
          model: 'test/model',
          ...invalid,
        }),
      });
      assert.equal(rejected.status, 400);
    }
    assert.equal(starts.length, 3, 'invalid policy must never reach AgentManager.start');
  } finally {
    await bridge.close();
    forgetProfile(profileId);
    if (previousUrl === undefined) delete process.env.LOBSTER_AGENT_PROXY_URL;
    else process.env.LOBSTER_AGENT_PROXY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LOBSTER_AGENT_PROXY_TOKEN;
    else process.env.LOBSTER_AGENT_PROXY_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('a refused package is answered as a typed refusal and never starts a run', async () => {
  const profileId = `bridge-refusal-${Date.now()}`;
  const token = issueBridgeToken(profileId);
  const root = await mkdtemp(join(tmpdir(), 'lobee-bridge-refusal-'));
  provisionProfile(profileId, {
    memoryDir: join(root, 'agent'),
    memoryKey: randomBytes(32).toString('base64'),
  });
  let starts = 0;
  const agents = {
    setPresenceProbe: () => {},
    start: async () => {
      starts += 1;
      return { sessionId: 'session-should-not-exist', profileId };
    },
  } as unknown as AgentManager;
  const bridge = new AgentBridge(agents);
  const previousUrl = process.env.LOBSTER_AGENT_PROXY_URL;
  const previousToken = process.env.LOBSTER_AGENT_PROXY_TOKEN;
  // The operator pair would authorise the run; this account is refused on its own merits.
  delete process.env.LOBSTER_AGENT_PROXY_URL;
  delete process.env.LOBSTER_AGENT_PROXY_TOKEN;
  __resetManagedCredentialForTests();
  setManagedCredential({ refusal: 'plan_required', tier: 'light' });
  const origin = await bridge.start();
  try {
    const refused = await fetch(`${origin}/run`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-lobee-token': token },
      body: JSON.stringify({
        requestId: 'refused-run-request-00000001',
        task: "spend somebody else's money",
        model: 'test/model',
      }),
    });
    assert.equal(refused.status, 403, 'a plan refusal is a 403, not a generic failure');
    const body = (await refused.json()) as Record<string, unknown>;
    assert.equal(body.code, 'plan_required');
    assert.equal(body.tier, 'light');
    assert.deepEqual(body.requiredTiers, ['plus', 'pro', 'max']);
    assert.equal(body.minimumTier, 'plus');
    assert.equal(starts, 0, 'a refused account must not reach the agent manager at all');

    const entitlement = await fetch(`${origin}/entitlement`, {
      headers: { 'x-lobee-token': token },
    });
    assert.equal(entitlement.status, 200);
    assert.equal(((await entitlement.json()) as { entitled: boolean }).entitled, false);
  } finally {
    await bridge.close();
    forgetProfile(profileId);
    __resetManagedCredentialForTests();
    if (previousUrl === undefined) delete process.env.LOBSTER_AGENT_PROXY_URL;
    else process.env.LOBSTER_AGENT_PROXY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LOBSTER_AGENT_PROXY_TOKEN;
    else process.env.LOBSTER_AGENT_PROXY_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('run request IDs deduplicate concurrent retries and reject body conflicts', async () => {
  const profileId = `bridge-run-dedup-${Date.now()}`;
  const token = issueBridgeToken(profileId);
  const root = await mkdtemp(join(tmpdir(), 'lobee-bridge-run-dedup-'));
  const memoryDir = join(root, 'agent');
  provisionProfile(profileId, {
    memoryDir,
    memoryKey: randomBytes(32).toString('base64'),
  });
  let starts = 0;
  let releaseStart!: () => void;
  let markStartEntered!: () => void;
  const startGate = new Promise<void>((resolve) => {
    releaseStart = resolve;
  });
  const startEntered = new Promise<void>((resolve) => {
    markStartEntered = resolve;
  });
  const agents = {
    setPresenceProbe: () => {},
    start: async () => {
      starts += 1;
      markStartEntered();
      await startGate;
      return { sessionId: 'session-deduplicated', profileId };
    },
  } as unknown as AgentManager;
  const bridge = new AgentBridge(agents);
  const previousUrl = process.env.LOBSTER_AGENT_PROXY_URL;
  const previousToken = process.env.LOBSTER_AGENT_PROXY_TOKEN;
  process.env.LOBSTER_AGENT_PROXY_URL = 'https://proxy.example.test/agent/llm';
  process.env.LOBSTER_AGENT_PROXY_TOKEN = 'managed-test-token';
  const origin = await bridge.start();
  const headers = { 'content-type': 'application/json', 'x-lobee-token': token };
  const body = JSON.stringify({
    requestId: 'same-run-request-000000000001',
    task: 'start exactly once',
    model: 'test/model',
  });
  try {
    const first = fetch(`${origin}/run`, { method: 'POST', headers, body });
    const concurrentRetry = fetch(`${origin}/run`, { method: 'POST', headers, body });
    await startEntered;
    assert.equal(starts, 1, 'concurrent copies must share the in-flight start');
    releaseStart();
    const [firstResponse, retryResponse] = await Promise.all([first, concurrentRetry]);
    assert.equal(firstResponse.status, 200);
    assert.equal(retryResponse.status, 200);
    assert.deepEqual(await retryResponse.json(), await firstResponse.json());

    const laterRetry = await fetch(`${origin}/run`, { method: 'POST', headers, body });
    assert.equal(laterRetry.status, 200);
    assert.equal(starts, 1, 'a completed response must remain replayable');

    const conflict = await fetch(`${origin}/run`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'same-run-request-000000000001',
        task: 'a different task',
        model: 'test/model',
      }),
    });
    assert.equal(conflict.status, 409);
    assert.match(JSON.stringify(await conflict.json()), /different request body/);
    assert.equal(starts, 1);
  } finally {
    releaseStart();
    await bridge.close();
    forgetProfile(profileId);
    if (previousUrl === undefined) delete process.env.LOBSTER_AGENT_PROXY_URL;
    else process.env.LOBSTER_AGENT_PROXY_URL = previousUrl;
    if (previousToken === undefined) delete process.env.LOBSTER_AGENT_PROXY_TOKEN;
    else process.env.LOBSTER_AGENT_PROXY_TOKEN = previousToken;
    await rm(root, { recursive: true, force: true });
  }
});

test('input request IDs are session-bound, replayable, and conflict-safe', async () => {
  const profileId = `bridge-input-dedup-${Date.now()}`;
  const token = issueBridgeToken(profileId);
  let status: AgentRunSnapshot['status'] = 'awaiting_input';
  let deliveries = 0;
  const snapshot = (): AgentRunSnapshot => ({
    sessionId: 'session_input_1',
    profileId,
    task: 'wait for approval',
    status,
    step: 1,
    startedAt: new Date(0).toISOString(),
    usage: { tokensIn: 0, tokensOut: 0 },
    ...(status === 'awaiting_input'
      ? { awaitingPrompt: 'Approve?', awaitingKind: 'confirm' as const }
      : {}),
  });
  const agents = {
    setPresenceProbe: () => {},
    status: (requested?: string) => ({ runs: requested === profileId ? [snapshot()] : [] }),
    sendInput: () => {
      deliveries += 1;
      status = 'running';
      return { delivered: true };
    },
  } as unknown as AgentManager;
  const bridge = new AgentBridge(agents);
  const origin = await bridge.start();
  const headers = { 'content-type': 'application/json', 'x-lobee-token': token };
  const body = JSON.stringify({
    requestId: 'same-input-request-0000000001',
    sessionId: 'session_input_1',
    text: 'approve',
  });
  try {
    const [first, concurrentRetry] = await Promise.all([
      fetch(`${origin}/input`, { method: 'POST', headers, body }),
      fetch(`${origin}/input`, { method: 'POST', headers, body }),
    ]);
    assert.equal(first.status, 200);
    assert.equal(concurrentRetry.status, 200);
    assert.equal(((await first.json()) as { delivered: boolean }).delivered, true);
    assert.equal(((await concurrentRetry.json()) as { delivered: boolean }).delivered, true);
    assert.equal(deliveries, 1);

    const laterRetry = await fetch(`${origin}/input`, { method: 'POST', headers, body });
    assert.equal(((await laterRetry.json()) as { delivered: boolean }).delivered, true);
    assert.equal(deliveries, 1);

    const conflict = await fetch(`${origin}/input`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'same-input-request-0000000001',
        sessionId: 'session_input_1',
        text: 'reject',
      }),
    });
    assert.equal(conflict.status, 409);

    const staleSession = await fetch(`${origin}/input`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        requestId: 'new-input-request-00000000002',
        sessionId: 'session_input_1',
        text: 'approve',
      }),
    });
    assert.equal(((await staleSession.json()) as { delivered: boolean }).delivered, false);
    assert.equal(deliveries, 1, 'a delayed input must not enter a non-waiting run');
  } finally {
    await bridge.close();
    forgetProfile(profileId);
  }
});

test('an interrupted run that blocks admission can be listed and closed by an operator', async () => {
  // Blocking every later run on an unverifiable effect is only defensible while the block can be
  // lifted. Without these routes one CDP hiccup disabled the agent for a profile permanently.
  const profileId = `bridge-recovery-${Date.now()}`;
  const token = issueBridgeToken(profileId);
  const root = await mkdtemp(join(tmpdir(), 'lobee-bridge-recovery-'));
  const memoryDir = join(root, 'agent');
  const memoryKey = randomBytes(32).toString('base64');
  provisionProfile(profileId, { memoryDir, memoryKey });
  const runs: AgentRunSnapshot[] = [];
  const agents = {
    setPresenceProbe: () => {},
    status: () => ({ runs }),
  } as unknown as AgentManager;
  const bridge = new AgentBridge(agents);
  const origin = await bridge.start();
  try {
    const journals = new RunJournalStore(join(memoryDir, 'journals'), {
      encryptionKey: memoryKey,
    });
    let snapshot = await journals.create({ runId: 'stuck', task: 'buy the thing', mode: 'agent' });
    snapshot = await journals.append(
      'stuck',
      {
        type: 'action.proposed',
        actionId: 'a1',
        actionKind: 'click',
        effect: 'consequential',
        summary: 'Proposed click action',
      },
      snapshot.journal.revision,
    );
    await journals.append(
      'stuck',
      { type: 'action.dispatching', actionId: 'a1' },
      snapshot.journal.revision,
    );

    const listed = (await (
      await fetch(`${origin}/recovery`, { headers: { 'x-lobee-token': token } })
    ).json()) as { runs: Array<{ runId: string; blocking: boolean; action?: string }> };
    assert.equal(listed.runs.length, 1);
    assert.equal(listed.runs[0]?.runId, 'stuck');
    assert.equal(listed.runs[0]?.blocking, true);
    assert.equal(listed.runs[0]?.action, 'Proposed click action');

    runs.push({ status: 'running' } as AgentRunSnapshot);
    const whileRunning = await fetch(`${origin}/recovery/resolve`, {
      method: 'POST',
      headers: { 'x-lobee-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'stuck',
        resolution: 'abandoned',
        requestId: 'recovery-request-000000',
      }),
    });
    assert.equal(
      whileRunning.status,
      409,
      'a live run must not have its journal closed underneath',
    );
    runs.length = 0;

    const resolved = await fetch(`${origin}/recovery/resolve`, {
      method: 'POST',
      headers: { 'x-lobee-token': token, 'content-type': 'application/json' },
      body: JSON.stringify({
        runId: 'stuck',
        resolution: 'verified_not_applied',
        requestId: 'recovery-request-000001',
      }),
    });
    assert.equal(resolved.status, 200);
    assert.deepEqual(await journals.listUnfinished(), []);

    const empty = (await (
      await fetch(`${origin}/recovery`, { headers: { 'x-lobee-token': token } })
    ).json()) as { runs: unknown[] };
    assert.deepEqual(empty.runs, []);
  } finally {
    await bridge.close();
    forgetProfile(profileId);
    await rm(root, { recursive: true, force: true });
  }
});

test('LOBSTER_UPLOAD_ROOTS splits on the host path delimiter, not always on a colon', async () => {
  const previous = process.env.LOBSTER_UPLOAD_ROOTS;
  const dir = await mkdtemp(join(tmpdir(), 'lobster-upload-roots-'));
  try {
    // Whatever the host joins with must come back whole. On Windows `delimiter` is ';', which is
    // what keeps C:\\Users\\me\\uploads from being split into 'C' and '\\Users\\me\\uploads' —
    // the drive letter is a colon, so splitting on ':' emptied the canonical root list and refused
    // every upload. Only Windows can assert the drive-letter case, so express the invariant instead.
    const roots =
      process.platform === 'win32'
        ? ['C:\\Users\\me\\uploads', 'D:\\shared']
        : ['/srv/uploads', '/srv/shared'];
    process.env.LOBSTER_UPLOAD_ROOTS = roots.join(delimiter);
    assert.deepEqual(await uploadRoots(join(dir, 'agent')), roots);
  } finally {
    if (previous === undefined) delete process.env.LOBSTER_UPLOAD_ROOTS;
    else process.env.LOBSTER_UPLOAD_ROOTS = previous;
    await rm(dir, { recursive: true, force: true });
  }
});
