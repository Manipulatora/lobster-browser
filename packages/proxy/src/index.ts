/**
 * @lobster/proxy — parse/format proxies and derive geo facts from the exit IP.
 *
 * The geo derivation (`deriveGeoFromExitIp`) is the coherence source of truth: its result
 * feeds `applyGeoToFingerprint` so timezone/locale/language always match the proxy.
 * Day 0 ships parsing + the provider contract; Day 3 adds the networked implementation.
 */
export { parseProxy, formatProxyUrl, toEnginePlaywrightProxy } from './parse.js';
export type { GeoProvider, DeriveGeoOptions } from './geo.js';
export {
  StaticGeoProvider,
  HttpGeoProvider,
  deriveGeoFromExitIp,
  parseGeoResponse,
  testProxy,
  DEFAULT_GEO_ENDPOINT,
  DEFAULT_GEO_TIMEOUT_MS,
} from './geo.js';
