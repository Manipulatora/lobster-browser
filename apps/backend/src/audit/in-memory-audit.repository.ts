import { randomUUID } from 'node:crypto';

import { Injectable } from '@nestjs/common';
import type { AuditLog } from '@lobster/shared-types';

import type {
  AuditRepository,
  CreateAuditLogRecord,
  ListAuditLogOptions,
} from './audit.repository';

/**
 * In-memory `AuditRepository` backed by a Map. The active implementation until a Postgres
 * instance is provisioned — it lets the audit log run (and be tested) with no DB. State lives
 * for the lifetime of the process only; it is intentionally NOT durable.
 *
 * Like every implementation it is append-only: `record` inserts, `listByTeam` reads, and there
 * is no mutation or deletion path.
 */
@Injectable()
export class InMemoryAuditRepository implements AuditRepository {
  private readonly byId = new Map<string, AuditLog>();

  async record(entry: CreateAuditLogRecord): Promise<AuditLog> {
    const log: AuditLog = {
      id: randomUUID(),
      teamId: entry.teamId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      targetType: entry.targetType,
      targetId: entry.targetId,
      metadata: entry.metadata,
      createdAt: new Date().toISOString(),
    };
    this.byId.set(log.id, log);
    return log;
  }

  async listByTeam(teamId: string, { limit, before }: ListAuditLogOptions): Promise<AuditLog[]> {
    let rows = [...this.byId.values()].filter((log) => log.teamId === teamId);
    if (before !== undefined) {
      // Exclusive keyset over (createdAt DESC, id DESC): strictly older, then id as the tiebreak at
      // an equal createdAt. ISO-8601 strings compare lexicographically in chronological order. This
      // matches the sort below exactly, so same-millisecond boundary siblings are never dropped.
      rows = rows.filter(
        (log) =>
          log.createdAt < before.createdAt ||
          (log.createdAt === before.createdAt && log.id < before.id),
      );
    }
    // Newest first, with the id as a stable tiebreaker for entries sharing a createdAt.
    rows.sort((a, b) => {
      if (a.createdAt !== b.createdAt) {
        return a.createdAt < b.createdAt ? 1 : -1;
      }
      return a.id < b.id ? 1 : -1;
    });
    return rows.slice(0, limit);
  }
}
