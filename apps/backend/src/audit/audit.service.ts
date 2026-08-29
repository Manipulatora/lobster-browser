import { BadRequestException, ForbiddenException, Inject, Injectable } from '@nestjs/common';
import type { AuditLog } from '@lobster/shared-types';

import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { resolveTeamId } from '../teams/resolve-team-id';
import { AUDIT_REPOSITORY, type AuditCursor, type AuditRepository } from './audit.repository';

/**
 * Encode a row's keyset cursor for the `before` query param: an opaque base64url token of
 * `createdAt|id`. A client pages back by passing the LAST row's cursor. Carrying the id (not just
 * the timestamp) is what makes pagination lossless across same-millisecond entries.
 */
export function encodeAuditCursor(row: { createdAt: string; id: string }): string {
  return Buffer.from(`${row.createdAt}|${row.id}`, 'utf8').toString('base64url');
}

/**
 * Input for {@link AuditService.record}. This is the stable contract OTHER feature modules call
 * to write history (they resolve the team themselves, then hand it here). Keep this shape exact.
 */
export interface RecordAuditInput {
  teamId: string;
  /** The user who performed the action; omitted for system-originated events. */
  actorUserId?: string;
  action: string;
  targetType: string;
  targetId?: string;
  metadata?: Record<string, unknown>;
}

/** Options for {@link AuditService.list}, parsed from the request query. */
export interface ListAuditInput {
  teamId?: string;
  limit?: number;
  before?: string;
}

/** Default page size for {@link AuditService.list} when the caller omits `limit`. */
export const DEFAULT_AUDIT_LIMIT = 50;

/** Hard cap on the page size for {@link AuditService.list}, regardless of the requested `limit`. */
export const MAX_AUDIT_LIMIT = 200;

/**
 * Immutable action/audit log.
 *
 * Two responsibilities:
 *   - {@link record} — called by OTHER modules to append history. It is deliberately fail-safe:
 *     a failed audit write must NEVER break the primary business operation, so the repo write is
 *     wrapped in try/catch and any error is swallowed. This method never throws.
 *   - {@link list} — the team-scoped, newest-first, cursor-paginated read behind `GET /audit`.
 *
 * Storage is abstracted behind `AuditRepository` (in-memory today, Prisma once Postgres is
 * provisioned), so this service runs and is tested without a database.
 */
@Injectable()
export class AuditService {
  constructor(
    @Inject(AUDIT_REPOSITORY) private readonly audit: AuditRepository,
    @Inject(TEAMS_REPOSITORY) private readonly teams: TeamsRepository,
  ) {}

  /**
   * Append one audit entry for a team. Fail-safe by design: any repository error is caught and
   * swallowed so an audit-write failure can never fail the caller's primary operation. Returns
   * `void` and never throws — callers fire-and-forget (typically `await`ed, but non-critical).
   */
  async record(input: RecordAuditInput): Promise<void> {
    try {
      await this.audit.record({
        teamId: input.teamId,
        actorUserId: input.actorUserId,
        action: input.action,
        targetType: input.targetType,
        targetId: input.targetId,
        metadata: input.metadata,
      });
    } catch {
      // Intentionally swallowed: a failed audit write must never break the primary business
      // operation. There is nothing to recover here — the entry is simply not recorded.
    }
  }

  /**
   * A team's audit feed, newest first, cursor-paginated. The team is resolved from the caller's
   * membership (an explicit `teamId` they belong to, else their first team). `limit` is clamped
   * to [1, {@link MAX_AUDIT_LIMIT}] (default {@link DEFAULT_AUDIT_LIMIT}); `before` is an ISO
   * timestamp cursor — only entries strictly older than it are returned.
   */
  async list(userId: string, opts: ListAuditInput): Promise<AuditLog[]> {
    const teamId = await resolveTeamId(this.teams, userId, opts.teamId);
    const limit = this.clampLimit(opts.limit);
    const before = this.decodeCursor(opts.before);
    return this.audit.listByTeam(teamId, before ? { limit, before } : { limit });
  }

  /** Clamp a requested page size to a sane bound; fall back to the default when absent/invalid. */
  private clampLimit(limit?: number): number {
    if (limit === undefined || !Number.isFinite(limit) || limit <= 0) {
      return DEFAULT_AUDIT_LIMIT;
    }
    return Math.min(Math.floor(limit), MAX_AUDIT_LIMIT);
  }

  /**
   * Decode the opaque `before` cursor (base64url of `createdAt|id`, produced by
   * {@link encodeAuditCursor}) into a structured {@link AuditCursor}. A malformed cursor is a
   * client error (400) rather than a silent wrong-page or a 500 in the repository.
   */
  private decodeCursor(before?: string): AuditCursor | undefined {
    if (before === undefined || before === '') {
      return undefined;
    }
    const decoded = Buffer.from(before, 'base64url').toString('utf8');
    const sep = decoded.indexOf('|');
    const createdAt = sep >= 0 ? decoded.slice(0, sep) : '';
    const id = sep >= 0 ? decoded.slice(sep + 1) : '';
    if (id === '' || Number.isNaN(Date.parse(createdAt))) {
      throw new BadRequestException('invalid audit cursor');
    }
    return { createdAt, id };
  }
}
