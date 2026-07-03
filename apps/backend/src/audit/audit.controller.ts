import { Controller, Get, Query, UseGuards } from '@nestjs/common';
import type { AuditLog, User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { AuditService } from './audit.service';

/**
 * Read-only audit-log feed. Every route requires a valid JWT; the owning team is resolved from
 * the authenticated caller's membership (or an explicit `?teamId=` they belong to), never a stub.
 * There is no write endpoint — entries are appended internally via `AuditService.record` by the
 * modules that perform the underlying actions. All responses use the shared `{ code, data, msg }`
 * envelope.
 */
@Controller('audit')
@UseGuards(JwtAuthGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * The caller's team audit feed, newest first. Query params:
   *   - `limit`  — page size (default 50, capped at 200); parsed to a number, clamped in the service.
   *   - `before` — opaque keyset cursor (base64url of `createdAt|id`); only entries strictly older
   *                than it are returned. A client pages back by passing the last row's cursor
   *                (`encodeAuditCursor(row)`). A malformed cursor is a 400.
   *   - `teamId` — optional explicit team the caller belongs to (else their first team is used).
   */
  @Get()
  async list(
    @CurrentUser() user: User,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<AuditLog[]>> {
    return ok(
      await this.auditService.list(user.id, {
        teamId,
        limit: limit !== undefined ? Number(limit) : undefined,
        before,
      }),
    );
  }
}
