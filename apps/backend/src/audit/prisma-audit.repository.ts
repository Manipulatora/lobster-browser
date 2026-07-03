import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { AuditLog } from '@lobster/shared-types';

import { PrismaService } from '../prisma/prisma.service';
import type {
  AuditRepository,
  CreateAuditLogRecord,
  ListAuditLogOptions,
} from './audit.repository';

/** The subset of a Prisma `audit_logs` row this repository maps to an `AuditLog`. */
interface AuditLogRow {
  id: string;
  teamId: string;
  actorUserId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  metadata: Prisma.JsonValue;
  createdAt: Date;
}

/**
 * Production `AuditRepository` backed by Postgres via the shared {@link PrismaService}.
 *
 * The wiring module selects this as the active provider whenever `DATABASE_URL` is set; without
 * a DB (local dev / tests) the in-memory repository is used instead. Every query is scoped to
 * `teamId`. The table is append-only — this repository only ever inserts and reads.
 */
@Injectable()
export class PrismaAuditRepository implements AuditRepository {
  constructor(private readonly prisma: PrismaService) {}

  async record(entry: CreateAuditLogRecord): Promise<AuditLog> {
    const row = await this.prisma.auditLog.create({
      data: {
        teamId: entry.teamId,
        actorUserId: entry.actorUserId ?? null,
        action: entry.action,
        targetType: entry.targetType,
        targetId: entry.targetId ?? null,
        metadata: (entry.metadata ?? {}) as unknown as Prisma.InputJsonValue,
      },
    });
    return this.toAuditLog(row);
  }

  async listByTeam(teamId: string, { limit, before }: ListAuditLogOptions): Promise<AuditLog[]> {
    const rows = await this.prisma.auditLog.findMany({
      where: {
        teamId,
        // Exclusive keyset cursor over (createdAt DESC, id DESC): older timestamp, OR the same
        // timestamp with a smaller id. Carrying the id (not just the timestamp) is what stops
        // same-millisecond boundary siblings being silently skipped. Prisma maps DateTime to
        // timestamp(3) (ms) by default, matching the ms-precision cursor the client echoes back.
        ...(before
          ? {
              OR: [
                { createdAt: { lt: new Date(before.createdAt) } },
                { createdAt: new Date(before.createdAt), id: { lt: before.id } },
              ],
            }
          : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: limit,
    });
    return rows.map((row) => this.toAuditLog(row));
  }

  private toAuditLog(row: AuditLogRow): AuditLog {
    return {
      id: row.id,
      teamId: row.teamId,
      actorUserId: row.actorUserId ?? undefined,
      action: row.action,
      targetType: row.targetType,
      targetId: row.targetId ?? undefined,
      metadata: this.readMetadata(row.metadata),
      createdAt: row.createdAt.toISOString(),
    };
  }

  /** Coerce the stored JSON back to the shared-types `Record<string, unknown>` (or undefined). */
  private readMetadata(value: Prisma.JsonValue): Record<string, unknown> | undefined {
    if (value !== null && typeof value === 'object' && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
    return undefined;
  }
}
