/**
 * Chromium launch args for proxy fail-closed / DNS-leak hardening (PROX-7/8).
 *
 * These are the browser-side controls we can enforce without OS firewall rules.
 * Full kill-switch (block all non-proxy egress at the OS) remains a documented gap —
 * see docs/specs notes in PROJECT-STATUS PROX-7/8.
 */

import type { ProxyConfig } from '@lobster/shared-types';

export interface ProxyHardeningOptions {
  /** When true (default with a proxy), emit fail-closed Chromium flags. */
  killSwitch?: boolean;
}

/**
 * Extra Chromium args applied when a profile launches behind a proxy.
 *
 * - Disable QUIC/HTTP3 so UDP cannot bypass the HTTP/SOCKS proxy tunnel.
 * - Disable Async DNS / DoH upgrade paths that can race outside the proxy.
 *
 * SOCKS5 remote DNS is handled by using `socks5://` (Chromium resolves via the proxy).
 * OS-level firewall kill-switch is intentionally out of scope here.
 */
export function buildProxyHardeningArgs(
  proxy: ProxyConfig | undefined,
  opts: ProxyHardeningOptions = {},
): string[] {
  if (!proxy) return [];
  if (opts.killSwitch === false) return [];

  return [
    '--disable-quic',
    '--disable-features=AsyncDns,DnsOverHttpsUpgrade',
  ];
}
