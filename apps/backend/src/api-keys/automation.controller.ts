import { Controller, Get, UseGuards } from '@nestjs/common';

import { ok, type ApiResponse } from '../common/api-response';
import { ApiKeyGuard, type ApiKeyAuthenticatedRequest } from '../auth/api-key.guard';
import { Public } from '../auth/public.decorator';
import { Req } from '@nestjs/common';

/**
 * BE-5: automation-facing routes authenticated solely by a Bearer `lb_live_` API key.
 * Revoked/unknown keys 401 via {@link ApiKeyGuard}.
 */
// @Public exempts this from the global JwtAuthGuard: callers authenticate with an API key,
// not a session, and ApiKeyGuard below is the sole authority.
@Public()
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
