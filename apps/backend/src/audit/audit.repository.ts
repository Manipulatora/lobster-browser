import type { AuditLog } from '@lobster/shared-types';

/**
 * Fields required to append one audit-log entry. The repository owns `id` and the `createdAt`
 * timestamp (an audit entry's creation time is authoritative — the caller never supplies it).
 * This is exactly the payload `AuditService.record` forwards from the calling module.
 */
export interface CreateAuditLogRecord {
  teamId: string;
  /** The user who performed the action; omitted for system-originated events. */
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/**
 * A **keyset cursor** over the `(createdAt DESC, id DESC)` ordering. It carries BOTH the timestamp
 * and the id so entries sharing the same `createdAt` millisecond can never be skipped — a
 * timestamp-only cursor (`createdAt < before`) silently drops the boundary-millisecond siblings that
 * weren't on the current page, which for an append-only compliance log is a data-integrity bug.
 */
export interface AuditCursor {
  createdAt: string;
  id: string;
}

/**
 * Options for a newest-first, cursor-paginated read of a team's audit feed.
 *
 * `limit` is the (already-clamped) maximum number of rows to return; the service applies the
 * default/cap before calling. `before` is the exclusive keyset cursor: only entries strictly older
 * than it (in `(createdAt, id)` order) are returned. The service decodes the opaque cursor token
 * from the request into this structured form.
 */
export interface ListAuditLogOptions {
  limit: number;
  before?: AuditCursor;
}

/**
 * Persistence boundary for the audit log. AuditService depends on this interface via the
 * `AUDIT_REPOSITORY` DI token. EVERY read is scoped by `teamId` so one team can never see
 * another team's history. The log is append-only: there is deliberately no update or delete.
 *
 * Implementations:
 *   - InMemoryAuditRepository — a Map; the active provider until Postgres is available.
 *   - PrismaAuditRepository   — production persistence via the generated Prisma client.
 */
export interface AuditRepository {
  /** Append one entry and return the persisted row (with its generated id + createdAt). */
  record(entry: CreateAuditLogRecord): Promise<AuditLog>;
  /** A team's entries, newest first, filtered by the optional `before` cursor and capped by `limit`. */
  listByTeam(teamId: string, opts: ListAuditLogOptions): Promise<AuditLog[]>;
}

/**
 * Nest DI token for the active `AuditRepository`. Using a token (not a class) lets us bind the
 * interface to different implementations from the module without callers caring.
 */
export const AUDIT_REPOSITORY = Symbol('AuditRepository');
