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
 * Read Chromium's `DevToolsActivePort` file, written by `--remote-debugging-port=0`.
 *
 * A previous crash/kill can leave a stale file pointing at a dead port. Callers should
 * {@link clearDevToolsActivePort} before spawn; this reader also requires the port to accept TCP
 * so branding / automation never attach to a zombie endpoint.
 */
export async function readDevToolsEndpoint(
  userDataDir: string,
  retries = 100,
): Promise<{ port: number; ws: string }> {
  const file = join(userDataDir, 'DevToolsActivePort');
  for (let attempt = 0; attempt < retries; attempt += 1) {
    try {
      const [portLine, pathLine] = (await readFile(file, 'utf8')).split('\n');
      const port = Number(portLine);
      if (Number.isInteger(port) && port > 0 && pathLine && (await tcpReachable(port))) {
        return { port, ws: `ws://127.0.0.1:${port}${pathLine.trim()}` };
      }
    } catch {
      // The browser is still starting and has not written the endpoint file yet.
    }
    await delay(100);
  }
  throw new Error('timed out waiting for the Lobium CDP endpoint (DevToolsActivePort)');
}
