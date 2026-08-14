import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import type { LaunchParams, LaunchResult, SidecarRequest } from '@lobster/shared-types';
import {
  forgetProfile,
  issueBridgeToken,
  provisionProfile,
  resolveBridgeToken,
  resolveProfileNetworkRoute,
} from './agent/bridge-registry.js';
import type { EngineRunner } from './runner.js';
import { dispatch } from './rpc.js';

function launchParams(profileId: string, proxied: boolean): LaunchParams {
  return {
    profileId,
    engine: 'lobium',
    userDataDir: `/tmp/${profileId}`,
    // RPC routing does not inspect the fingerprint. Keeping this fixture deliberately minimal makes
    // the test about the transaction boundary, not fingerprint construction.
    fingerprint: {} as LaunchParams['fingerprint'],
    ...(proxied
      ? { proxy: { id: 'proxy', type: 'http' as const, host: 'proxy.example', port: 8080 } }
      : {}),
  };
}

function request(id: string, params: LaunchParams): SidecarRequest<'launch', LaunchParams> {
  return { id, method: 'launch', params };
}

function runnerWithLaunch(launch: EngineRunner['launch']): EngineRunner {
  return { launch } as EngineRunner;
}

test('RPC does not change an existing route when a duplicate proxied launch fails', async () => {
  const profileId = `rpc-duplicate-${randomUUID()}`;
  try {
    provisionProfile(profileId, { networkRoute: 'direct' });
    const response = await dispatch(
      runnerWithLaunch(async () => {
        throw new Error(`profile ${profileId} is already running`);
      }),
      request('duplicate', launchParams(profileId, true)),
    );

    assert.equal(response.ok, false);
    assert.match(response.error?.message ?? '', /already running/);
    assert.equal(resolveProfileNetworkRoute(profileId), 'direct');
  } finally {
    forgetProfile(profileId);
  }
});

test('RPC leaves a fresh profile route unknown when launch fails', async () => {
  const profileId = `rpc-failed-${randomUUID()}`;
  try {
    const response = await dispatch(
      runnerWithLaunch(async () => {
        throw new Error('browser process exited during startup');
      }),
      request('failed', launchParams(profileId, true)),
    );

    assert.equal(response.ok, false);
    assert.equal(resolveProfileNetworkRoute(profileId), undefined);
  } finally {
    forgetProfile(profileId);
  }
});

test('RPC publishes the requested route after launch succeeds', async () => {
  const proxiedId = `rpc-proxied-${randomUUID()}`;
  const directId = `rpc-direct-${randomUUID()}`;
  const result = (profileId: string): LaunchResult => ({
    profileId,
    pid: 123,
    ws: 'ws://127.0.0.1/devtools/browser/test',
    debuggerAddress: '127.0.0.1:9222',
  });
  try {
    const proxied = await dispatch(
      runnerWithLaunch(async (params) => result(params.profileId)),
      request('proxied', launchParams(proxiedId, true)),
    );
    const direct = await dispatch(
      runnerWithLaunch(async (params) => result(params.profileId)),
      request('direct', launchParams(directId, false)),
    );

    assert.equal(proxied.ok, true);
    assert.equal(direct.ok, true);
    assert.equal(resolveProfileNetworkRoute(proxiedId), 'remote-proxy');
    assert.equal(resolveProfileNetworkRoute(directId), 'direct');
  } finally {
    forgetProfile(proxiedId);
    forgetProfile(directId);
  }
});

test('successful profile stop revokes its bridge token and route', async () => {
  const profileId = `rpc-stop-${randomUUID()}`;
  const token = issueBridgeToken(profileId);
  provisionProfile(profileId, { networkRoute: 'direct' });
  let stopped = '';
  const runner = {
    stop: async (params: { profileId: string }) => {
      stopped = params.profileId;
    },
  } as EngineRunner;

  const response = await dispatch(runner, {
    id: 'stop',
    method: 'stop',
    params: { profileId },
  });

  assert.equal(response.ok, true);
  assert.equal(stopped, profileId);
  assert.equal(resolveBridgeToken(token), undefined);
  assert.equal(resolveProfileNetworkRoute(profileId), undefined);
});
