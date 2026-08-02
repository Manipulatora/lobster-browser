import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEvent, AgentRunSnapshot } from '@lobster/shared-types';
import { AgentBridge } from './bridge.js';
import { forgetProfile, issueBridgeToken } from './bridge-registry.js';
import type { AgentManager } from './manager.js';

test('loopback bridge authenticates status and replays SSE events after a cursor', async () => {
  const profileId = `bridge-test-${Date.now()}`;
  const token = issueBridgeToken(profileId);
  const snapshot: AgentRunSnapshot = {
    sessionId: 'session-1',
    profileId,
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

    const response = await fetch(`${origin}/events?token=${encodeURIComponent(token)}&since=1`);
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
