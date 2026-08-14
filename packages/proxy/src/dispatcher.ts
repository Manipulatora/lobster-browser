import type { ProxyConfig } from '@lobster/shared-types';
import { ProxyAgent, type Dispatcher } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
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
export function proxyDispatcherForUrl(uri: string): Dispatcher {
  if (/^socks/i.test(uri)) {
    // socks5h: resolve the destination at the exit, never here.
    return new SocksProxyAgent(uri.replace(/^socks5:\/\//i, 'socks5h://')) as unknown as Dispatcher;
  }
  // ProxyAgent parses the userinfo out of the URL and sets Proxy-Authorization itself.
  return new ProxyAgent({ uri });
}

export function proxyDispatcher(proxy: ProxyConfig): Dispatcher {
  return proxyDispatcherForUrl(formatProxyUrl(proxy));
}
