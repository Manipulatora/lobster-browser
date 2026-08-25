import assert from 'node:assert/strict';
import test from 'node:test';
import {
  LOBIUM_CAPABILITY_CONTRACT_VERSION,
  type LobiumBuildCapabilities,
} from '../lobium-capabilities.js';
import {
  buildLaunchers,
  defaultLaunchers,
  EngineNotProvisionedError,
  type BuildLaunchersDependencies,
} from './default-launchers.js';
import type { ResolvedLobiumRuntime } from './lobium-launcher.js';
import type { LaunchContext, Launcher } from './types.js';

const capabilities: LobiumBuildCapabilities = {
  contractVersion: LOBIUM_CAPABILITY_CONTRACT_VERSION,
  product: 'Lobium',
  capabilities: ['config-channel-v1'],
};

test('module default registry resolves lazily and exposes the native capability path', async () => {
  const previousBin = process.env.LOBSTER_LOBIUM_BIN;
  try {
    process.env.LOBSTER_LOBIUM_BIN = 'C:\\definitely-missing-lobium\\chrome.exe';
    const lazy = defaultLaunchers.lobium;
    assert.ok(lazy?.getBuildCapabilities);
    await assert.rejects(
      lazy.getBuildCapabilities(),
      (error: unknown) => error instanceof EngineNotProvisionedError,
    );
  } finally {
    if (previousBin === undefined) delete process.env.LOBSTER_LOBIUM_BIN;
    else process.env.LOBSTER_LOBIUM_BIN = previousBin;
  }
});

test('one lazy registry observes missing then newly provisioned Lobium without a restart', async () => {
  let runtime: ResolvedLobiumRuntime | undefined;
  const concreteFor: Array<{ path: string; managed: boolean }> = [];
  const launched: string[] = [];
  const deps: BuildLaunchersDependencies = {
    resolveRuntime: () => runtime,
    createLauncher: (opts) => {
      assert.ok(opts.executablePath);
      concreteFor.push({ path: opts.executablePath, managed: opts.managedRuntime === true });
      const launcher: Launcher = async () => {
        launched.push(opts.executablePath!);
        return {
          pid: 7,
          ws: 'ws://127.0.0.1/devtools/browser/lazy',
          debuggerAddress: '127.0.0.1:9222',
          close: async () => {},
        };
      };
      launcher.getBuildCapabilities = async () => capabilities;
      return launcher;
    },
  };

  const registry = await buildLaunchers({}, deps);
  const lazy = registry.lobium;
  assert.ok(lazy);
  await assert.rejects(
    lazy({} as LaunchContext),
    (error: unknown) => error instanceof EngineNotProvisionedError,
  );
  await assert.rejects(
    lazy.getBuildCapabilities!(),
    (error: unknown) => error instanceof EngineNotProvisionedError,
  );

  runtime = { executablePath: 'C:\\managed\\lobium\\chrome.exe', managed: true };
  assert.deepEqual(await lazy.getBuildCapabilities!(), capabilities);
  const handle = await lazy({} as LaunchContext);
  assert.equal(handle.pid, 7);
  assert.deepEqual(launched, [runtime.executablePath]);
  assert.deepEqual(concreteFor, [
    { path: runtime.executablePath, managed: true },
    { path: runtime.executablePath, managed: true },
  ]);
});
