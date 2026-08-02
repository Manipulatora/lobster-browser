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
  /**
   * Loopback `host:port` endpoints the browser must still reach DIRECTLY while proxied — today just
   * the sidecar's own agent bridge, which the Lobee side panel calls over `http://127.0.0.1:<port>`.
   *
   * `<-loopback>` removes Chromium's implicit localhost bypass, so without these entries the panel's
   * own requests are handed to the upstream proxy, where `127.0.0.1` means the PROVIDER's loopback —
   * the panel simply stops working on every proxied profile.
   *
   * Scoped to one exact host:port, so this reopens nothing else on loopback. Malformed entries are
   * dropped rather than trusted: dropping only sends more traffic through the tunnel (the safe
   * direction), while an unvalidated entry could silently widen the bypass.
   */
  loopbackAllowlist?: readonly string[];
}

/** `127.0.0.1:8080`, `localhost:8080`, or `[::1]:8080` — nothing broader may reach the bypass list. */
const LOOPBACK_ENDPOINT = /^(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})$/;

function isLoopbackEndpoint(entry: string): boolean {
  const port = Number(LOOPBACK_ENDPOINT.exec(entry)?.[1]);
  return Number.isInteger(port) && port > 0 && port <= 65_535;
}

/**
 * Build the `--proxy-bypass-list` value.
 *
 * ORDER IS LOAD-BEARING, and not in the intuitive direction. `<-loopback>` does not merely "lose" to a
 * more specific rule — it STRIPS the loopback bypasses accumulated so far, so an endpoint listed
 * before it is silently erased. Only entries that come AFTER it survive. Measured on Lobium 152 with a
 * dead upstream proxy and a live loopback server (`BRIDGE-OK` = reached directly):
 *
 *   --proxy-bypass-list=<-loopback>                    -> blocked   (the bypass we want to keep)
 *   --proxy-bypass-list=127.0.0.1:PORT;<-loopback>     -> blocked   (entry erased — the wrong order)
 *   --proxy-bypass-list=<-loopback>;127.0.0.1:PORT     -> DIRECT    (what this function emits)
 *
 * Containment was measured too: with `<-loopback>;127.0.0.1:PORT`, a DIFFERENT loopback port is still
 * forced through the proxy — so naming one endpoint reopens only that endpoint.
 */
export function buildProxyBypassList(loopbackAllowlist: readonly string[] = []): string {
  const allowed = [...new Set(loopbackAllowlist.filter(isLoopbackEndpoint))];
  return ['<-loopback>', ...allowed].join(';');
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
    // Do not let Chromium silently bypass the configured upstream for localhost/intranet names.
    // This is browser-process fail-closed behavior, not an OS firewall. First-party loopback
    // services the browser must still reach are re-added after `<-loopback>` (see the ordering
    // note on buildProxyBypassList — listing them first would erase them).
    `--proxy-bypass-list=${buildProxyBypassList(opts.loopbackAllowlist)}`,
  ];
}
