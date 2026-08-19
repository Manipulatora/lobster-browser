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

export type ProxySource = 'mine' | 'hive';
/**
 * `untested` is the state a proxy is created in and returns to whenever its endpoint changes: no
 * check has described THIS endpoint yet. It exists because the alternative was storing `warning` on
 * a proxy nobody had asked anything of, which reads as "degraded" everywhere status is coloured.
 * `warning` means the opposite — a check that succeeded and found something worth knowing.
 */
export type StoredProxyStatus = 'untested' | 'ready' | 'warning' | 'testing' | 'error';

export interface StoredProxy {
  id: string;
  source: ProxySource;
  label: string;
  config: ProxyConfig;
  location?: string;
  timezone?: string;
  latencyMs?: number;
  status: StoredProxyStatus;
  rotateUrl?: string;
  lastCheckedAt?: string;
  lastError?: string;
  /** Autonomous System of the last checked exit IP, e.g. "AS15169 Google LLC". */
  asn?: string;
  /** The last check placed the exit IP in a hosting range. */
  isDatacenter?: boolean;
  createdAt: string;
  updatedAt: string;
  /**
   * Fields this machine could not decrypt (`config`, `rotate_url`). A proxy carrying any is missing
   * its credentials in memory, so saving it would overwrite them — the store refuses the write and
   * the UI has to say so rather than presenting an editable, silently-emptied password.
   */
  unreadableSecrets?: string[];
}

export interface CreateStoredProxyInput {
  source: ProxySource;
  label: string;
  config: ProxyConfig;
  location?: string;
  timezone?: string;
  rotateUrl?: string;
}

export type UpdateStoredProxyInput = Partial<
  Pick<
    CreateStoredProxyInput,
    'source' | 'label' | 'config' | 'location' | 'timezone' | 'rotateUrl'
  >
>;

export interface ProxyRotationResult {
  proxyId: string;
  rotatedAt: string;
  status: number;
}
