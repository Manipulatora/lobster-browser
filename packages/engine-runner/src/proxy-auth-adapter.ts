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

/**
 * How many upstream failures, with NO tunnel ever having succeeded, before the proxy is judged
 * unusable rather than merely selective.
 *
 * Deliberately small but not 1. One failure proves nothing — the very first request a fresh Chrome
 * profile makes can be to a host the provider blocks. Several in a row with not one success is a
 * different claim: nothing at all gets through this upstream.
 */
const UNUSABLE_AFTER = 5;

/** An upstream failure, and whether it means the proxy is unusable rather than selective. */
export interface ProxyFailure {
  /** Human-readable, credentials already redacted. */
  message: string;
  /**
   * True only when the proxy cannot be used at all: wrong credentials (407/401), or repeated
   * failures with not one successful tunnel. A single blocked or rate-limited host is NOT fatal.
   */
  fatal: boolean;
  /** Upstream CONNECT status, when there was one. */
  statusCode?: number;
}

export interface LocalProxyAdapter {
  /** Value for Chromium `--proxy-server=` (no credentials). */
  proxyServer: string;
  /** Loopback port the shim listens on. */
  port: number;
  /** Tear down the local listener (call on profile stop / launch failure). */
  close: () => Promise<void>;
  /**
   * Observe an upstream failure without exposing credentials.
   *
   * The listener is called for EVERY failure so it can be reported; act destructively only on
   * `fatal`. This used to hand over a bare string, which gave the caller no way to tell "this one
   * host is blocked" from "this proxy does not work" — and the launcher, reasonably enough, treated
   * both as the latter and killed the browser.
   */
  onFailure: (listener: (failure: ProxyFailure) => void) => void;
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
  const failureListeners = new Set<(failure: ProxyFailure) => void>();

  // Has ANY tunnel through this upstream ever succeeded?
  //
  // This single bit separates the two situations the old code conflated. If a CONNECT has ever
  // returned 200 then the upstream is reachable, authenticated and working, so a later non-200 for
  // one host is that provider ENFORCING POLICY — a blocklisted domain, a rate limit, a flaky exit
  // node. That is ordinary and must not end the session. If nothing has ever succeeded, the proxy
  // may genuinely be unusable.
  let tunnelEverSucceeded = false;
  let consecutiveFailures = 0;
  server.on('tunnelConnectResponded', () => {
    tunnelEverSucceeded = true;
    consecutiveFailures = 0;
  });

  const emit = (failure: ProxyFailure): void => {
    for (const listener of failureListeners) listener(failure);
  };

  server.on('requestFailed', ({ error }: { error?: Error }) => {
    const message = (error?.message || 'upstream proxy request failed').replace(
      /\/\/[^@\s]+@/g,
      '//***@',
    );
    consecutiveFailures += 1;
    // proxy-chain raises this only for UNEXPECTED errors — a typed RequestError is answered to the
    // client instead (server.js failRequest). Still not proof the upstream is dead.
    emit({ message, fatal: !tunnelEverSucceeded && consecutiveFailures >= UNUSABLE_AFTER });
  });

  server.on('tunnelConnectFailed', ({ response }: { response?: { statusCode?: number } }) => {
    const statusCode = response?.statusCode;
    const message = `upstream proxy tunnel failed${statusCode ? ` (HTTP ${statusCode})` : ''}`;
    consecutiveFailures += 1;

    // 407 (and 401) mean the CREDENTIALS are wrong. Every request will fail identically, waiting
    // cannot help, and the user has to change something — the one case worth ending the session
    // over on the first occurrence.
    const authFailed = statusCode === 407 || statusCode === 401;

    // Any other non-200 is per-request policy, and it is NOT a leak. Chromium runs with
    // --proxy-server and no bypass list, so a refused tunnel surfaces as
    // ERR_TUNNEL_CONNECTION_FAILED on that one navigation; nothing is retried directly and the
    // profile's real IP is never exposed. Killing the browser therefore bought no safety at all.
    const unusable = !tunnelEverSucceeded && consecutiveFailures >= UNUSABLE_AFTER;

    // `exactOptionalPropertyTypes` is on: omit the key rather than passing undefined.
    emit({ message, fatal: authFailed || unusable, ...(statusCode ? { statusCode } : {}) });
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
