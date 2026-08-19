import assert from 'node:assert/strict';
import test, { afterEach, beforeEach } from 'node:test';
import { cdpEvaluate, resolveCdpTarget, withCdpSession } from './cdp-client.js';

/**
 * A DevTools transport under our control.
 *
 * `withCdpSession` is the sidecar's only control channel (cookies, GPU calibration, shutdown), and the
 * behaviour that matters is what it does when the browser misbehaves — never answering, answering with
 * an error, or dropping the socket. A fake transport is the only way to produce those on demand.
 */
class FakeSocket extends EventTarget {
  static readonly OPEN = 1;
  static last: FakeSocket | undefined;
  readonly sent: Array<{ id: number; method: string; params?: Record<string, unknown> }> = [];
  readyState = FakeSocket.OPEN;
  closed = false;
  /** Set to have `send` throw, modelling a socket that died between the check and the write. */
  sendFails = false;

  constructor(readonly url: string) {
    super();
    FakeSocket.last = this;
    queueMicrotask(() => this.dispatchEvent(new Event('open')));
  }

  send(raw: string): void {
    if (this.sendFails) throw new Error('socket is not writable');
    this.sent.push(JSON.parse(raw) as { id: number; method: string });
  }

  close(): void {
    this.closed = true;
  }

  /** Deliver a protocol reply for the nth command this socket received. */
  reply(index: number, body: Record<string, unknown>): void {
    const request = this.sent[index];
    assert.ok(request, `no command at index ${index}`);
    const event = new Event('message') as Event & { data: string };
    event.data = JSON.stringify({ id: request.id, ...body });
    this.dispatchEvent(event);
  }

  drop(): void {
    this.dispatchEvent(new Event('close'));
  }
}

const realFetch = globalThis.fetch;
globalThis.WebSocket = FakeSocket as unknown as typeof WebSocket;

beforeEach(() => {
  FakeSocket.last = undefined;
  globalThis.fetch = (() => Promise.reject(new Error('no endpoint'))) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

/** Wait until the fake socket has received `count` commands. */
async function untilSent(socket: () => FakeSocket | undefined, count: number): Promise<FakeSocket> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const current = socket();
    if (current && current.sent.length >= count) return current;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`socket never received ${count} command(s)`);
}

test('a command resolves with its result and the socket is closed afterwards', async () => {
  const session = withCdpSession('ws://127.0.0.1:9/devtools/browser/x', async (cdp) => {
    return cdp.send('Network.setCookies', { cookies: [] });
  });
  const socket = await untilSent(() => FakeSocket.last, 1);
  socket.reply(0, { result: { ok: true } });
  assert.deepEqual(await session, { ok: true });
  assert.equal(socket.closed, true);
  assert.equal(socket.sent[0]?.method, 'Network.setCookies');
});

test('a protocol error becomes a rejection carrying the browser message', async () => {
  const session = withCdpSession('ws://127.0.0.1:9/devtools/browser/x', (cdp) =>
    cdp.send('Network.setCookies'),
  );
  const socket = await untilSent(() => FakeSocket.last, 1);
  socket.reply(0, { error: { message: 'Invalid cookie fields' } });
  await assert.rejects(session, /Invalid cookie fields/);
});

test('a per-command deadline fails only that command, not the whole session', async () => {
  const session = withCdpSession(
    'ws://127.0.0.1:9/devtools/browser/x',
    async (cdp) => {
      await assert.rejects(
        cdp.send('Runtime.evaluate', { expression: '1' }, { timeoutMs: 20 }),
        /Runtime\.evaluate timed out after 20ms/,
      );
      return cdp.send('Browser.close');
    },
    { timeoutMs: 5_000 },
  );
  const socket = await untilSent(() => FakeSocket.last, 2);
  socket.reply(1, { result: {} });
  await session;
});

test('the browser dropping the socket fails the in-flight command instead of hanging', async () => {
  const session = withCdpSession(
    'ws://127.0.0.1:9/devtools/browser/x',
    (cdp) => cdp.send('Network.getAllCookies'),
    { timeoutMs: 30_000 },
  );
  const socket = await untilSent(() => FakeSocket.last, 1);
  socket.drop();
  await assert.rejects(session, /CDP websocket closed/);
});

test('a write that fails rejects its command rather than leaving it pending', async () => {
  await assert.rejects(
    withCdpSession(
      'ws://127.0.0.1:9/devtools/browser/x',
      (cdp) => {
        const socket = FakeSocket.last;
        assert.ok(socket);
        socket.sendFails = true;
        return cdp.send('Network.setCookies');
      },
      { timeoutMs: 30_000 },
    ),
    /socket is not writable/,
  );
});

test('cdpEvaluate surfaces an uncaught page exception as an error', async () => {
  const session = withCdpSession('ws://127.0.0.1:9/devtools/browser/x', (cdp) =>
    cdpEvaluate(cdp, 'nope()'),
  );
  const socket = await untilSent(() => FakeSocket.last, 1);
  socket.reply(0, {
    result: { exceptionDetails: { exception: { description: 'ReferenceError: nope' } } },
  });
  await assert.rejects(session, /ReferenceError: nope/);
});

test('resolveCdpTarget prefers a page target and falls back to the browser endpoint', async () => {
  globalThis.fetch = (() =>
    Promise.resolve({
      json: () =>
        Promise.resolve([
          { type: 'background_page', webSocketDebuggerUrl: 'ws://127.0.0.1:9/bg' },
          { type: 'page', webSocketDebuggerUrl: 'ws://127.0.0.1:9/page/1' },
        ]),
    })) as unknown as typeof fetch;
  assert.equal(
    await resolveCdpTarget('ws://127.0.0.1:9/devtools/browser/x'),
    'ws://127.0.0.1:9/page/1',
  );

  globalThis.fetch = (() => Promise.reject(new Error('refused'))) as typeof fetch;
  assert.equal(
    await resolveCdpTarget('ws://127.0.0.1:9/devtools/browser/x'),
    'ws://127.0.0.1:9/devtools/browser/x',
  );
});
