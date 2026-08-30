import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer } from 'node:http';
import { connect as netConnect } from 'node:net';
import test from 'node:test';
import {
  assertUpstreamReachable,
  needsLocalProxyAdapter,
  startLocalProxyAdapter,
  upstreamProxyUrl,
} from './proxy-auth-adapter.js';

test('needsLocalProxyAdapter is true only when credentials are present', () => {
  assert.equal(needsLocalProxyAdapter(undefined), false);
  assert.equal(needsLocalProxyAdapter({ server: 'socks5://h:1080' }), false);
  assert.equal(needsLocalProxyAdapter({ server: 'socks5://h:1080', username: 'u' }), true);
  assert.equal(needsLocalProxyAdapter({ server: 'http://h:8080', password: 'p' }), true);
});

test('upstreamProxyUrl uses socks5h and embeds credentials without leaking into redaction tests', () => {
  assert.equal(
    upstreamProxyUrl({ server: 'socks5://proxy.example:1080', username: 'user', password: 'p@ss' }),
    'socks5h://user:p%40ss@proxy.example:1080',
  );
  assert.equal(upstreamProxyUrl({ server: 'socks://10.0.0.1:1080' }), 'socks5h://10.0.0.1:1080');
  assert.equal(
    upstreamProxyUrl({ server: 'http://proxy.example:8080', username: 'u', password: 'p' }),
    'http://u:p@proxy.example:8080',
  );
  assert.equal(
    upstreamProxyUrl({ server: 'https://proxy.example:443', username: 'u', password: 'p' }),
    'https://u:p@proxy.example:443',
  );
});

test('assertUpstreamReachable rejects a closed loopback port with a clear message', async () => {
  await assert.rejects(
    () => assertUpstreamReachable({ server: 'socks5://127.0.0.1:1' }, 2_000),
    /proxy 127\.0\.0\.1:1 is unreachable/,
  );
});

test('assertUpstreamReachable resolves when TCP connect succeeds', async () => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert.ok(addr && typeof addr === 'object');
  try {
    await assertUpstreamReachable({ server: `socks5://127.0.0.1:${addr.port}` }, 2_000);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((err) => (err ? reject(err) : resolve())),
    );
  }
});

test('startLocalProxyAdapter binds loopback HTTP and redacts creds on listen failure path', async () => {
  const adapter = await startLocalProxyAdapter({
    server: 'socks5://127.0.0.1:1',
    username: 'user',
    password: 'super-secret-password',
  });
  try {
    assert.match(adapter.proxyServer, /^http:\/\/127\.0\.0\.1:\d+$/);
    assert.ok(adapter.port > 0);
    assert.ok(!adapter.proxyServer.includes('super-secret-password'));
  } finally {
    await adapter.close();
  }
});

// ---------------------------------------------------------------------------------------------
// Failure classification — the phantom first launch.
//
// The launcher kills the browser when the adapter reports a FATAL failure. It used to report every
// upstream hiccup that way, so a single non-200 CONNECT ended the session; because a fresh Chrome
// profile CONNECTs to a burst of Google endpoints on startup, that overwhelmingly hit the FIRST
// launch and a retry on a warmed profile survived. These pin the distinction.
// ---------------------------------------------------------------------------------------------

/** A stand-in upstream that answers every CONNECT with one status. */
function upstreamAnswering(status: number): Promise<{ port: number; close: () => void }> {
  const srv = createHttpServer();
  srv.on('connect', (_req, socket) => {
    socket.end(`HTTP/1.1 ${status} X\r\n\r\n`);
  });
  return new Promise((resolve) => {
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        port: (srv.address() as { port: number }).port,
        close: () => srv.close(),
      });
    });
  });
}

async function collectFailures(
  status: number,
  attempts: number,
): Promise<Array<{ message: string; fatal: boolean; statusCode?: number }>> {
  const upstream = await upstreamAnswering(status);
  const adapter = await startLocalProxyAdapter({
    server: `http://127.0.0.1:${upstream.port}`,
    username: 'u',
    password: 'p',
  });
  const seen: Array<{ message: string; fatal: boolean; statusCode?: number }> = [];
  adapter.onFailure((f) => seen.push(f));

  for (let i = 0; i < attempts; i += 1) {
    await new Promise<void>((resolve) => {
      const s = netConnect({ host: '127.0.0.1', port: adapter.port }, () => {
        s.write('CONNECT example.com:443 HTTP/1.1\r\nHost: example.com:443\r\n\r\n');
      });
      const done = (): void => {
        try {
          s.destroy();
        } catch {
          /* already gone */
        }
        resolve();
      };
      s.once('data', done);
      s.once('error', done);
      s.once('close', done);
      setTimeout(done, 2000);
    });
    await new Promise((r) => setTimeout(r, 60));
  }
  await new Promise((r) => setTimeout(r, 250));
  await adapter.close();
  upstream.close();
  return seen;
}

test('a blocked host (403) is reported but is NOT fatal — the browser must keep running', async () => {
  const seen = await collectFailures(403, 2);
  assert.ok(seen.length > 0, 'the failure must still be reported');
  assert.ok(
    seen.every((f) => !f.fatal),
    `a provider blocking one host must never end the session, got: ${JSON.stringify(seen)}`,
  );
  assert.equal(seen[0]!.statusCode, 403);
});

test('rate limiting (429) is not fatal either', async () => {
  const seen = await collectFailures(429, 2);
  assert.ok(seen.length > 0);
  assert.ok(seen.every((f) => !f.fatal), JSON.stringify(seen));
});

test('a 407 is fatal on the FIRST occurrence — the credentials are wrong', async () => {
  // No amount of retrying fixes wrong credentials, and every request will fail identically, so
  // this is the one case worth stopping the session over immediately.
  const seen = await collectFailures(407, 1);
  assert.ok(seen.length > 0, 'expected a failure report');
  assert.equal(seen[0]!.fatal, true, `407 must be fatal, got ${JSON.stringify(seen[0])}`);
  assert.equal(seen[0]!.statusCode, 407);
});

test('an upstream that fails EVERYTHING becomes fatal, but only after several attempts', async () => {
  // Distinguishes "this proxy is dead" from "this proxy blocks one host". The first few must be
  // non-fatal, or the phantom-launch bug is simply back with a different status code.
  const seen = await collectFailures(502, 7);
  assert.ok(seen.length >= 5, `expected several reports, got ${seen.length}`);
  assert.ok(!seen[0]!.fatal, 'the first failure must not be fatal');
  assert.ok(!seen[1]!.fatal, 'the second failure must not be fatal');
  assert.ok(
    seen.some((f) => f.fatal),
    'a totally dead upstream must eventually be judged unusable',
  );
});
