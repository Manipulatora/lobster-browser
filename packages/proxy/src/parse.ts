import { randomUUID } from 'node:crypto';
import type { ProxyConfig, ProxyType } from '@lobster/shared-types';

function schemeToType(scheme: string): ProxyType {
  const s = scheme.toLowerCase();
  if (s === 'socks5' || s === 'socks' || s === 'socks5h') return 'socks5';
  if (s === 'https') return 'https';
  return 'http';
}

/**
 * Parse the proxy formats users paste, into a normalized {@link ProxyConfig}:
 *   - URL form:   `socks5://user:pass@host:port`, `http://host:port`
 *   - colon form: `host:port:user:pass`, `host:port`
 */
export function parseProxy(input: string, id: string = randomUUID()): ProxyConfig {
  const raw = input.trim();
  if (raw === '') throw new Error('parseProxy: empty proxy string');

  if (raw.includes('://')) {
    const url = new URL(raw);
    const port = Number(url.port);
    if (!Number.isInteger(port) || port <= 0) {
      throw new Error(`parseProxy: invalid port in "${raw}"`);
    }
    const config: ProxyConfig = {
      id,
      type: schemeToType(url.protocol.replace(':', '')),
      host: url.hostname,
      port,
    };
    if (url.username) config.username = decodeURIComponent(url.username);
    if (url.password) config.password = decodeURIComponent(url.password);
    return config;
  }

  // colon form: host:port[:user:pass]
  const parts = raw.split(':');
  const host = parts[0];
  const portStr = parts[1];
  if (host === undefined || portStr === undefined) {
    throw new Error(`parseProxy: expected host:port in "${raw}"`);
  }
  const port = Number(portStr);
  if (!Number.isInteger(port) || port <= 0) {
    throw new Error(`parseProxy: invalid port in "${raw}"`);
  }
  const config: ProxyConfig = { id, type: 'http', host, port };
  if (parts[2] !== undefined) config.username = parts[2];
  if (parts[3] !== undefined) config.password = parts[3];
  return config;
}

/** Format a config back into a URL (credentials percent-encoded). */
export function formatProxyUrl(p: ProxyConfig): string {
  const auth =
    p.username !== undefined
      ? `${encodeURIComponent(p.username)}${p.password !== undefined ? ':' + encodeURIComponent(p.password) : ''}@`
      : '';
  return `${p.type}://${auth}${p.host}:${p.port}`;
}

/** Shape Playwright/patchright expect for a per-context proxy. */
export function toEnginePlaywrightProxy(p: ProxyConfig): {
  server: string;
  username?: string;
  password?: string;
} {
  const result: { server: string; username?: string; password?: string } = {
    server: `${p.type}://${p.host}:${p.port}`,
  };
  if (p.username !== undefined) result.username = p.username;
  if (p.password !== undefined) result.password = p.password;
  return result;
}
