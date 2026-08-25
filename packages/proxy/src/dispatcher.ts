import type { ProxyConfig } from '@lobster/shared-types';
import { Agent, ProxyAgent, buildConnector, type Dispatcher } from 'undici';
import { SocksClient } from 'socks';
import { formatProxyUrl } from './parse.js';

/**
 * An undici dispatcher that routes a request through a profile's proxy.
 *
 * This package owns the answer to "how does traffic for this profile leave the machine", so anything
 * the sidecar fetches ON BEHALF of a profile — not just the geo lookup — asks here rather than
 * reimplementing the agent selection. A second implementation is how a request quietly ends up on
 * the direct route: the extension installer did exactly that, putting an HTTPS GET for a named
 * extension id on the wire from the host's real IP moments before the proxied session for that same
 * profile opened.
 *
 * SOCKS uses `socks5h` so the destination is resolved at the exit, never here — a local DNS lookup
 * is itself an observable, attributable request.
 */
/**
 * An undici `Dispatcher` that tunnels through a SOCKS proxy.
 *
 * `SocksProxyAgent` is an `http.Agent`, NOT an undici `Dispatcher`: it has no `dispatch()`. This used
 * to be handed to `fetch` as `dispatcher` behind an `as unknown as Dispatcher` cast, which compiled
 * cleanly and then failed at runtime with `agent.dispatch is not a function` — so EVERY SOCKS-proxied
 * request from the sidecar failed, and the failure surfaced as undici's opaque "fetch failed". A
 * profile with a SOCKS proxy and a Chrome Web Store extension could not launch at all.
 *
 * The destination host is passed to the proxy as a NAME, never pre-resolved here: that is the
 * `socks5h` guarantee, and a local DNS lookup would itself be an observable, attributable request.
 */
function socksDispatcher(uri: string): Dispatcher {
  const url = new URL(uri);
  const socksType = /^socks4/i.test(url.protocol) ? 4 : 5;
  const proxyPort = Number(url.port) || 1080;
  const userId = url.username ? decodeURIComponent(url.username) : undefined;
  const password = url.password ? decodeURIComponent(url.password) : undefined;
  // undici's own connector still runs on top of the tunnel, so https: gets a real TLS handshake
  // against the DESTINATION (correct SNI and certificate verification), not against the proxy.
  const connect = buildConnector({});
  return new Agent({
    connect(options, callback) {
      const port = options.port
        ? Number(options.port)
        : options.protocol === 'https:'
          ? 443
          : 80;
      SocksClient.createConnection({
        // exactOptionalPropertyTypes: the credential keys must be ABSENT for an unauthenticated
        // proxy, not present-and-undefined.
        proxy: {
          host: url.hostname,
          port: proxyPort,
          type: socksType as 4 | 5,
          ...(userId === undefined ? {} : { userId }),
          ...(password === undefined ? {} : { password }),
        },
        command: 'connect',
        destination: { host: String(options.hostname), port },
      })
        .then(({ socket }) => {
          // undici accepts `httpSocket` ONLY as a TLS upgrade. For https: hand the tunnelled socket
          // to its connector so the handshake happens against the DESTINATION (correct SNI and
          // certificate verification), never against the proxy. For plain http: there is nothing to
          // upgrade and undici asserts `httpSocket can only be sent on TLS update`, so return the
          // socket directly.
          if (options.protocol === 'https:') {
            return connect({ ...options, httpSocket: socket }, callback);
          }
          socket.setNoDelay(true);
          return callback(null, socket);
        })
        .catch((error: unknown) => {
          callback(error instanceof Error ? error : new Error(String(error)), null);
        });
    },
  });
}

export function proxyDispatcherForUrl(uri: string): Dispatcher {
  if (/^socks/i.test(uri)) {
    return socksDispatcher(uri);
  }
  // ProxyAgent parses the userinfo out of the URL and sets Proxy-Authorization itself.
  return new ProxyAgent({ uri });
}

export function proxyDispatcher(proxy: ProxyConfig): Dispatcher {
  return proxyDispatcherForUrl(formatProxyUrl(proxy));
}
