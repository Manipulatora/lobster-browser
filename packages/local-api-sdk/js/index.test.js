// @ts-check
/**
 * Tests for {@link LobsterClient}, run with the built-in Node test runner:
 *
 *     node --test        # or: npm test
 *
 * A mock `http` server plays the role of the desktop core: it records every request and answers
 * with the real `{ code, data, msg }` envelope. That lets us assert, with no network and no
 * dependencies, that the client sends the Bearer header, hits the right method+path, unwraps
 * `data`, does not retry an error envelope, and *does* retry a transport failure.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { LobsterClient, LobsterApiError } from './index.js';

const API_KEY = 'lb_test_key';

/** @type {import('node:http').Server} */
let server;
/** @type {LobsterClient} */
let client;

/**
 * Every request the mock server saw: `{ method, path, authorization, body, query }`.
 * @type {Array<{ method: string, path: string, authorization: string | undefined, body: any, query: URLSearchParams }>}
 */
const requests = [];
/** Attempts against `start('flaky')`, used by the retry test. */
let flakyAttempts = 0;

before(async () => {
  server = http.createServer((req, res) => {
    /** @type {Buffer[]} */
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : null;
      requests.push({
        method: req.method ?? '',
        path,
        authorization: req.headers.authorization,
        body,
        query: url.searchParams,
      });

      /** @param {number} status @param {unknown} obj */
      const send = (status, obj) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(obj));
      };
      /** @param {unknown} data */
      const ok = (data) => send(200, { code: 0, data, msg: 'success' });
      /** @param {number} status @param {string} msg */
      const fail = (status, msg) => send(status, { code: 1, data: null, msg });

      // `/health` — no auth required by the contract.
      if (req.method === 'GET' && path === '/api/v1/health') {
        return ok({ status: 'ok' });
      }

      if (req.method === 'POST' && path === '/api/v1/profile/start') {
        // A deterministic error envelope (must NOT be retried).
        if (body?.profileId === 'boom') return fail(400, 'profile boom exploded');
        // A transient transport failure on the first attempt, success on the retry.
        if (body?.profileId === 'flaky') {
          flakyAttempts += 1;
          if (flakyAttempts === 1) {
            req.socket.on('error', () => {}); // swallow the reset we're about to cause
            req.socket.destroy(); // -> client `fetch` rejects with a network error
            return;
          }
        }
        return ok({
          profileId: body.profileId,
          ws: 'ws://127.0.0.1:9222/devtools/browser/abc',
          debuggerAddress: '127.0.0.1:9222',
          webDriver: 'http://127.0.0.1:9222',
          pid: 4242,
        });
      }

      if (req.method === 'POST' && path === '/api/v1/profile/stop') {
        return ok({ profileId: body.profileId, stopped: true });
      }

      if (req.method === 'GET' && path === '/api/v1/profile/list') {
        return ok([{ profileId: 'p1', name: 'Profile One', running: true }]);
      }

      if (req.method === 'GET' && path === '/api/v1/profile/status') {
        return ok({
          profileId: url.searchParams.get('profileId'),
          running: true,
          ws: 'ws://127.0.0.1:9222/devtools/browser/abc',
          debuggerAddress: '127.0.0.1:9222',
        });
      }

      return fail(404, `no route for ${req.method} ${path}`);
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(undefined)));
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  // Short retryDelay keeps the retry test fast; also exercises the configurable backoff.
  client = new LobsterClient({ host: '127.0.0.1', port, apiKey: API_KEY, retryDelay: 10 });
});

after(async () => {
  await new Promise((resolve) => server.close(() => resolve(undefined)));
});

test('health() hits GET /health and unwraps data (works without requiring auth)', async () => {
  const data = await client.health();
  assert.deepEqual(data, { status: 'ok' });
  const last = requests.at(-1);
  assert.equal(last?.method, 'GET');
  assert.equal(last?.path, '/api/v1/health');
});

test('start() sends Bearer auth, POSTs the right body, and unwraps StartProfileResult', async () => {
  const data = await client.start('alpha', { headless: true });
  assert.equal(data.profileId, 'alpha');
  assert.equal(data.ws, 'ws://127.0.0.1:9222/devtools/browser/abc');
  assert.equal(data.debuggerAddress, '127.0.0.1:9222');
  assert.equal(data.pid, 4242);

  const last = requests.at(-1);
  assert.equal(last?.method, 'POST');
  assert.equal(last?.path, '/api/v1/profile/start');
  assert.equal(last?.authorization, `Bearer ${API_KEY}`); // <-- Authorization: Bearer is sent
  assert.deepEqual(last?.body, { profileId: 'alpha', headless: true });
});

test('stop() POSTs to /profile/stop and unwraps { profileId, stopped }', async () => {
  const data = await client.stop('alpha');
  assert.deepEqual(data, { profileId: 'alpha', stopped: true });
  const last = requests.at(-1);
  assert.equal(last?.method, 'POST');
  assert.equal(last?.path, '/api/v1/profile/stop');
  assert.equal(last?.authorization, `Bearer ${API_KEY}`);
});

test('status() GETs /profile/status with the profileId query and unwraps the status', async () => {
  const data = await client.status('alpha');
  assert.equal(data.profileId, 'alpha');
  assert.equal(data.running, true);
  const last = requests.at(-1);
  assert.equal(last?.method, 'GET');
  assert.equal(last?.path, '/api/v1/profile/status');
  assert.equal(last?.query.get('profileId'), 'alpha');
  assert.equal(last?.authorization, `Bearer ${API_KEY}`);
});

test('list() GETs /profile/list and unwraps the array', async () => {
  const data = await client.list();
  assert.deepEqual(data, [{ profileId: 'p1', name: 'Profile One', running: true }]);
  const last = requests.at(-1);
  assert.equal(last?.method, 'GET');
  assert.equal(last?.path, '/api/v1/profile/list');
});

test('a non-zero envelope throws LobsterApiError and is NOT retried', async () => {
  const before = requests.filter((r) => r.body?.profileId === 'boom').length;
  await assert.rejects(
    () => client.start('boom'),
    (err) => {
      assert.ok(err instanceof LobsterApiError);
      assert.equal(err.code, 1);
      assert.equal(err.httpStatus, 400);
      assert.equal(err.endpoint, 'POST /profile/start');
      assert.match(err.message, /profile boom exploded/);
      return true;
    },
  );
  const after = requests.filter((r) => r.body?.profileId === 'boom').length;
  assert.equal(after - before, 1, 'error envelope must be attempted exactly once (no retry)');
});

test('a network error is retried and then succeeds', async () => {
  flakyAttempts = 0;
  const data = await client.start('flaky');
  assert.equal(data.profileId, 'flaky');
  assert.equal(flakyAttempts, 2, 'first attempt fails at the socket, second succeeds');
});

test('connectPlaywright() returns just { ws, debuggerAddress }', async () => {
  const endpoints = await client.connectPlaywright('alpha');
  assert.deepEqual(endpoints, {
    ws: 'ws://127.0.0.1:9222/devtools/browser/abc',
    debuggerAddress: '127.0.0.1:9222',
  });
});
