import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import type { CdpSession } from '../cdp-fingerprint.js';
import { configureLaunchedContext } from './patchright-launcher.js';
import type { LaunchContext } from './types.js';

type Page = object;

/**
 * A fake persistent context standing in for a spawned Chromium, so the orphan-cleanup path is testable
 * without a live browser. It records how many times `close()` was called and lets a chosen post-launch
 * step (grantPermissions / newCDPSession) throw.
 */
class FakeContext {
  closeCount = 0;
  grantCount = 0;
  readonly pageHandlers: Array<(page: Page) => void> = [];
  constructor(
    private readonly opts: { pages?: Page[]; grantThrows?: boolean; cdpThrows?: boolean } = {},
  ) {}
  async grantPermissions(): Promise<void> {
    this.grantCount += 1;
    if (this.opts.grantThrows) throw new Error('grantPermissions failed');
  }
  async newCDPSession(_page: Page): Promise<CdpSession> {
    if (this.opts.cdpThrows) throw new Error('newCDPSession failed');
    return { send: async () => ({}) };
  }
  pages(): Page[] {
    return this.opts.pages ?? [];
  }
  async newPage(): Promise<Page> {
    return {};
  }
  on(_event: 'page', handler: (page: Page) => void): void {
    this.pageHandlers.push(handler);
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** A minimal LaunchContext — only the fields configureLaunchedContext reads matter here. */
function fakeCtx(opts: { geolocation?: boolean; userDataDir?: string } = {}): LaunchContext {
  return {
    profileId: 'p',
    engine: 'chromium',
    fingerprint: {},
    options: { userDataDir: opts.userDataDir ?? '/does-not-exist' },
    emulation: opts.geolocation ? { geolocation: { latitude: 0, longitude: 0 } } : {},
    initScript: '',
  } as unknown as LaunchContext;
}

test('configureLaunchedContext closes the context when grantPermissions throws (no orphan)', async () => {
  const context = new FakeContext({ grantThrows: true });
  await assert.rejects(
    configureLaunchedContext(context, fakeCtx({ geolocation: true })),
    /grantPermissions failed/,
  );
  // Without the try/catch cleanup the spawned Chromium would be orphaned (its SingletonLock leaked).
  assert.equal(
    context.closeCount,
    1,
    'the spawned context must be closed on a post-launch failure',
  );
});

test('configureLaunchedContext closes the context when a later step (newCDPSession) throws', async () => {
  const context = new FakeContext({ pages: [{}], cdpThrows: true });
  await assert.rejects(
    configureLaunchedContext(context, fakeCtx({ geolocation: false })),
    /newCDPSession failed/,
  );
  assert.equal(context.grantCount, 0, 'no geolocation → grantPermissions skipped');
  assert.equal(context.closeCount, 1, 'a failure in ANY post-launch step still closes the context');
});

test('configureLaunchedContext returns a handle (and does NOT close) on success', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobster-launcher-'));
  try {
    await writeFile(join(userDataDir, 'DevToolsActivePort'), '12345\n/devtools/browser/abc');
    const context = new FakeContext({ pages: [], grantThrows: false });
    const handle = await configureLaunchedContext(
      context,
      fakeCtx({ geolocation: true, userDataDir }),
    );
    assert.equal(handle.ws, 'ws://127.0.0.1:12345/devtools/browser/abc');
    assert.equal(handle.debuggerAddress, '127.0.0.1:12345');
    assert.equal(context.grantCount, 1, 'geolocation permission granted on the happy path');
    assert.equal(
      context.pageHandlers.length,
      1,
      'future pages get fingerprinted via the page handler',
    );
    assert.equal(context.closeCount, 0, 'a successful launch must not close the context');
    // The returned close() delegates to the context.
    await handle.close();
    assert.equal(context.closeCount, 1);
  } finally {
    await rm(userDataDir, { recursive: true, force: true });
  }
});
