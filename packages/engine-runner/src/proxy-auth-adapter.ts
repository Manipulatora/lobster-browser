/**
 * Local authenticated-proxy adapter for native Lobium (PROX / docs/OPERATIONS.md).
 *
 * Chromium cannot pass SOCKS5/HTTP proxy credentials via `--proxy-server`. We front the upstream
 * with a loopback HTTP proxy (proxy-chain) that holds the credentials; Lobium attaches to
 * `http://127.0.0.1:<ephemeral>` with no auth.
 *
 * Credentials never touch lobium-fp.json — only the local listen address is passed as a flag.
 */
import { createConnection } from 'node:net';
import { Server } from 'proxy-chain';

export interface UpstreamProxy {
  /** Playwright-style server URL without credentials, e.g. `socks5://host:1080`. */
  server: string;
  username?: string;
  password?: string;
}

export interface LocalProxyAdapter {
  /** Value for Chromium `--proxy-server=` (no credentials). */
  proxyServer: string;
  /** Loopback port the shim listens on. */
  port: number;
  /** Tear down the local listener (call on profile stop / launch failure). */
  close: () => Promise<void>;
  /** Observe an upstream request failure without exposing credentials. */
  onFailure: (listener: (message: string) => void) => void;
}

function encodeUserinfo(username: string, password?: string): string {
  const user = encodeURIComponent(username);
  return password !== undefined ? `${user}:${encodeURIComponent(password)}` : user;
}

/**
 * Build an upstream URL proxy-chain understands, including credentials when present.
 * Uses `socks5h://` for SOCKS so DNS resolves at the exit (remote DNS).
 */
export function upstreamProxyUrl(proxy: UpstreamProxy): string {
  const raw = new URL(proxy.server);
  const protocol = raw.protocol.replace(/:$/, '').toLowerCase();
  // socks5h = remote DNS (Chromium SOCKS5h semantics via the shim).
  const scheme =
    protocol === 'socks' || protocol === 'socks5' || protocol === 'socks5h'
      ? 'socks5h'
      : protocol === 'https'
        ? 'https'
        : protocol === 'http'
          ? 'http'
          : undefined;
  if (!scheme) throw new Error(`unsupported upstream proxy scheme "${protocol}"`);
  const port = raw.port
    ? Number(raw.port)
    : scheme === 'https'
      ? 443
      : scheme === 'http'
        ? 80
        : 1080;
  if (!raw.hostname || !Number.isInteger(port) || port <= 0 || port > 65_535) {
    throw new Error(`invalid upstream proxy host/port in ${proxy.server}`);
  }
  if (proxy.password !== undefined && proxy.username === undefined) {
    throw new Error('upstream proxy password cannot be supplied without a username');
  }
  const auth =
    proxy.username !== undefined ? `${encodeUserinfo(proxy.username, proxy.password)}@` : '';
  return `${scheme}://${auth}${raw.hostname}:${port}`;
}

/** True when the launch proxy carries credentials Chromium cannot consume directly. */
export function needsLocalProxyAdapter(proxy: UpstreamProxy | undefined): boolean {
  return Boolean(proxy && (proxy.username || proxy.password));
}

/**
 * Fail-closed TCP reachability probe for the upstream host:port.
 * Surfaces a clear error before we spawn Lobium or start the shim.
 */
export async function assertUpstreamReachable(
  proxy: UpstreamProxy,
  timeoutMs = 8_000,
): Promise<void> {
  let host: string;
  let port: number;
  try {
    const u = new URL(proxy.server);
    host = u.hostname;
    port = Number(u.port);
  } catch {
    throw new Error(`invalid proxy server URL: ${proxy.server}`);
  }
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`invalid proxy host/port in ${proxy.server}`);
  }

  await new Promise<void>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy();
      reject(
        new Error(
          `proxy ${host}:${port} is unreachable (TCP timed out after ${timeoutMs}ms). ` +
            'Check the proxy host/port, that this machine can reach it, and provider allowlists.',
        ),
      );
    }, timeoutMs);
    timer.unref();
    socket.once('connect', () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(
        new Error(
          `proxy ${host}:${port} is unreachable (${err.message}). ` +
            "Check the proxy host/port, firewall, and provider allowlists for this machine's IP.",
        ),
      );
    });
  });
}

/**
 * Start a loopback HTTP proxy that forwards to the authenticated upstream.
 * Binds `127.0.0.1:0` (ephemeral port). Caller must `close()` on stop.
 */
export async function startLocalProxyAdapter(proxy: UpstreamProxy): Promise<LocalProxyAdapter> {
  const upstream = upstreamProxyUrl(proxy);
  // Redact credentials in any thrown messages that might echo the URL.
  const redactedUpstream = upstream.replace(/\/\/[^@]+@/, '//***@');

  const server = new Server({
    // Loopback only — never expose the credential-bearing shim on a public interface.
    host: '127.0.0.1',
    port: 0,
    prepareRequestFunction: () => ({
      upstreamProxyUrl: upstream,
    }),
  });
  const failureListeners = new Set<(message: string) => void>();
  server.on('requestFailed', ({ error }: { error?: Error }) => {
    const message = (error?.message || 'upstream proxy request failed').replace(
      /\/\/[^@\s]+@/g,
      '//***@',
    );
    for (const listener of failureListeners) listener(message);
  });
  server.on('tunnelConnectFailed', ({ response }: { response?: { statusCode?: number } }) => {
    const message = `upstream proxy tunnel failed${
      response?.statusCode ? ` (HTTP ${response.statusCode})` : ''
    }`;
    for (const listener of failureListeners) listener(message);
  });

  try {
    await server.listen();
  } catch (err) {
    throw new Error(
      `failed to start local proxy auth adapter for ${redactedUpstream}: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }

  const port = server.port;
  if (!Number.isInteger(port) || port <= 0) {
    await server.close(true).catch(() => {});
    throw new Error('local proxy auth adapter did not bind a port');
  }

  return {
    proxyServer: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      await server.close(true).catch(() => {});
    },
    onFailure: (listener) => {
      failureListeners.add(listener);
    },
  };
}
