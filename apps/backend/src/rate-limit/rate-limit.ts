import { Logger } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';

import type { JwtPayload } from '../auth/auth.service';
import { err } from '../common/api-response';

/**
 * Per-route rate limiting.
 *
 * WHAT ONE BUCKET COST. Until 2026-09-02 the API had a single 120 req/min bucket per IP across
 * every route. The desktop reconciles every profile once a minute, a restore is one pull per
 * profile, presence refreshes a lease per running profile, and a Lobee run is 10–20 model steps a
 * minute — all from the same address, all against the same counter. A user with thirty profiles
 * who started an agent run saw sync fail with 429 and the run die mid-task, and an office behind
 * one NAT shared that fate five ways, sign-in included. Meanwhile the one surface the limit exists
 * for — credential guessing — needs a far SMALLER budget than the one those flows had pushed it to.
 *
 * So routes are sorted into classes with their own budgets, and a budget is spent by the PRINCIPAL
 * wherever one is known: a team for the agent proxy, a user for everything they are signed in to,
 * and the address only for anonymous traffic. Two users behind one NAT no longer share anything,
 * and one runaway client cannot exhaust anyone's budget but its own.
 *
 * IN-PROCESS, BY DESIGN, BEHIND A STORE INTERFACE. Counters live in {@link MemoryRateLimitStore};
 * a second backend instance therefore has its own, which doubles the effective ceiling rather than
 * enforcing it. That is acceptable for a one-box deployment and is exactly the seam
 * {@link RateLimitStore} exists for: a shared store (Redis) swaps in at one construction site in
 * `main.ts`, and nothing here changes. nginx keeps its own edge zones on the auth and billing routes
 * (`deploy/nginx/lobster-limits.conf`) — those stop a flood before Node spends a bcrypt on it, and
 * these limits are the backstop for what gets through, and for deployments without the edge.
 */

/** The budget a request is counted against. `exempt` is never counted. */
export type RateLimitClass = 'auth' | 'sync' | 'leases' | 'agent' | 'general' | 'exempt';

/** Who spends a class's budget: the address alone, or the verified principal when there is one. */
export type RateLimitSubject = 'ip' | 'principal';

export interface RateLimitPolicy {
  /** Requests allowed per window, per subject. */
  limit: number;
  windowMs: number;
  key: RateLimitSubject;
}

export type RateLimitPolicies = Record<Exclude<RateLimitClass, 'exempt'>, RateLimitPolicy>;

/**
 * The defaults, per minute. Sized from the traffic each class actually carries, not from the
 * abuse it might see — the abuse case is the auth class, and it is the only strict one.
 *
 * - auth: the credential-guessing surface (sign-in, registration, the verification codes, the
 *   desktop handoff), always per address — a principal on these routes is either absent or not
 *   the thing being attacked. 30 matches what nginx's zone admits in its first minute (20 r/m plus
 *   a burst of 10), so in production the edge answers first and this only backstops it.
 * - sync: the profile API. A restore is one pull per profile in one reconcile tick, so the budget
 *   has to hold a large account's whole restore, and pulls are the heaviest request the API serves.
 * - leases: presence. One refresh per running profile per minute plus a bulk read every 20 s —
 *   frequent, cheap, indexed writes, so the ceiling only has to catch a runaway client.
 * - agent: model steps, spent per TEAM. Several concurrent Lobee runs at 10–20 steps a minute each
 *   have to fit; a loop that hammers the proxy at 100 req/s still does not.
 * - general: everything else — teams, billing reads, API keys, the vault key, the agent-token mint.
 */
export const RATE_LIMIT_DEFAULTS: Readonly<
  Record<Exclude<RateLimitClass, 'exempt'>, { limit: number; key: RateLimitSubject }>
> = {
  auth: { limit: 30, key: 'ip' },
  sync: { limit: 240, key: 'principal' },
  leases: { limit: 300, key: 'principal' },
  agent: { limit: 600, key: 'principal' },
  general: { limit: 300, key: 'principal' },
};

export const DEFAULT_RATE_LIMIT_WINDOW_MS = 60_000;

/** The environment variable that overrides one class's budget. `RATE_LIMIT_MAX` is honoured for `general` only. */
export const RATE_LIMIT_ENV: Readonly<Record<Exclude<RateLimitClass, 'exempt'>, string>> = {
  auth: 'RATE_LIMIT_AUTH_MAX',
  sync: 'RATE_LIMIT_SYNC_MAX',
  leases: 'RATE_LIMIT_LEASES_MAX',
  agent: 'RATE_LIMIT_AGENT_MAX',
  general: 'RATE_LIMIT_GENERAL_MAX',
};

/**
 * Sort one request into its budget. Pure, so the table above can be tested as a table.
 *
 * Matched on the path as Express will route it: decoded and lowercased, because Express routes
 * case-insensitively by default and `/AUTH/LOGIN` reaches the same handler as `/auth/login` — a
 * classifier that did not see that would let a case change move a login flood into a laxer class.
 */
export function classifyRoute(method: string, rawPath: string): RateLimitClass {
  // A CORS preflight is answered by the CORS layer and never reaches a handler; counting it would
  // charge every dashboard call twice.
  if (method.toUpperCase() === 'OPTIONS') return 'exempt';
  const path = normalisePath(rawPath);
  // systemd and nginx poll these every few seconds; they are the one thing that must keep
  // answering while everything else is being throttled.
  if (path === '/health' || path.startsWith('/health/')) return 'exempt';
  if (path === '/auth' || path.startsWith('/auth/')) {
    // `GET /auth/me` is the session check every dashboard load makes; it verifies a token, not a
    // password, so it belongs with the signed-in traffic rather than the guessing surface.
    return method.toUpperCase() === 'GET' && path === '/auth/me' ? 'general' : 'auth';
  }
  if (path === '/leases' || path.startsWith('/leases/')) return 'leases';
  if (/^\/profiles\/[^/]+\/lease(\/|$)/.test(path)) return 'leases';
  if (path === '/profiles' || path.startsWith('/profiles/')) return 'sync';
  if (path === '/agent/llm' || path.startsWith('/agent/llm/')) return 'agent';
  return 'general';
}

function normalisePath(rawPath: string): string {
  let path = rawPath;
  try {
    path = decodeURIComponent(rawPath);
  } catch {
    // Malformed escapes route to a 400 downstream; classify what was sent.
  }
  path = path.toLowerCase().replace(/\/{2,}/g, '/');
  return path.length > 1 ? path.replace(/\/+$/, '') : path;
}

/**
 * Budgets from the environment, with every value clamped so a typo degrades to the default rather
 * than to no limit at all.
 */
export function resolveRateLimitPolicies(
  env: Record<string, string | undefined> = process.env,
): RateLimitPolicies {
  const windowMs = clampInt(
    env.RATE_LIMIT_WINDOW_MS,
    DEFAULT_RATE_LIMIT_WINDOW_MS,
    1_000,
    3_600_000,
  );
  const policy = (cls: Exclude<RateLimitClass, 'exempt'>): RateLimitPolicy => {
    const defaults = RATE_LIMIT_DEFAULTS[cls];
    // The pre-2026-09-02 single knob keeps meaning something — the catch-all budget — so an
    // operator's existing override is not silently discarded.
    const raw = env[RATE_LIMIT_ENV[cls]] ?? (cls === 'general' ? env.RATE_LIMIT_MAX : undefined);
    return { limit: clampInt(raw, defaults.limit, 1, 1_000_000), windowMs, key: defaults.key };
  };
  return {
    auth: policy('auth'),
    sync: policy('sync'),
    leases: policy('leases'),
    agent: policy('agent'),
    general: policy('general'),
  };
}

function clampInt(value: string | undefined, fallback: number, min: number, max: number): number {
  if (value === undefined || value.trim() === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/** One counted request: how many the window has seen, and when it ends (epoch ms). */
export interface RateLimitHit {
  count: number;
  resetAt: number;
}

/**
 * Where the counters live. Increment-and-read in ONE call, for the same reason the wallet's
 * `move` is one call: a read followed by a write lets two concurrent requests both see the
 * last-allowed count and both pass. A shared implementation (Redis `INCR` + `PEXPIRE`) satisfies
 * this interface without touching the middleware.
 */
export interface RateLimitStore {
  hit(key: string, windowMs: number, now: number): Promise<RateLimitHit>;
}

/** How often expired windows are swept out of the map — bounded so the sweep is not per request. */
const SWEEP_INTERVAL_MS = 60_000;

/**
 * Fixed windows in a Map. The window starts on the first hit and every hit until `resetAt` counts
 * against it; a burst can therefore straddle a boundary and briefly see up to twice the limit,
 * which is the usual fixed-window trade and fine for budgets whose job is to catch runaways.
 *
 * No timers: expired entries are swept lazily on the next hit after {@link SWEEP_INTERVAL_MS}, so
 * the store holds nothing open and a test can construct one freely.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  private readonly windows = new Map<string, RateLimitHit>();
  private nextSweepAt = 0;

  async hit(key: string, windowMs: number, now: number): Promise<RateLimitHit> {
    this.sweep(now);
    const current = this.windows.get(key);
    if (current && current.resetAt > now) {
      current.count += 1;
      return { ...current };
    }
    const fresh: RateLimitHit = { count: 1, resetAt: now + windowMs };
    this.windows.set(key, fresh);
    return { ...fresh };
  }

  /** Live windows, for tests and for a future metrics surface. */
  get size(): number {
    return this.windows.size;
  }

  private sweep(now: number): void {
    if (now < this.nextSweepAt) return;
    this.nextSweepAt = now + SWEEP_INTERVAL_MS;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
  }
}

/**
 * The verified principal behind a bearer token, as a bucket subject, or undefined for anonymous
 * and unverifiable requests.
 *
 * VERIFIED, NOT DECODED. The middleware runs before any guard, so the token has not been checked
 * yet when the key is chosen. Reading the claims without checking the signature would let anyone
 * who knows a team id forge a token naming it and spend that team's whole agent budget from the
 * outside — a denial of service on the one endpoint whose budget is per team precisely so that
 * nobody else can touch it. The guard verifies again a moment later; an HMAC check costs
 * microseconds and buys a key that cannot be chosen by the caller.
 *
 * An `agent`-audience token keys on its team: the wallet is per team, and a team's runs sharing a
 * budget is the intent. Anything else keys on the user.
 */
export function principalFromBearer(
  verify: (token: string) => JwtPayload,
): (req: Request) => string | undefined {
  return (req) => {
    const header = req.headers.authorization;
    if (typeof header !== 'string') return undefined;
    const [scheme, token] = header.split(' ');
    if (scheme !== 'Bearer' || !token) return undefined;
    try {
      const payload = verify(token);
      if (payload.aud === 'agent') return payload.teamId ? `team:${payload.teamId}` : undefined;
      return payload.sub ? `user:${payload.sub}` : undefined;
    } catch {
      return undefined;
    }
  };
}

/**
 * The address a per-IP budget is keyed on.
 *
 * IPv6 is bucketed by its /64: a residential or hosting allocation is at least that wide, so a
 * per-address key would hand an attacker 2^64 fresh buckets for the price of one. An IPv4-mapped
 * address (`::ffff:1.2.3.4`, what a dual-stack socket reports) is keyed as the IPv4 it is.
 */
export function ipBucket(ip: string | undefined): string {
  if (!ip) return 'unknown';
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
  if (mapped) return mapped[1];
  if (!ip.includes(':')) return ip;
  return expandIpv6(ip).slice(0, 4).join(':');
}

/** The eight hextets of an IPv6 address, `::` expanded. Lenient: garbage yields garbage, not a throw. */
function expandIpv6(ip: string): string[] {
  const zone = ip.indexOf('%');
  const bare = zone === -1 ? ip : ip.slice(0, zone);
  const [head, tail = ''] = bare.split('::');
  const left = head ? head.split(':') : [];
  const right = tail ? tail.split(':') : [];
  const missing = Math.max(0, 8 - left.length - right.length);
  return [...left, ...Array<string>(missing).fill('0'), ...right].map((hextet) =>
    hextet.toLowerCase().replace(/^0+(?=.)/, ''),
  );
}

export interface RateLimitMiddlewareOptions {
  policies: RateLimitPolicies;
  store: RateLimitStore;
  /** The verified principal behind the request, or undefined to fall back to the address. */
  principalOf: (req: Request) => string | undefined;
  /** Wall clock, for tests that need to move it. */
  now?: () => number;
  logger?: Pick<Logger, 'warn'>;
}

/** How often a failing store is complained about — once a minute, not once a request. */
const STORE_FAULT_LOG_INTERVAL_MS = 60_000;

/**
 * The Express middleware: classify, key, count, and answer 429 in the API's own envelope.
 *
 * WHY THE ENVELOPE. The previous limiter answered with the library's plain-text default, the only
 * response in the product that was not `{ code, data, msg }` — so the desktop printed it as
 * `sync failed: HTTP 429 Too many requests` and could not tell it from an outage. `Retry-After`
 * and the `RateLimit-*` headers say when to come back; the body says so in the shape every client
 * already parses.
 *
 * FAILS OPEN. A store that cannot be reached (a shared one, later) must not turn into every
 * request being refused: the limiter is protection for the API, not a dependency of it. The fault
 * is logged, at a rate that does not itself become the flood.
 */
export function createRateLimitMiddleware(
  options: RateLimitMiddlewareOptions,
): (req: Request, res: Response, next: NextFunction) => void {
  const now = options.now ?? Date.now;
  const logger = options.logger ?? new Logger('rate-limit');
  let storeFaultLoggedAt = 0;

  return (req, res, next) => {
    const cls = classifyRoute(req.method, req.path);
    if (cls === 'exempt') {
      next();
      return;
    }
    const policy = options.policies[cls];
    const principal = policy.key === 'principal' ? options.principalOf(req) : undefined;
    const subject = principal ?? `ip:${ipBucket(req.ip ?? req.socket?.remoteAddress)}`;
    const at = now();

    void options.store.hit(`${cls}:${subject}`, policy.windowMs, at).then(
      (hit) => {
        const remaining = Math.max(0, policy.limit - hit.count);
        const resetSeconds = Math.max(1, Math.ceil((hit.resetAt - at) / 1000));
        res.setHeader('RateLimit-Limit', String(policy.limit));
        res.setHeader('RateLimit-Remaining', String(remaining));
        res.setHeader('RateLimit-Reset', String(resetSeconds));
        if (hit.count > policy.limit) {
          res.setHeader('Retry-After', String(resetSeconds));
          res
            .status(429)
            .json(
              err(
                `too many requests: the ${cls} limit of ${policy.limit} per ` +
                  `${Math.round(policy.windowMs / 1000)}s is spent; retry in ${resetSeconds}s`,
              ),
            );
          return;
        }
        next();
      },
      (error: unknown) => {
        if (at - storeFaultLoggedAt >= STORE_FAULT_LOG_INTERVAL_MS) {
          storeFaultLoggedAt = at;
          logger.warn(
            `rate-limit store unavailable, admitting requests uncounted: ${String(error)}`,
          );
        }
        next();
      },
    );
  };
}
