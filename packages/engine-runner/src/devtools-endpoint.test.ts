import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer, type Server } from 'node:net';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clearDevToolsActivePort, readDevToolsEndpoint } from './devtools-endpoint.js';

async function listenOnEphemeralPort(): Promise<{ port: number; server: Server }> {
  const server = createServer();
  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('no TCP port assigned'));
        return;
      }
      resolve(address.port);
    });
  });
  return { port, server };
}

function closeServer(server: Server): Promise<void> {
  return new Promise((resolve) => server.close(() => resolve()));
}

test('the endpoint is read once the browser has published a live port', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-devtools-'));
  const { port, server } = await listenOnEphemeralPort();
  try {
    const write = setTimeout(() => {
      void writeFile(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/ab12\n`, 'utf8');
    }, 60);
    write.unref();
    const endpoint = await readDevToolsEndpoint(dir, { timeoutMs: 5_000 });
    assert.equal(endpoint.port, port);
    assert.equal(endpoint.ws, `ws://127.0.0.1:${port}/devtools/browser/ab12`);
  } finally {
    await closeServer(server);
    await rm(dir, { recursive: true, force: true });
  }
});

test('a stale port file from a dead browser never resolves as an endpoint', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-devtools-'));
  // Bind and release so the number is real but nothing is listening on it any more — exactly the
  // file a crashed profile leaves behind, and attaching to it would drive some other process.
  const { port, server } = await listenOnEphemeralPort();
  await closeServer(server);
  try {
    await writeFile(join(dir, 'DevToolsActivePort'), `${port}\n/devtools/browser/dead\n`, 'utf8');
    await assert.rejects(
      readDevToolsEndpoint(dir, { timeoutMs: 300 }),
      /timed out waiting for the Lobium CDP endpoint .* after 300ms/,
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearDevToolsActivePort removes a leftover file and tolerates a missing one', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'lobster-devtools-'));
  try {
    await writeFile(join(dir, 'DevToolsActivePort'), '1\n/devtools/browser/x\n', 'utf8');
    await clearDevToolsActivePort(dir);
    await assert.rejects(readDevToolsEndpoint(dir, { timeoutMs: 100 }), /timed out/);
    await clearDevToolsActivePort(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
