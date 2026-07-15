// @ts-check
/**
 * @lobster/local-api-sdk — zero-dependency JavaScript client for the Lobster
 * **Local Automation API**.
 *
 * The desktop core (Rust/Axum) exposes a loopback HTTP API — deliberately mirroring the proven
 * AdsPower/Octo contract — so existing automation ports over with near-zero friction. This client
 * is a thin, typed wrapper over that API: it builds the base URL once, attaches the Bearer key,
 * enforces a per-request timeout, retries transient network failures, and unwraps the
 * `{ code, data, msg }` envelope so callers work with plain result objects.
 *
 * Contract: ../../docs/OPERATIONS.md (§4)
 *
 * @example Start a profile and drive it with Playwright.
 *   import { LobsterClient } from '@lobster/local-api-sdk';
 *   import { chromium } from 'playwright';
 *
 *   const client = new LobsterClient({ port: 53211, apiKey: 'lb_...' });
 *   const { ws } = await client.start('my-profile-id');
 *   const browser = await chromium.connectOverCDP(ws);
 *   // ...drive the browser...
 *   await client.stop('my-profile-id');
 *
 * @example Selenium (via debuggerAddress) — see README.md for the full recipe.
 *   const { debuggerAddress } = await client.start('my-profile-id');
 *   // options.debuggerAddress = debuggerAddress
 *
 * Runtime requirements: a global `fetch` (Node >= 18, Deno, Bun, browsers). No npm dependencies.
 *
 * @module
 */

/**
 * `data` returned by `POST /profile/start` — both connect styles, zero friction.
 * Mirrors `@lobster/shared-types` `StartProfileResult`.
 * @typedef {object} StartProfileResult
 * @property {string} profileId
 * @property {string} ws               CDP WebSocket. Playwright/Puppeteer: `connectOverCDP(ws)`.
 * @property {string} debuggerAddress  `host:port`. Selenium: `options.debuggerAddress = this`.
 * @property {string} [webDriver]      WebDriver/automation base HTTP endpoint, when applicable.
 * @property {number} [pid]            OS process id of the launched browser.
 */

/**
 * `data` returned by `POST /profile/stop`.
 * @typedef {object} StopProfileResult
 * @property {string} profileId
 * @property {boolean} stopped
 */

/**
 * `data` returned by `GET /profile/status`. Mirrors `@lobster/shared-types` `ProfileStatusResult`.
 * @typedef {object} ProfileStatusResult
 * @property {string} profileId
 * @property {boolean} running
 * @property {string} [ws]             Present only while the profile is running.
 * @property {string} [debuggerAddress] Present only while the profile is running.
 */

/**
 * One entry of `GET /profile/list`. Mirrors `@lobster/shared-types` `LocalApiListItem`.
 * @typedef {object} LocalApiListItem
 * @property {string} profileId
 * @property {string} name
 * @property {boolean} running
 */

/**
 * `data` returned by `GET /health`.
 * @typedef {object} HealthResult
 * @property {string} status  `"ok"` when the local API is up.
 */

/**
 * Proxy config accepted by `POST /proxy/test`.
 * @typedef {object} ProxyConfig
 * @property {string} id
 * @property {'http' | 'https' | 'socks5'} type
 * @property {string} host
 * @property {number} port
 * @property {string} [username]
 * @property {string} [password]
 * @property {string} [label]
 */

/**
 * `data` returned by `POST /proxy/test`.
 * @typedef {object} ProxyTestResult
 * @property {boolean} ok
 * @property {number} [latencyMs]
 * @property {{ ip: string, countryCode: string, timezone: string, region?: string, city?: string, latitude?: number, longitude?: number, asn?: string, isDatacenter?: boolean }} [geo]
 * @property {string} [error]
 */

/**
 * Connection options for {@link LobsterClient}.
 * @typedef {object} LobsterClientOptions
 * @property {string} [host='127.0.0.1']  Loopback host the desktop core is bound to.
 * @property {number} [port=53211]        Fixed loopback port of the local API.
 * @property {string} [apiKey]            Bearer key. Required by every endpoint except `/health`.
 * @property {number} [timeout=30000]     Per-request timeout in milliseconds (via `AbortController`).
 * @property {number} [retries=2]         Retries on network/timeout errors only (never on an error envelope).
 * @property {number} [retryDelay=250]    Base backoff in ms; grows exponentially (250, 500, ...).
 * @property {typeof fetch} [fetch]       Override the `fetch` implementation (tests, custom agents).
 */

/**
 * Thrown when the API responds but reports failure: a non-zero envelope `code`, a non-2xx HTTP
 * status, or an unparseable body. These are **application** errors — they are never retried, since
 * retrying a deterministic failure just wastes time.
 */
export class LobsterApiError extends Error {
  /**
   * @param {string} endpoint    e.g. `"POST /profile/start"`.
   * @param {string} msg         Human-readable message (usually the envelope `msg`).
   * @param {object} [details]
   * @param {number} [details.code]        The envelope `code`, when present.
   * @param {number} [details.httpStatus]  The HTTP status code, when known.
   */
  constructor(endpoint, msg, { code, httpStatus } = {}) {
    super(`Lobster API error on ${endpoint}: ${msg}`);
    this.name = 'LobsterApiError';
    /** @type {string} */ this.endpoint = endpoint;
    /** @type {string} */ this.msg = msg;
    /** @type {number | undefined} */ this.code = code;
    /** @type {number | undefined} */ this.httpStatus = httpStatus;
  }
}

/**
 * Thrown when the request never produced a usable response — the connection was refused/reset, or
 * it timed out — after all retries were exhausted. These are the failures the client *does* retry.
 */
export class LobsterNetworkError extends Error {
  /**
   * @param {string} endpoint  e.g. `"POST /profile/start"`.
   * @param {string} msg       What went wrong (timeout / transport failure).
   * @param {object} [options]
   * @param {number} [options.attempts]  How many attempts were made before giving up.
   * @param {unknown} [options.cause]    The underlying error (network failure), for debugging.
   */
  constructor(endpoint, msg, { attempts, cause } = {}) {
    super(
      `Lobster API request ${endpoint} failed${attempts ? ` after ${attempts} attempt(s)` : ''}: ${msg}`,
    );
    this.name = 'LobsterNetworkError';
    /** @type {string} */ this.endpoint = endpoint;
    /** @type {string} */ this.msg = msg;
    /** @type {number | undefined} */ this.attempts = attempts;
    if (cause !== undefined) this.cause = cause;
  }
}

/** @param {number} ms */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Typed client for the Lobster Local Automation API.
 *
 * Every method resolves to the unwrapped `data` payload and rejects with a {@link LobsterApiError}
 * (the API reported failure) or {@link LobsterNetworkError} (transport failed after retries).
 */
export class LobsterClient {
  /** @param {LobsterClientOptions} [opts] */
  constructor(opts = {}) {
    const host = opts.host ?? '127.0.0.1';
    const port = opts.port ?? 53211;
    /**
     * The single, canonical base URL — built once so no method has to reassemble it.
     * @type {string}
     */
    this.baseUrl = `http://${host}:${port}/api/v1`;
    /** @type {string | undefined} */
    this.apiKey = opts.apiKey;
    /** @type {number} */
    this.timeout = opts.timeout ?? 30_000;
    /** @type {number} */
    this.retries = opts.retries ?? 2;
    /** @type {number} */
    this.retryDelay = opts.retryDelay ?? 250;
    /** @type {typeof fetch} */
    this.fetch = opts.fetch ?? globalThis.fetch;
    if (typeof this.fetch !== 'function') {
      throw new TypeError(
        'LobsterClient requires a global `fetch` (Node >= 18) or an explicit `fetch` option.',
      );
    }
  }

  // --- Endpoints -------------------------------------------------------------------------------

  /**
   * `GET /health` — liveness probe. **No auth required**, so this works even without an `apiKey`.
   * @returns {Promise<HealthResult>}
   */
  health() {
    return this.#call('GET', '/health');
  }

  /**
   * `POST /profile/start` — launch a profile and return its live CDP endpoints.
   * @param {string} profileId
   * @param {{ headless?: boolean, password?: string }} [opts]  `headless` defaults to `false`.
   * @returns {Promise<StartProfileResult>}
   */
  start(profileId, { headless = false, password } = {}) {
    /** @type {{ profileId: string, headless: boolean, password?: string }} */
    const body = { profileId, headless };
    if (password !== undefined) body.password = password;
    return this.#call('POST', '/profile/start', { body });
  }

  /**
   * `POST /profile/stop` — stop a running profile.
   * @param {string} profileId
   * @returns {Promise<StopProfileResult>}
   */
  stop(profileId) {
    return this.#call('POST', '/profile/stop', { body: { profileId } });
  }

  /**
   * `GET /profile/status` — whether a profile is running (and its endpoints, if so).
   * @param {string} profileId
   * @returns {Promise<ProfileStatusResult>}
   */
  status(profileId) {
    return this.#call('GET', '/profile/status', { query: { profileId } });
  }

  /**
   * `GET /profile/list` — all known profiles and their running state.
   * @returns {Promise<LocalApiListItem[]>}
   */
  list() {
    return this.#call('GET', '/profile/list');
  }

  /**
   * `POST /proxy/test` — test a proxy endpoint and return exit-IP geo/latency.
   * @param {ProxyConfig} config
   * @param {{ id?: string }} [opts]  Pass a stored proxy id to update its local test result.
   * @returns {Promise<ProxyTestResult>}
   */
  testProxy(config, { id } = {}) {
    const body = { config };
    if (id !== undefined) body.id = id;
    return this.#call('POST', '/proxy/test', { body });
  }

  // --- Convenience -----------------------------------------------------------------------------

  /**
   * Start a profile and return just the two endpoints an automation framework needs. Deliberately
   * does **not** import Playwright/Puppeteer — pass `ws` to `chromium.connectOverCDP(ws)` /
   * `puppeteer.connect({ browserWSEndpoint: ws })`, or `debuggerAddress` to Selenium yourself.
   * @param {string} profileId
   * @param {{ headless?: boolean, password?: string }} [opts]
   * @returns {Promise<{ ws: string, debuggerAddress: string }>}
   */
  async connectPlaywright(profileId, opts) {
    const { ws, debuggerAddress } = await this.start(profileId, opts);
    return { ws, debuggerAddress };
  }

  // --- Internals -------------------------------------------------------------------------------

  /**
   * Perform a request with timeout + retry, then unwrap the `{ code, data, msg }` envelope.
   *
   * Retries apply **only** to {@link LobsterNetworkError} (connection/timeout). A
   * {@link LobsterApiError} — a non-zero envelope or a bad HTTP response — is deterministic and
   * propagates on the first attempt without retry.
   *
   * @template T
   * @param {'GET' | 'POST'} method
   * @param {string} endpoint  Path under the base URL, e.g. `/profile/start`.
   * @param {{ body?: unknown, query?: Record<string, string> }} [options]
   * @returns {Promise<T>}
   */
  async #call(method, endpoint, { body, query } = {}) {
    const route = `${method} ${endpoint}`;
    let url = this.baseUrl + endpoint;
    if (query) url += `?${new URLSearchParams(query).toString()}`;

    let lastError;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      try {
        return await this.#attempt(method, url, route, body);
      } catch (err) {
        // Application errors are final — never retry a deterministic failure.
        if (err instanceof LobsterApiError) throw err;
        // Transport/timeout: remember it and back off before the next attempt.
        lastError = err;
        if (attempt < this.retries) {
          await sleep(this.retryDelay * 2 ** attempt);
        }
      }
    }
    throw new LobsterNetworkError(
      route,
      lastError instanceof Error ? lastError.message : String(lastError),
      { attempts: this.retries + 1, cause: lastError },
    );
  }

  /**
   * A single HTTP attempt: send the request under an `AbortController` timeout, then parse and
   * validate the envelope. Throws {@link LobsterNetworkError} for transport/timeout failures
   * (which {@link #call} may retry) and {@link LobsterApiError} for a reported/HTTP failure.
   *
   * @param {'GET' | 'POST'} method
   * @param {string} url
   * @param {string} route
   * @param {unknown} body
   * @returns {Promise<any>}
   */
  async #attempt(method, url, route, body) {
    /** @type {Record<string, string>} */
    const headers = { accept: 'application/json' };
    if (this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';

    // AbortController drives the per-request timeout; we track `timedOut` so a timeout reads as
    // "timed out" rather than a generic abort.
    const controller = new AbortController();
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, this.timeout);

    /** @type {Response} */ let res;
    /** @type {string} */ let text;
    try {
      res = await this.fetch(url, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
      text = await res.text();
    } catch (err) {
      // `fetch` rejects here only for transport-level failures (connection refused/reset) or an
      // abort. Both are transient → surface a retryable network error.
      throw new LobsterNetworkError(
        route,
        timedOut
          ? `timed out after ${this.timeout}ms`
          : err instanceof Error
            ? err.message
            : String(err),
        { cause: err },
      );
    } finally {
      clearTimeout(timer);
    }

    // From here on the server answered; any failure is deterministic (non-retryable).
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      throw new LobsterApiError(route, `non-JSON response body (HTTP ${res.status})`, {
        httpStatus: res.status,
      });
    }
    if (typeof json.code !== 'number') {
      throw new LobsterApiError(route, `malformed envelope (HTTP ${res.status})`, {
        httpStatus: res.status,
      });
    }
    if (json.code !== 0) {
      throw new LobsterApiError(route, json.msg || 'unknown error', {
        code: json.code,
        httpStatus: res.status,
      });
    }
    return json.data;
  }
}

export default LobsterClient;
