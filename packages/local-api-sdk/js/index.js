// @ts-check
/**
 * Minimal client for the Lobster local automation API.
 *
 * Usage:
 *   import { LobsterClient } from '@lobster/local-api-sdk';
 *   const client = new LobsterClient({ port: 53211, apiKey: 'lb_...' });
 *   const { ws, debuggerAddress } = await client.start('profile-id');
 *   // Playwright:  await chromium.connectOverCDP(ws)
 *   // Selenium:    options.debuggerAddress = debuggerAddress
 *   await client.stop('profile-id');
 *
 * The full networked implementation is fleshed out on Day 4 alongside the Axum local API.
 */
export class LobsterClient {
  /** @param {{ port?: number, host?: string, apiKey: string }} opts */
  constructor(opts) {
    this.host = opts.host ?? '127.0.0.1';
    this.port = opts.port ?? 53211;
    this.apiKey = opts.apiKey;
  }

  /** @param {string} path @param {unknown} [body] */
  async #call(path, body) {
    const res = await fetch(`http://${this.host}:${this.port}${path}`, {
      method: body ? 'POST' : 'GET',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    const json = await res.json();
    if (json.code !== 0) throw new Error(json.msg || 'lobster local api error');
    return json.data;
  }

  /** @param {string} profileId */
  start(profileId) {
    return this.#call('/api/v1/profile/start', { profileId });
  }

  /** @param {string} profileId */
  stop(profileId) {
    return this.#call('/api/v1/profile/stop', { profileId });
  }

  /** @param {string} profileId */
  status(profileId) {
    return this.#call(`/api/v1/profile/status?profileId=${encodeURIComponent(profileId)}`);
  }

  list() {
    return this.#call('/api/v1/profile/list');
  }
}
