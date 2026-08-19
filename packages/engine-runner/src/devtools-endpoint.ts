import { connect } from 'node:net';
import { readFile, unlink } from 'node:fs/promises';
import { join } from 'node:path';

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Best-effort remove of a leftover DevToolsActivePort from a previous run. */
export async function clearDevToolsActivePort(userDataDir: string): Promise<void> {
  try {
    await unlink(join(userDataDir, 'DevToolsActivePort'));
  } catch {
    /* missing is fine */
  }
}

function tcpReachable(port: number, host = '127.0.0.1', timeoutMs = 250): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => done(true));
    socket.once('timeout', () => done(false));
    socket.once('error', () => done(false));
  });
}

/**
 * How long a launch waits for the engine to publish its CDP endpoint.
 *
 * A first run on a cold Windows box creates the profile directory, unpacks component data and does it
 * all through an on-access virus scanner, which can push the endpoint well past the ten seconds a
 * warm Linux dev machine needs. The old fixed cap turned that into a spurious "timed out waiting for
 * the Lobium CDP endpoint" launch failure, so the deadline is generous and operators can raise it.
 */
const DEFAULT_ENDPOINT_TIMEOUT_MS = 45_000;

function endpointTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
  const configured = Number(env.LOBSTER_CDP_ENDPOINT_TIMEOUT_MS);
  return Number.isFinite(configured) && configured > 0 ? configured : DEFAULT_ENDPOINT_TIMEOUT_MS;
}

/**
 * Read Chromium's `DevToolsActivePort` file, written by `--remote-debugging-port=0`.
 *
 * A previous crash/kill can leave a stale file pointing at a dead port. Callers should
 * {@link clearDevToolsActivePort} before spawn; this reader also requires the port to accept TCP
 * so branding / automation never attach to a zombie endpoint.
 */
export async function readDevToolsEndpoint(
  userDataDir: string,
  opts: { timeoutMs?: number } = {},
): Promise<{ port: number; ws: string }> {
  const file = join(userDataDir, 'DevToolsActivePort');
  const timeoutMs = opts.timeoutMs ?? endpointTimeoutMs();
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt += 1) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine && (await tcpReachable(port))) {
        return { port, ws: `ws://127.0.0.1:${port}${pathLine.trim()}` };
      }
    } catch {
      // The browser is still starting and has not written the endpoint file yet.
    }
    if (Date.now() >= deadline) break;
    // Poll tightly at first: the endpoint is published before the startup window is created, so every
    // millisecond saved here is a millisecond of first-page load the launch still gets to configure.
    await delay(attempt < 40 ? 25 : 100);
  }
  throw new Error(
    `timed out waiting for the Lobium CDP endpoint (DevToolsActivePort) after ${timeoutMs}ms`,
  );
}
