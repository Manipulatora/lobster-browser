import assert from 'node:assert/strict';
import { createServer } from 'node:net';
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
  assert.equal(
    upstreamProxyUrl({ server: 'socks://10.0.0.1:1080' }),
    'socks5h://10.0.0.1:1080',
  );
  assert.equal(
    upstreamProxyUrl({ server: 'http://proxy.example:8080', username: 'u', password: 'p' }),
    'http://u:p@proxy.example:8080',
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
