import type { ApiKey } from '@lobster/shared-types';

/**
 * Fields required to persist a new API key. The repository owns `id`, `createdAt`, and
 * `lastUsedAt`. Only non-secret material is stored: the human-visible `prefix` and the
 * `hashedKey` (sha256 hex of the full secret) — never the plaintext secret itself, which the
 * service returns to the caller exactly once at creation and then discards.
 */
export interface CreateApiKeyRecord {
  teamId: string;
  name: string;
  /** Safe-to-display leading slice of the secret, e.g. "lb_live_ab12cd34". */
  prefix: string;
  /** sha256(secret) as hex — the only representation of the secret the server retains. */
  hashedKey: string;
}

/**
 * Internal, server-side representation of a stored API key: the public {@link ApiKey} plus the
 * `hashedKey` used by {@link ApiKeysRepository.findByHash} to authenticate an incoming secret.
 *
 * The repository deals exclusively in these records so `verify()` has the hash available; the
 * SERVICE strips `hashedKey` before any record crosses the HTTP boundary (a client must never see
 * it). Treat `hashedKey` as a secret-equivalent: it must not appear in a response body or a log.
 */
export interface ApiKeyRecord extends ApiKey {
  hashedKey: string;
}

/**
 * Persistence boundary for API keys. ApiKeysService depends on this interface via the
 * `API_KEYS_REPOSITORY` DI token. Team-facing reads/writes (`findAllByTeam`, `findById`,
 * `remove`) are scoped by `teamId` so one team can never see or revoke another team's keys.
 *
 * `findByHash` and `touchLastUsed` are the authentication path (not team-scoped): a presented
 * secret is looked up globally by its hash, then its `lastUsedAt` is stamped.
 *
 * Implementations:
 *   - InMemoryApiKeysRepository — a Map; the active provider until Postgres is available.
 *   - PrismaApiKeysRepository   — production persistence via the generated Prisma client.
 */
export interface ApiKeysRepository {
  create(input: CreateApiKeyRecord): Promise<ApiKeyRecord>;
  findAllByTeam(teamId: string): Promise<ApiKeyRecord[]>;
  findById(teamId: string, id: string): Promise<ApiKeyRecord | null>;
  /** Returns true when a row was deleted, false when nothing matched the (team, id). */
  remove(teamId: string, id: string): Promise<boolean>;
  /** Look a key up by its sha256 hash across ALL teams — the secret-verification path. */
  findByHash(hash: string): Promise<ApiKeyRecord | null>;
  /** Stamp `lastUsedAt = now` for the given key id (best-effort; no-op if it no longer exists). */
  touchLastUsed(id: string): Promise<void>;
}

/**
 * Nest DI token for the active `ApiKeysRepository`. Using a token (not a class) lets us bind the
 * interface to different implementations from the module without callers caring.
 */
export const API_KEYS_REPOSITORY = Symbol('ApiKeysRepository');
