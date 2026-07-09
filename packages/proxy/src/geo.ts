import { performance } from 'node:perf_hooks';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { GeoInfo, ProxyConfig, ProxyTestResult } from '@lobster/shared-types';
import { ProxyAgent, request } from 'undici';
import { SocksProxyAgent } from 'socks-proxy-agent';
import { formatProxyUrl } from './parse.js';

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
 * was constructed with, ignoring the proxy. Swap for {@link HttpGeoProvider} in production.
 */
export class StaticGeoProvider implements GeoProvider {
  constructor(private readonly geo: GeoInfo) {}

  deriveGeoFromExitIp(_proxy: ProxyConfig): Promise<GeoInfo> {
    return Promise.resolve(this.geo);
  }
}

/**
 * Default free IP-geo endpoint. We request only the fields we map so the response stays small.
 * `hosting` marks datacenter/cloud ranges; `query` echoes the exit IP as seen by the endpoint.
 */
export const DEFAULT_GEO_ENDPOINT =
  'http://ip-api.com/json/?fields=status,message,countryCode,region,city,timezone,lat,lon,as,hosting,query';

/** Total round-trip budget for a geo lookup (connect + headers + body). */
export const DEFAULT_GEO_TIMEOUT_MS = 10_000;

export interface DeriveGeoOptions {
  /** Override the IP-geo endpoint (must return the ip-api JSON shape). */
  endpoint?: string;
  /** Total timeout for the whole request in milliseconds. */
  timeoutMs?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/**
 * PURE mapping from the ip-api JSON response to our {@link GeoInfo}. Kept side-effect-free and
 * exported so the field mapping is unit-testable without touching the network. Throws with an
 * actionable message when the endpoint reports failure or omits a required field.
 */
export function parseGeoResponse(raw: unknown): GeoInfo {
  if (typeof raw !== 'object' || raw === null) {
    throw new Error('parseGeoResponse: expected a JSON object from the geo endpoint');
  }
  const r = raw as Record<string, unknown>;

  if (r.status !== 'success') {
    const message = asString(r.message) ?? 'unknown error';
    throw new Error(`parseGeoResponse: geo lookup failed: ${message}`);
  }

  const ip = asString(r.query);
  const countryCode = asString(r.countryCode);
  const timezone = asString(r.timezone);
  if (ip === undefined || countryCode === undefined || timezone === undefined) {
    throw new Error(
      'parseGeoResponse: response is missing required fields (query/countryCode/timezone)',
    );
  }

  const geo: GeoInfo = { ip, countryCode, timezone };

  const region = asString(r.region);
  if (region !== undefined) geo.region = region;
  const city = asString(r.city);
  if (city !== undefined) geo.city = city;
  const latitude = asNumber(r.lat);
  if (latitude !== undefined) geo.latitude = latitude;
  const longitude = asNumber(r.lon);
  if (longitude !== undefined) geo.longitude = longitude;
  const asn = asString(r.as);
  if (asn !== undefined) geo.asn = asn;
  // `hosting` is the datacenter/cloud signal — surface it as a quality warning.
  if (typeof r.hosting === 'boolean') geo.isDatacenter = r.hosting;

  return geo;
}

/** Fetch JSON through a SOCKS5 proxy (remote DNS via socks5h) using socks-proxy-agent. */
async function fetchJsonViaSocks(
  endpoint: string,
  proxy: ProxyConfig,
  timeoutMs: number,
): Promise<unknown> {
  // socks5h = resolve DNS on the proxy side (PROX-4 / PROX-7).
  const uri = formatProxyUrl(proxy).replace(/^socks5:\/\//i, 'socks5h://');
  const agent = new SocksProxyAgent(uri);
  const url = new URL(endpoint);
  const transport = url.protocol === 'https:' ? httpsRequest : httpRequest;

  return new Promise((resolve, reject) => {
    const req = transport(
      endpoint,
      {
        method: 'GET',
        agent,
        timeout: timeoutMs,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const status = res.statusCode ?? 0;
          if (status < 200 || status >= 300) {
            reject(new Error(`deriveGeoFromExitIp: geo endpoint returned HTTP ${status}`));
            return;
          }
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')));
          } catch (err) {
            reject(err);
          }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error(`deriveGeoFromExitIp: SOCKS geo lookup timed out after ${timeoutMs}ms`));
    });
    req.end();
  });
}

/**
 * Derive the exit-IP geo by routing an IP-geo lookup THROUGH the proxy.
 *
 * HTTP/HTTPS proxies use undici's {@link ProxyAgent}. SOCKS5 uses `socks-proxy-agent` with
 * socks5h (remote DNS) so locale/tz can match the exit IP on the launch path (PROX-4).
 */
export async function deriveGeoFromExitIp(
  proxy: ProxyConfig,
  opts: DeriveGeoOptions = {},
): Promise<GeoInfo> {
  const endpoint = opts.endpoint ?? DEFAULT_GEO_ENDPOINT;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_GEO_TIMEOUT_MS;

  if (proxy.type === 'socks5') {
    const body = await fetchJsonViaSocks(endpoint, proxy, timeoutMs);
    return parseGeoResponse(body);
  }

  // ProxyAgent parses the userinfo from the URL and sets Proxy-Authorization for us.
  const dispatcher = new ProxyAgent({ uri: formatProxyUrl(proxy) });

  try {
    const res = await request(endpoint, {
      dispatcher,
      method: 'GET',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.statusCode < 200 || res.statusCode >= 300) {
      await res.body.dump();
      throw new Error(`deriveGeoFromExitIp: geo endpoint returned HTTP ${res.statusCode}`);
    }
    const body: unknown = await res.body.json();
    return parseGeoResponse(body);
  } finally {
    await dispatcher.close();
  }
}

/**
 * Networked {@link GeoProvider} — the production counterpart to {@link StaticGeoProvider}.
 * Delegates to {@link deriveGeoFromExitIp} with the configured options.
 */
export class HttpGeoProvider implements GeoProvider {
  constructor(private readonly opts: DeriveGeoOptions = {}) {}

  deriveGeoFromExitIp(proxy: ProxyConfig): Promise<GeoInfo> {
    return deriveGeoFromExitIp(proxy, this.opts);
  }
}

/**
 * Test a proxy end-to-end: measure round-trip latency of the exit-IP lookup and return the
 * derived geo. Never throws — failures come back as `{ ok: false, error }`.
 */
export async function testProxy(
  proxy: ProxyConfig,
  opts: DeriveGeoOptions = {},
): Promise<ProxyTestResult> {
  const start = performance.now();
  try {
    const geo = await deriveGeoFromExitIp(proxy, opts);
    const latencyMs = Math.round(performance.now() - start);
    return { ok: true, latencyMs, geo };
  } catch (error) {
    const latencyMs = Math.round(performance.now() - start);
    return {
      ok: false,
      latencyMs,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
