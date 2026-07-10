import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { deriveFingerprint } from '@lobster/fingerprint';
import type { CdpSession } from '../cdp-fingerprint.js';
import { configureLaunchedContext } from './patchright-launcher.js';
import type { LaunchContext } from './types.js';

type Page = object;

/** Open a real localhost port so readDevToolsEndpoint's TCP check succeeds. */
async function writeReachableDevToolsPort(
  userDataDir: string,
  path = '/devtools/browser/abc',
): Promise<{ port: number; close: () => Promise<void> }> {
  const server: Server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  await writeFile(join(userDataDir, 'DevToolsActivePort'), `${port}\n${path}\n`);
  return {
    port,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
      }),
  };
}

class FakePage {
  navigatedTo: string | undefined;
  setContentHtml: string | undefined;
  constructor(private currentUrl = 'about:blank') {}
  url(): string {
    return this.currentUrl;
  }
  async goto(url: string, _opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
    this.navigatedTo = url;
    this.currentUrl = url;
  }
  async setContent(html: string, _opts?: { waitUntil?: string; timeout?: number }): Promise<void> {
    this.setContentHtml = html;
    this.currentUrl = 'about:blank';
  }
}

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
  on(event: 'page' | 'close', handler: (page: Page) => void): void {
    if (event === 'page') this.pageHandlers.push(handler);
  }
  async close(): Promise<void> {
    this.closeCount += 1;
  }
}

/** A minimal LaunchContext — only the fields configureLaunchedContext reads matter here. */
function fakeCtx(opts: { geolocation?: boolean; userDataDir?: string } = {}): LaunchContext {
  return {
    profileId: 'p',
    engine: 'lobium',
    fingerprint: deriveFingerprint('patchright-launcher-test', { os: 'windows', engine: 'lobium' }),
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
  const endpoint = await writeReachableDevToolsPort(userDataDir);
  try {
    const context = new FakeContext({ pages: [], grantThrows: false });
    const handle = await configureLaunchedContext(
      context,
      fakeCtx({ geolocation: true, userDataDir }),
    );
    assert.equal(handle.ws, `ws://127.0.0.1:${endpoint.port}/devtools/browser/abc`);
    assert.equal(handle.debuggerAddress, `127.0.0.1:${endpoint.port}`);
    assert.equal(context.grantCount, 1, 'geolocation permission granted on the happy path');
    assert.ok(
      context.pageHandlers.length >= 1,
      'future pages get fingerprinted / branded via page handlers',
    );
    assert.equal(context.closeCount, 0, 'a successful launch must not close the context');
    // The returned close() delegates to the context.
    await handle.close();
    assert.equal(context.closeCount, 1);
  } finally {
    await endpoint.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('configureLaunchedContext brands the initial blank page without a data: URL', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobster-launcher-'));
  const endpoint = await writeReachableDevToolsPort(userDataDir);
  try {
    const page = new FakePage();
    const context = new FakeContext({ pages: [page], grantThrows: false });

    const handle = await configureLaunchedContext(
      context,
      fakeCtx({ geolocation: false, userDataDir }),
    );

    assert.equal(page.url(), 'about:blank');
    assert.ok(page.setContentHtml?.includes('Lobster Browser'));
    assert.ok(!page.navigatedTo?.startsWith('data:text/html'));
    await handle.close();
  } finally {
    await endpoint.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});

test('configureLaunchedContext brands every subsequent new tab, not only the first', async () => {
  const userDataDir = await mkdtemp(join(tmpdir(), 'lobster-launcher-'));
  const endpoint = await writeReachableDevToolsPort(userDataDir);
  try {
    const first = new FakePage('about:blank');
    const context = new FakeContext({ pages: [first], grantThrows: false });

    await configureLaunchedContext(context, fakeCtx({ geolocation: false, userDataDir }));
    assert.ok(first.setContentHtml?.includes('Lobster Browser'));
    assert.ok(context.pageHandlers.length >= 1);

    const second = new FakePage('chrome://newtab');
    for (const handler of context.pageHandlers) handler(second);
    // Allow the void async handlers to settle.
    await new Promise((r) => setTimeout(r, 0));
    assert.ok(second.setContentHtml?.includes('Lobster Browser'));
    assert.equal(second.url(), 'about:blank');
  } finally {
    await endpoint.close();
    await rm(userDataDir, { recursive: true, force: true });
  }
});
