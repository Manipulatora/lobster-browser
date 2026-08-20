/**
 * Is this host inside the local network rather than out on the public internet?
 *
 * Lives in its own module because two different fences need the same answer and must never drift
 * apart: the navigation policy, which decides where a running agent may go, and the browser-config
 * guard, which decides what a persisted preference may point the browser at. The guard cannot import
 * it from the policy — the policy already imports the guard's URL vetting, and a cycle between the
 * two files is not worth the convenience.
 */
import { isIP } from 'node:net';

export function isPrivateHostname(hostname: string): boolean {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '');
  if (
    host === 'localhost' ||
    host === 'localhost.localdomain' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host === 'home.arpa' ||
    host.endsWith('.home.arpa') ||
    (isIP(host) === 0 && !host.includes('.')) ||
    host === '0.0.0.0' ||
    host === '::' ||
    host === '::1'
  ) {
    return true;
  }

  const ipv4 = parseIpv4(host);
  if (ipv4) {
    const [a, b] = ipv4;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 0) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      (a === 198 && b === 51 && ipv4[2] === 100) ||
      (a === 203 && b === 0 && ipv4[2] === 113) ||
      a >= 224
    );
  }

  // Parse IPv6 structurally. URL canonicalization commonly renders IPv4-mapped addresses in HEX
  // (`::ffff:7f00:1`), so matching only a dotted tail lets loopback/RFC1918 destinations bypass the
  // literal-IP guard. The byte form also handles compressed and mixed notation consistently.
  const ipv6 = parseIpv6(host);
  if (ipv6) {
    const allZero = ipv6.every((byte) => byte === 0);
    const loopback = ipv6.slice(0, 15).every((byte) => byte === 0) && ipv6[15] === 1;
    const ula = (ipv6[0]! & 0xfe) === 0xfc; // fc00::/7
    const linkOrSiteLocal = ipv6[0] === 0xfe && (ipv6[1]! & 0xc0) >= 0x80; // fe80::/10 + fec0::/10
    const multicast = ipv6[0] === 0xff; // ff00::/8
    const discardOnly = ipv6[0] === 0x01 && ipv6.slice(1, 8).every((byte) => byte === 0); // 100::/64
    const documentation =
      ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x0d && ipv6[3] === 0xb8;
    const teredo = ipv6[0] === 0x20 && ipv6[1] === 0x01 && ipv6[2] === 0x00 && ipv6[3] === 0x00; // 2001::/32
    const localNat64 =
      ipv6[0] === 0x00 &&
      ipv6[1] === 0x64 &&
      ipv6[2] === 0xff &&
      ipv6[3] === 0x9b &&
      ipv6[4] === 0x00 &&
      ipv6[5] === 0x01; // 64:ff9b:1::/48
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
    )
      return true;

    const embeddedIpv4 = (offset: number): boolean =>
      isPrivateIpv4([ipv6[offset]!, ipv6[offset + 1]!, ipv6[offset + 2]!, ipv6[offset + 3]!]);
    const firstTenZero = ipv6.slice(0, 10).every((byte) => byte === 0);
    const mapped = firstTenZero && ipv6[10] === 0xff && ipv6[11] === 0xff;
    const compatible = ipv6.slice(0, 12).every((byte) => byte === 0);
    if ((mapped || compatible) && embeddedIpv4(12)) return true;

    // Well-known NAT64 and 6to4 forms embed an IPv4 destination. Refuse private embedded targets too;
    // otherwise a textual public-looking IPv6 literal can still route to a local IPv4 service.
    const nat64 =
      ipv6[0] === 0x00 &&
      ipv6[1] === 0x64 &&
      ipv6[2] === 0xff &&
      ipv6[3] === 0x9b &&
      ipv6.slice(4, 12).every((byte) => byte === 0);
    if (nat64 && embeddedIpv4(12)) return true;
    const sixToFour = ipv6[0] === 0x20 && ipv6[1] === 0x02;
    if (sixToFour && embeddedIpv4(2)) return true;
  }
  return false;
}

/** Parse every RFC 4291 compressed/mixed IPv6 spelling into network-order bytes. */
function parseIpv6(value: string): Uint8Array | undefined {
  let address = value.toLowerCase().split('%', 1)[0] ?? '';
  if (!address.includes(':')) return undefined;

  // Convert a mixed dotted tail (`::ffff:127.0.0.1`) into two ordinary hextets first.
  const dotted = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/.exec(address);
  if (dotted) {
    const bytes = parseIpv4(dotted[1]!);
    if (!bytes) return undefined;
    const replacement = `${((bytes[0]! << 8) | bytes[1]!).toString(16)}:${(
      (bytes[2]! << 8) |
      bytes[3]!
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

function isPrivateIpv4(bytes: ArrayLike<number>): boolean {
  const a = bytes[0]!;
  const b = bytes[1]!;
  const c = bytes[2]!;
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
}

function parseIpv4(host: string): [number, number, number, number] | undefined {
  const parts = host.split('.');
  if (parts.length !== 4) return undefined;
  const values = parts.map((part) => (/^\d+$/.test(part) ? Number(part) : Number.NaN));
  if (values.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return undefined;
  return values as [number, number, number, number];
}
