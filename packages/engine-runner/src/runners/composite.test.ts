import assert from 'node:assert/strict';
import test from 'node:test';
import type { Fingerprint, LaunchParams } from '@lobster/shared-types';
import { CompositeRunner } from './composite.js';
import { defaultLaunchers } from './default-launchers.js';
import type { LaunchContext, LaunchHandle, LauncherRegistry } from './types.js';

function sampleFingerprint(): Fingerprint {
  return {
    os: 'windows',
    arch: 'x86_64',
    navigator: {
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/131.0.0.0 Safari/537.36',
      platform: 'Win32',
      languages: ['en-US', 'en'],
      hardwareConcurrency: 8,
      deviceMemory: 8,
      maxTouchPoints: 0,
      uaBrands: [{ brand: 'Chromium', version: '131' }],
      uaPlatform: 'Windows',
      uaPlatformVersion: '15.0.0',
      uaMobile: false,
      uaFullVersion: '131.0.0.0',
    },
    screen: {
      width: 1920,
      height: 1080,
      availWidth: 1920,
      availHeight: 1040,
      colorDepth: 24,
      devicePixelRatio: 1,
    },
    webgl: { vendor: 'v', renderer: 'r', unmaskedVendor: 'v', unmaskedRenderer: 'r' },
    locale: { timezone: 'America/New_York', locale: 'en-US', acceptLanguage: 'en-US,en;q=0.9' },
    fonts: ['Arial'],
  };
}

function params(profileId: string, engine: LaunchParams['engine'] = 'lobium'): LaunchParams {
  return { profileId, engine, userDataDir: `/data/${profileId}`, fingerprint: sampleFingerprint() };
}

/** A launcher registry that records the prepared LaunchContext and returns a fake handle. */
function fakeRegistry(recorded: LaunchContext[]): LauncherRegistry {
  let pid = 1000;
  const make =
    () =>
    async (ctx: LaunchContext): Promise<LaunchHandle> => {
      recorded.push(ctx);
      pid += 1;
      return {
        pid,
        ws: `ws://127.0.0.1:9222/${ctx.profileId}`,
        debuggerAddress: '127.0.0.1:9222',
        close: () => Promise.resolve(),
      };
    };
  return { lobium: make() };
}

test('launch prepares coherent options + returns endpoints from the launcher', async () => {
  const recorded: LaunchContext[] = [];
  const runner = new CompositeRunner(fakeRegistry(recorded));

  const launchParams = params('p1');
  launchParams.extensions = [
    {
      source: 'chrome_web_store',
      enabled: false,
      id: 'abcdefghijklmnopabcdefghijklmnop',
    },
  ];
  const res = await runner.launch(launchParams);
  assert.match(res.ws, /^ws:\/\//);
  assert.equal(res.debuggerAddress, '127.0.0.1:9222');
  assert.ok(res.pid > 0);

  const ctx = recorded[0];
  assert.ok(ctx);
  assert.equal(ctx.options.userDataDir, '/data/p1');
  assert.ok(ctx.options.args.includes('--lang=en-US'));
  assert.equal(ctx.emulation.timezoneId, 'America/New_York');
  assert.deepEqual(ctx.extensions, launchParams.extensions);
  // The init script must never touch deep surfaces.
  assert.doesNotMatch(ctx.initScript, /canvas|webgl|audiocontext/i);
});

test('single-active-instance: launching the same profile twice throws', async () => {
  const runner = new CompositeRunner(fakeRegistry([]));
  await runner.launch(params('dup'));
  await assert.rejects(() => runner.launch(params('dup')), /already running/);
});

test('status lists running instances; stop removes them', async () => {
  const runner = new CompositeRunner(fakeRegistry([]));
  await runner.launch(params('a'));
  await runner.launch(params('b', 'lobium'));

  let status = await runner.status({});
  assert.equal(status.running.length, 2);

  await runner.stop({ profileId: 'a' });
  status = await runner.status({});
  assert.equal(status.running.length, 1);
  assert.equal(status.running[0]?.profileId, 'b');
});

test('launch reports one-shot cookie completion and exports only from a live handle', async () => {
  const registry: LauncherRegistry = {
    lobium: async (): Promise<LaunchHandle> => ({
      pid: 7,
      ws: 'ws://127.0.0.1:9222/browser',
      debuggerAddress: '127.0.0.1:9222',
      cookieImportApplied: true,
      exportCookies: () => Promise.resolve('[{"name":"sid","value":"secret"}]'),
      close: () => Promise.resolve(),
    }),
  };
  const runner = new CompositeRunner(registry);
  const launched = await runner.launch(params('cookies'));
  assert.equal(launched.cookieImportApplied, true);
  assert.match((await runner.exportCookies('cookies')).json, /"sid"/);
  await runner.stop({ profileId: 'cookies' });
  await assert.rejects(() => runner.exportCookies('cookies'), /not running/);
});

test('a crashed / externally-closed browser is evicted so the profile can relaunch', async () => {
  let closeListener: ((reason?: string) => void) | undefined;
  const registry: LauncherRegistry = {
    lobium: async (ctx: LaunchContext): Promise<LaunchHandle> => ({
      pid: 1,
      ws: `ws://127.0.0.1:9222/${ctx.profileId}`,
      debuggerAddress: '127.0.0.1:9222',
      close: () => Promise.resolve(),
      onClose: (l) => {
        closeListener = l;
      },
    }),
  };
  const runner = new CompositeRunner(registry);
  await runner.launch(params('crashy'));
  assert.equal((await runner.status({})).running.length, 1);
  // While tracked as running, a relaunch is (correctly) blocked.
  await assert.rejects(() => runner.launch(params('crashy')), /already running/);

  // Simulate the browser dying out-of-band (crash / user closed the window).
  assert.ok(closeListener, 'the launcher registered an onClose listener');
  closeListener?.();

  // The stale entry is gone and the profile relaunches cleanly (no "already running" brick).
  assert.equal((await runner.status({})).running.length, 0);
  await runner.launch(params('crashy'));
  assert.equal((await runner.status({})).running.length, 1);
});

test('a fail-closed upstream exit remains observable in sidecar status', async () => {
  let closeListener: ((reason?: string) => void) | undefined;
  const runner = new CompositeRunner({
    lobium: async (): Promise<LaunchHandle> => ({
      pid: 9,
      ws: 'ws://127.0.0.1:9222/browser',
      debuggerAddress: '127.0.0.1:9222',
      close: () => Promise.resolve(),
      onClose: (listener) => {
        closeListener = listener;
      },
    }),
  });
  await runner.launch(params('network-loss'));
  closeListener?.('proxy upstream failed: connection reset');
  const status = await runner.status({ profileId: 'network-loss' });
  assert.equal(status.running.length, 0);
  assert.match(status.errors?.[0]?.message ?? '', /upstream failed/);
});

test('stopping a non-running profile throws', async () => {
  const runner = new CompositeRunner(fakeRegistry([]));
  await assert.rejects(() => runner.stop({ profileId: 'ghost' }), /not running/);
});

test('unknown engine (no launcher registered) throws', async () => {
  const runner = new CompositeRunner({}); // empty registry
  await assert.rejects(() => runner.launch(params('x')), /no launcher registered/);
});

test('default launchers report engine-not-provisioned (no binaries here)', async () => {
  const runner = new CompositeRunner(defaultLaunchers);
  await assert.rejects(() => runner.launch(params('np', 'lobium')), /not provisioned/);
});

test('a second start of the same profile is refused while the first is still launching', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let spawned = 0;
  const runner = new CompositeRunner({
    lobium: async (ctx: LaunchContext): Promise<LaunchHandle> => {
      spawned += 1;
      await held;
      return {
        pid: 4242,
        ws: `ws://127.0.0.1:9222/${ctx.profileId}`,
        debuggerAddress: '127.0.0.1:9222',
        close: () => Promise.resolve(),
      };
    },
  });

  const first = runner.launch(params('slow-start'));
  await assert.rejects(() => runner.launch(params('slow-start')), /already running/);
  release();
  await first;
  assert.equal(spawned, 1, 'one user-data-dir must never get two browsers');
});

test('a failed launch releases the profile so it can be started again', async () => {
  let attempt = 0;
  const runner = new CompositeRunner({
    lobium: async (ctx: LaunchContext): Promise<LaunchHandle> => {
      attempt += 1;
      if (attempt === 1) throw new Error('proxy upstream unreachable');
      return {
        pid: 7,
        ws: `ws://127.0.0.1:9222/${ctx.profileId}`,
        debuggerAddress: '127.0.0.1:9222',
        close: () => Promise.resolve(),
      };
    },
  });

  await assert.rejects(() => runner.launch(params('retry')), /unreachable/);
  const result = await runner.launch(params('retry'));
  assert.equal(result.pid, 7);
});
