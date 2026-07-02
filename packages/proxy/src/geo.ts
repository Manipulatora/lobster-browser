import type { GeoInfo, ProxyConfig } from '@lobster/shared-types';

/**
 * Resolves the geo facts of a proxy's exit IP. The Day 3 networked implementation routes an
 * IP lookup THROUGH the proxy (so we learn the real exit geo, not the local machine's) and
 * feeds the result into fingerprint coherence.
 */
export interface GeoProvider {
  deriveGeoFromExitIp(proxy: ProxyConfig): Promise<GeoInfo>;
}

/**
 * A deterministic, offline provider for tests and Day 0 wiring — returns whatever GeoInfo it
 * was constructed with, ignoring the proxy. Swap for the networked provider in Day 3.
 */
export class StaticGeoProvider implements GeoProvider {
  constructor(private readonly geo: GeoInfo) {}

  deriveGeoFromExitIp(_proxy: ProxyConfig): Promise<GeoInfo> {
    return Promise.resolve(this.geo);
  }
}
