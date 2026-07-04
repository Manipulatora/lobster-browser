import assert from 'node:assert/strict';
import test from 'node:test';
import type { LaunchParams, LaunchResult, StartProfileParams } from '@lobster/shared-types';
import type { EngineRunner } from './runner.js';
import { startProfile } from './start-profile.js';

/** Records launch() calls without spawning a browser, so the coherence gate is testable in isolation. */
class RecordingRunner implements EngineRunner {
  launched: LaunchParams[] = [];
  async launch(params: LaunchParams): Promise<LaunchResult> {
    this.launched.push(params);
    return { profileId: params.profileId, pid: 0, ws: 'ws://x', debuggerAddress: '127.0.0.1:1' };
  }
  async stop(): Promise<void> {}
  async status(): Promise<{ running: never[] }> {
    return { running: [] };
  }
}

const base: StartProfileParams = {
  profileId: 'p1',
  fingerprintSeed: 'seed-coherence',
  os: 'windows',
  engine: 'lobium',
  userDataDir: '/tmp/does-not-matter',
};

test('startProfile launches a coherent (unmodified) persona', async () => {
  const runner = new RecordingRunner();
  const res = await startProfile(runner, base);
  assert.equal(res.profileId, 'p1');
  assert.equal(runner.launched.length, 1, 'the coherent persona is launched');
});

test('startProfile REFUSES an incoherent persona from user overrides (fail-closed)', async () => {
  const runner = new RecordingRunner();
  await assert.rejects(
    // maxTouchPoints=5 on a desktop OS is an impossible device — a trivial bot tell.
    startProfile(runner, { ...base, fingerprintOverrides: { navigator: { maxTouchPoints: 5 } } }),
    /incoherent fingerprint.*maxTouchPoints/s,
  );
  assert.equal(runner.launched.length, 0, 'an incoherent persona must never reach the engine');
});
