export type ProxyType = 'http' | 'https' | 'socks5';

export interface ProxyConfig {
  id: string;
  type: ProxyType;
  host: string;
  port: number;
  username?: string;
  password?: string;
  /** Optional human label. */
  label?: string;
}

/** Geo/network facts derived from a proxy's exit IP — the coherence source of truth. */
export interface GeoInfo {
  ip: string;
  countryCode: string;
  region?: string;
  city?: string;
  timezone: string;
  latitude?: number;
  longitude?: number;
  /** Autonomous System number of the exit IP (residential/mobile ASN preferred). */
  asn?: string;
  /** Whether the exit IP looks like a datacenter (a quality warning to surface). */
  isDatacenter?: boolean;
}

export interface ProxyTestResult {
  ok: boolean;
  latencyMs?: number;
  geo?: GeoInfo;
  error?: string;
}
