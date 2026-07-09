import { Controller, Get, UseGuards } from '@nestjs/common';

import { ok, type ApiResponse } from '../common/api-response';
import { ApiKeyGuard, type ApiKeyAuthenticatedRequest } from '../auth/api-key.guard';
import { Req } from '@nestjs/common';

/**
 * BE-5: automation-facing routes authenticated solely by a Bearer `lb_live_` API key.
 * Revoked/unknown keys 401 via {@link ApiKeyGuard}.
 */
@Controller('automation')
@UseGuards(ApiKeyGuard)
export class AutomationController {
  /** Prove the key is valid and return the owning team id (no secrets). */
  @Get('whoami')
  whoami(
    @Req() req: ApiKeyAuthenticatedRequest,
  ): ApiResponse<{ teamId: string; apiKeyId: string }> {
    return ok({
      teamId: req.apiKeyTeamId!,
      apiKeyId: req.apiKeyId!,
    });
  }
}
