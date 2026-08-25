import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer as createHttpServer } from 'node:http';
import { createServer as createTcpServer, connect as tcpConnect, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';
import { proxyDispatcherForUrl } from './dispatcher.js';

/**
 * A minimal SOCKS5 CONNECT server.
 *
 * The bug this guards against compiled cleanly and failed only on the wire: `SocksProxyAgent` is an
 * `http.Agent`, not an undici `Dispatcher`, so `fetch` threw `agent.dispatch is not a function` for
 * every SOCKS-proxied request — and undici reported it as the opaque "fetch failed". Asserting that
 * the dispatcher merely *has* a `dispatch` method would not prove the tunnel carries traffic, so this
 * drives a real request end to end and records the destination the proxy was asked for, which is also
 * how the `socks5h` promise (resolve at the exit, never here) is checked.
 */
function startSocks5(onDestination: (host: string, port: number) => void) {
  const sockets = new Set<Socket>();
  const server = createTcpServer((client) => {
    sockets.add(client);
    client.on('close', () => sockets.delete(client));
    let stage: 'greeting' | 'request' = 'greeting';
    const onData = (chunk: Buffer) => {
      if (stage === 'greeting') {
        client.write(Buffer.from([0x05, 0x00])); // no auth required
        stage = 'request';
        return;
      }
      const atyp = chunk[3];
      let host = '';
      let offset = 4;
      if (atyp === 0x03) {
        const len = chunk[4]!;
        host = chunk.subarray(5, 5 + len).toString('utf8');
        offset = 5 + len;
      } else {
        host = Array.from(chunk.subarray(4, 8)).join('.');
        offset = 8;
      }
      const port = chunk.readUInt16BE(offset);
      onDestination(host, port);
      const upstream = tcpConnect(
        { host: host === 'localhost' ? '127.0.0.1' : host, port },
        () => {
          // Stop parsing once the tunnel is up: everything after this is payload, and treating it
          // as another CONNECT request invents phantom destinations.
          client.off('data', onData);
          client.write(Buffer.from([0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
          client.pipe(upstream);
          upstream.pipe(client);
        },
      );
      sockets.add(upstream);
      upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => {
        client.write(Buffer.from([0x05, 0x01, 0x00, 0x01, 0, 0, 0, 0, 0, 0]));
        client.destroy();
      });
    };
    client.on('data', onData);
    client.on('error', () => {});
  });
  return {
    server,
    destroyAll() {
      for (const socket of sockets) socket.destroy();
      sockets.clear();
    },
  };
}

test('a SOCKS dispatcher is a real undici Dispatcher and actually tunnels the request', async () => {
  const origin = createHttpServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('through-the-tunnel');
  });
  await new Promise<void>((resolve) => origin.listen(0, '127.0.0.1', resolve));
  const originPort = (origin.address() as AddressInfo).port;

  const seen: Array<{ host: string; port: number }> = [];
  const socks = startSocks5((host, port) => seen.push({ host, port }));
  await new Promise<void>((resolve) => socks.server.listen(0, '127.0.0.1', resolve));
  const socksPort = (socks.server.address() as AddressInfo).port;

  const dispatcher = proxyDispatcherForUrl(`socks5://127.0.0.1:${socksPort}`);
  // The exact shape the old `as unknown as Dispatcher` cast lied about: an http.Agent has no
  // dispatch(), which is why every socks-proxied fetch died at runtime.
  assert.equal(
    typeof (dispatcher as unknown as { dispatch?: unknown }).dispatch,
    'function',
    'a SOCKS dispatcher must expose undici dispatch(); an http.Agent does not',
  );

  try {
    const response = await fetch(`http://localhost:${originPort}/`, {
      dispatcher,
    } as unknown as RequestInit);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'through-the-tunnel');
    assert.equal(seen.length, 1, 'the request must have travelled through the proxy');
    // socks5h: the proxy receives the NAME, so no attributable local DNS lookup happened.
    assert.equal(seen[0]!.host, 'localhost');
    assert.equal(seen[0]!.port, originPort);
  } finally {
    await dispatcher.close();
    socks.destroyAll();
    await new Promise<void>((resolve) => socks.server.close(() => resolve()));
    await new Promise<void>((resolve) => origin.close(() => resolve()));
  }
});

test('an http proxy still gets undici ProxyAgent', async () => {
  const dispatcher = proxyDispatcherForUrl('http://user:pass@127.0.0.1:8080');
  assert.equal(typeof (dispatcher as unknown as { dispatch?: unknown }).dispatch, 'function');
  await dispatcher.close();
});
