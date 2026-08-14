import { lookup as nodeLookup } from 'node:dns/promises';
import { isIP } from 'node:net';

/**
 * Where a profile resolves destination hostnames.
 *
 * A direct profile uses the host resolver, so this process can perform a meaningful preflight. A
 * proxied profile resolves at the proxy exit (SOCKS uses remote DNS and HTTP CONNECT commonly does),
 * so resolving locally would answer a different question and can incorrectly block legitimate sites.
 */
export type ProfileNetworkRoute = 'direct' | 'remote-proxy' | 'unknown';

export interface ResolvedAddress {
  address: string;
  family: number;
}

export type ResolveAddresses = (hostname: string) => Promise<readonly ResolvedAddress[]>;

export interface NavigationEgressOptions {
  /** Read at navigation time because a lazy browser may be launched after the agent run starts. */
  route: () => ProfileNetworkRoute;
  /** Explicit user opt-in from AgentConfig. This bypasses only the private-network destination gate. */
  allowPrivateNetwork: boolean;
  /** Injected for deterministic tests. The production default uses the OS resolver and returns all IPs. */
  resolve?: ResolveAddresses;
  /** A stuck OS resolver must not wedge the run indefinitely. Default: 3 seconds. */
  timeoutMs?: number;
}

/**
 * Construct a driver-boundary preflight for explicit top-frame navigations.
 *
 * This is defense in depth behind the agent's deterministic URL policy. It intentionally does not
 * pretend to be a complete network sandbox:
 *
 * - Chromium can resolve a direct hostname differently from Node (DoH, resolver cache, DNS rebinding).
 * - redirects, subresources, service workers, and page-initiated navigations do not pass this seam.
 * - for a remote proxy, only the proxy can enforce the resolved-IP ACL without changing DNS semantics.
 *
 * A browser/process egress ACL or an enforcing upstream proxy is therefore still required for a hard
 * private-network boundary. No result is cached: resolving once and reusing that verdict would make a
 * rebinding window larger.
 */
export function createNavigationEgressPreflight(
  options: NavigationEgressOptions,
): (rawUrl: string) => Promise<void> {
  const resolve = options.resolve ?? resolveWithNode;
  const timeoutMs = options.timeoutMs ?? 3_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 30_000) {
    throw new Error('navigation DNS timeout must be an integer between 1 and 30000 milliseconds');
  }

  return async (rawUrl: string): Promise<void> => {
    // Scheme/URL eligibility remains owned by the pure agent policy. This guard is specifically an
    // egress check; browser-owned URLs such as chrome://settings never touch the network and must keep
    // working through the settings fallback.
    let url: URL;
    try {
      url = new URL(rawUrl);
    } catch {
      throw blocked('destination URL is invalid');
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return;
    if (options.allowPrivateNetwork) return;

    const hostname = normalizeHostname(url.hostname);
    if (!hostname) throw blocked('destination has no hostname');
    const literalFamily = isIP(stripZone(hostname));
    if (literalFamily !== 0) {
      if (isPrivateOrSpecialAddress(hostname)) {
        throw blocked(`private or special destination ${hostname}`);
      }
      return;
    }
    if (isLocalHostname(hostname)) throw blocked(`local destination ${hostname}`);

    const route = options.route();
    if (route === 'remote-proxy') {
      // Local DNS is neither authoritative nor necessarily available for a proxy-resolved hostname.
      // The upstream proxy must enforce its own resolved-IP denylist; see the function contract.
      return;
    }
    if (route !== 'direct') {
      throw blocked('the profile network route is unknown, so DNS safety cannot be verified');
    }

    let addresses: readonly ResolvedAddress[];
    try {
      addresses = await withTimeout(resolve(hostname), timeoutMs);
    } catch (error) {
      if (error instanceof NavigationDnsTimeoutError) {
        throw blocked(`DNS preflight for ${hostname} timed out`);
      }
      throw blocked(`DNS preflight could not resolve ${hostname}`);
    }
    if (addresses.length === 0) {
      throw blocked(`DNS preflight returned no addresses for ${hostname}`);
    }
    // A malicious/broken resolver response must stay bounded and fail closed rather than making the
    // guard spend unbounded work validating an attacker-controlled list.
    if (addresses.length > 64) {
      throw blocked(`DNS preflight returned too many addresses for ${hostname}`);
    }
    for (const record of addresses) {
      if (
        (record.family !== 4 && record.family !== 6) ||
        isIP(stripZone(record.address)) !== record.family
      ) {
        throw blocked(`DNS preflight returned an invalid address for ${hostname}`);
      }
      if (isPrivateOrSpecialAddress(record.address)) {
        // Never print the resolved address. It may disclose an internal network identifier into the
        // transcript/model context; the hostname gives the user enough information to diagnose it.
        throw blocked(`DNS for ${hostname} resolved to a private or special address`);
      }
    }
  };
}

class NavigationDnsTimeoutError extends Error {}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new NavigationDnsTimeoutError()), timeoutMs);
  });
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function resolveWithNode(hostname: string): Promise<readonly ResolvedAddress[]> {
  return nodeLookup(hostname, { all: true, verbatim: true });
}

function blocked(reason: string): Error {
  return new Error(`navigation blocked: ${reason}`);
}

function normalizeHostname(hostname: string): string {
  return hostname
    .trim()
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
}

function stripZone(address: string): string {
  return normalizeHostname(address).split('%', 1)[0] ?? '';
}

function isLocalHostname(hostname: string): boolean {
  return (
    hostname === 'localhost' ||
    hostname === 'localhost.localdomain' ||
    hostname.endsWith('.localhost') ||
    hostname.endsWith('.local') ||
    hostname.endsWith('.internal') ||
    hostname === 'home.arpa' ||
    hostname.endsWith('.home.arpa') ||
    // Bare names are commonly resolved through a search suffix to an intranet service. They cannot
    // be validated at the proxy exit without an enforcing proxy, so reject them in both route modes.
    !hostname.includes('.')
  );
}

/** True for loopback/private/link-local and other IANA non-public IP space. */
export function isPrivateOrSpecialAddress(rawAddress: string): boolean {
  const address = stripZone(rawAddress);
  const family = isIP(address);
  if (family === 4) {
    const bytes = parseIpv4(address);
    return !bytes || isPrivateOrSpecialIpv4(bytes);
  }
  if (family !== 6) return true;
  const bytes = parseIpv6(address);
  if (!bytes) return true;

  const allZero = bytes.every((byte) => byte === 0);
  const loopback = bytes.slice(0, 15).every((byte) => byte === 0) && bytes[15] === 1;
  const ula = (bytes[0]! & 0xfe) === 0xfc; // fc00::/7
  const linkOrSiteLocal = bytes[0] === 0xfe && (bytes[1]! & 0xc0) >= 0x80; // fe80::/10 + fec0::/10
  const multicast = bytes[0] === 0xff; // ff00::/8
  const discardOnly = bytes[0] === 0x01 && bytes.slice(1, 8).every((byte) => byte === 0); // 100::/64
  const documentation =
    bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x0d && bytes[3] === 0xb8;
  const teredo = bytes[0] === 0x20 && bytes[1] === 0x01 && bytes[2] === 0x00 && bytes[3] === 0x00; // 2001::/32
  const localNat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes[4] === 0x00 &&
    bytes[5] === 0x01; // 64:ff9b:1::/48 (local-use translation)
  if (
    allZero ||
    loopback ||
    ula ||
    linkOrSiteLocal ||
    multicast ||
    discardOnly ||
    documentation ||
    teredo ||
    localNat64
  ) {
    return true;
  }

  const embeddedIpv4 = (offset: number): boolean =>
    isPrivateOrSpecialIpv4([
      bytes[offset]!,
      bytes[offset + 1]!,
      bytes[offset + 2]!,
      bytes[offset + 3]!,
    ]);
  const firstTenZero = bytes.slice(0, 10).every((byte) => byte === 0);
  const mapped = firstTenZero && bytes[10] === 0xff && bytes[11] === 0xff;
  const compatible = bytes.slice(0, 12).every((byte) => byte === 0);
  if ((mapped || compatible) && embeddedIpv4(12)) return true;

  // Well-known NAT64 and 6to4 addresses embed the real IPv4 destination.
  const nat64 =
    bytes[0] === 0x00 &&
    bytes[1] === 0x64 &&
    bytes[2] === 0xff &&
    bytes[3] === 0x9b &&
    bytes.slice(4, 12).every((byte) => byte === 0);
  if (nat64 && embeddedIpv4(12)) return true;
  const sixToFour = bytes[0] === 0x20 && bytes[1] === 0x02;
  return sixToFour && embeddedIpv4(2);
}

function parseIpv4(value: string): number[] | undefined {
  const parts = value.split('.');
  if (parts.length !== 4) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)
    ? bytes
    : undefined;
}

function isPrivateOrSpecialIpv4(bytes: ArrayLike<number>): boolean {
  const a = bytes[0]!;
  const b = bytes[1]!;
  const c = bytes[2]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) || // shared address space
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 0 && c === 2) || // documentation
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) || // benchmarking
    (a === 198 && b === 51 && c === 100) || // documentation
    (a === 203 && b === 0 && c === 113) || // documentation
    a >= 224
  );
}

/** Parse RFC 4291 compressed/mixed IPv6 into network-order bytes. */
function parseIpv6(value: string): Uint8Array | undefined {
  let address = stripZone(value);
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const ipv4 = parseIpv4(dotted[1]!);
    if (!ipv4) return undefined;
    const replacement = `${((ipv4[0]! << 8) | ipv4[1]!).toString(16)}:${(
      (ipv4[2]! << 8) |
      ipv4[3]!
    ).toString(16)}`;
    address = `${address.slice(0, dotted.index)}${address[dotted.index] === ':' ? ':' : ''}${replacement}`;
  }
  if ((address.match(/::/g) ?? []).length > 1) return undefined;
  const compressed = address.includes('::');
  const [leftRaw, rightRaw = ''] = address.split('::');
  const left = leftRaw ? leftRaw.split(':') : [];
  const right = rightRaw ? rightRaw.split(':') : [];
  if ([...left, ...right].some((part) => !/^[0-9a-f]{1,4}$/.test(part))) return undefined;
  if ((!compressed && left.length !== 8) || (compressed && left.length + right.length >= 8)) {
    return undefined;
  }
  const groups = compressed
    ? [...left, ...Array<string>(8 - left.length - right.length).fill('0'), ...right]
    : left;
  if (groups.length !== 8) return undefined;
  const bytes = new Uint8Array(16);
  groups.forEach((group, index) => {
    const word = Number.parseInt(group, 16);
    bytes[index * 2] = word >>> 8;
    bytes[index * 2 + 1] = word & 0xff;
  });
  return bytes;
}
