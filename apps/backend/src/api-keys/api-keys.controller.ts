import { Body, Controller, Delete, Get, Param, Post, Query } from '@nestjs/common';
import type { ApiKey, User } from '@lobster/shared-types';

import { ok, type ApiResponse } from '../common/api-response';
import { CurrentUser } from '../auth/current-user.decorator';

import { ApiKeysService, type CreatedApiKey } from './api-keys.service';
import { CreateApiKeyDto } from './dto/create-api-key.dto';

/**
 * API-key management. Every route requires a valid JWT; the owning team is resolved from the
 * authenticated caller's membership (or an explicit `?teamId=` they belong to), never a stub. All
 * responses use the shared `{ code, data, msg }` envelope.
 *
 * The full secret is returned only from POST (once, at creation). GET/DELETE responses carry the
 * public {@link ApiKey} shape (prefix/name/teamId/createdAt/lastUsedAt) — never the secret or hash.
 */
@Controller('api-keys')
export class ApiKeysController {
  constructor(private readonly apiKeysService: ApiKeysService) {}

  /**
   * Create a key and return the plaintext `secret` EXACTLY ONCE alongside the public record. The
   * secret is unrecoverable afterwards (only its hash is stored), so the caller must capture it now.
   */
  @Post()
  async create(
    @CurrentUser() user: User,
    @Body() dto: CreateApiKeyDto,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<CreatedApiKey>> {
    return ok(await this.apiKeysService.create(user.id, dto, teamId));
  }

  @Get()
  async findAll(
    @CurrentUser() user: User,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<ApiKey[]>> {
    return ok(await this.apiKeysService.findAll(user.id, teamId));
  }

  /** Revoke (delete) a key owned by the caller's team; 404 when it is not in that team. */
  @Delete(':id')
  async remove(
    @CurrentUser() user: User,
    @Param('id') id: string,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<{ id: string; revoked: true }>> {
    return ok(await this.apiKeysService.remove(user.id, id, teamId));
  }
}
