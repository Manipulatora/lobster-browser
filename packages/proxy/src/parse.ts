import { randomUUID } from 'node:crypto';
import type { ProxyConfig, ProxyType } from '@lobster/shared-types';

const MAX_PROXY_PORT = 65_535;

function schemeToType(scheme: string): ProxyType {
  const s = scheme.toLowerCase();
  if (s === 'socks5' || s === 'socks' || s === 'socks5h') return 'socks5';
  if (s === 'https') return 'https';
  if (s === 'http') return 'http';
  throw new Error(`parseProxy: unsupported proxy scheme "${scheme}"`);
}

/** The well-known default port for a scheme when the URL omits one. */
function defaultPortForScheme(scheme: string): number | undefined {
  const s = scheme.toLowerCase();
  if (s === 'https' || s === 'wss') return 443;
  if (s === 'http' || s === 'ws') return 80;
  if (s === 'socks' || s === 'socks5' || s === 'socks5h') return 1080;
  return undefined;
}

/** decodeURIComponent, but fall back to the raw value on malformed input (e.g. a literal '%'). */
function tolerantDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function validatePort(port: number): boolean {
  return Number.isInteger(port) && port > 0 && port <= MAX_PROXY_PORT;
}

function hostForUrl(host: string): string {
  // Programmatic ProxyConfig values may carry an unbracketed IPv6 literal. URL/Chromium syntax needs
  // brackets around it; DNS names and already-bracketed IPv6 literals pass through unchanged.
  return host.includes(':') && !(host.startsWith('[') && host.endsWith(']')) ? `[${host}]` : host;
}

/**
 * Runtime validation for the shared ProxyConfig type. IPC/database JSON is untyped at runtime, so every
 * engine boundary must reject malformed values instead of letting Chromium reinterpret them (or silently
 * fall back to a direct connection).
 */
export function validateProxyConfig(proxy: ProxyConfig): string[] {
  const issues: string[] = [];
  if (!proxy || typeof proxy !== 'object') return ['proxy must be an object'];
  if (!['http', 'https', 'socks5'].includes(proxy.type)) {
    issues.push(`unsupported proxy type "${String(proxy.type)}"`);
  }
  if (typeof proxy.host !== 'string' || proxy.host.trim() === '') {
    issues.push('proxy host is required');
  } else if (/\s|[\u0000-\u001f\u007f]/.test(proxy.host)) {
    issues.push('proxy host contains whitespace/control characters');
  } else {
    try {
      const candidate = new URL(`http://${hostForUrl(proxy.host)}:1`);
      if (!candidate.hostname) issues.push('proxy host is invalid');
    } catch {
      issues.push(`proxy host "${proxy.host}" is invalid`);
    }
  }
  if (!validatePort(proxy.port)) {
    issues.push(`proxy port must be an integer in 1-${MAX_PROXY_PORT}`);
  }
  if (proxy.username !== undefined && typeof proxy.username !== 'string') {
    issues.push('proxy username must be a string');
  }
  if (proxy.password !== undefined && typeof proxy.password !== 'string') {
    issues.push('proxy password must be a string');
  }
  if (proxy.password !== undefined && proxy.username === undefined) {
    issues.push('proxy password cannot be supplied without a username');
  }
  return issues;
}

/** Throw an actionable error when a ProxyConfig is unsafe/invalid at runtime. */
export function assertValidProxyConfig(proxy: ProxyConfig): void {
  const issues = validateProxyConfig(proxy);
  if (issues.length > 0) throw new Error(`invalid proxy config: ${issues.join('; ')}`);
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
    const scheme = url.protocol.replace(':', '');
    const type = schemeToType(scheme);
    // url.port is '' for the scheme's default port (e.g. http://host:80); fall back to it.
    const port = url.port === '' ? defaultPortForScheme(scheme) : Number(url.port);
    if (port === undefined || !validatePort(port)) {
      throw new Error(`parseProxy: invalid port in "${raw}"`);
    }
    if (!url.hostname) throw new Error(`parseProxy: missing host in "${raw}"`);
    if ((url.pathname && url.pathname !== '/') || url.search || url.hash) {
      throw new Error(
        `parseProxy: proxy URL must not contain a path, query, or fragment: "${raw}"`,
      );
    }
    const config: ProxyConfig = {
      id,
      type,
      host: url.hostname,
      port,
    };
    if (url.username) config.username = tolerantDecode(url.username);
    if (url.password) config.password = tolerantDecode(url.password);
    assertValidProxyConfig(config);
    return config;
  }

  // Colon form: host:port[:user:pass]. Bracketed IPv6 is supported; any extra ':' characters after
  // the username belong to the password rather than being silently truncated.
  const match = /^(\[[^\]]+\]|[^:]+):([^:]+)(?::([^:]*)(?::(.*))?)?$/.exec(raw);
  if (!match) {
    throw new Error(`parseProxy: expected host:port in "${raw}"`);
  }
  const host = match[1] as string;
  const portStr = match[2] as string;
  const port = Number(portStr);
  if (!validatePort(port)) {
    throw new Error(`parseProxy: invalid port in "${raw}"`);
  }
  const config: ProxyConfig = { id, type: 'http', host, port };
  if (match[3] !== undefined) config.username = match[3];
  if (match[4] !== undefined) config.password = match[4];
  assertValidProxyConfig(config);
  return config;
}

/** Format a config back into a URL (credentials percent-encoded). */
export function formatProxyUrl(p: ProxyConfig): string {
  assertValidProxyConfig(p);
  const auth =
    p.username !== undefined
      ? `${encodeURIComponent(p.username)}${p.password !== undefined ? ':' + encodeURIComponent(p.password) : ''}@`
      : '';
  return `${p.type}://${auth}${hostForUrl(p.host)}:${p.port}`;
}

/** Shape Playwright/patchright expect for a per-context proxy. */
export function toEnginePlaywrightProxy(p: ProxyConfig): {
  server: string;
  username?: string;
  password?: string;
} {
  assertValidProxyConfig(p);
  const result: { server: string; username?: string; password?: string } = {
    server: `${p.type}://${hostForUrl(p.host)}:${p.port}`,
  };
  if (p.username !== undefined) result.username = p.username;
  if (p.password !== undefined) result.password = p.password;
  return result;
}

/** Validate an explicit provider rotation endpoint. Only absolute HTTP(S) URLs are allowed. */
export function validateProxyRotationUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new Error('proxy rotation URL is required');
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error('proxy rotation URL must be an absolute URL');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new Error('proxy rotation URL must use HTTP or HTTPS');
  }
  if (url.hash) throw new Error('proxy rotation URL must not contain a fragment');
  return url.toString();
}
