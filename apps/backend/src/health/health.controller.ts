import { Controller, Get } from '@nestjs/common';

import { ok, type ApiResponse } from '../common/api-response';

/**
 * Liveness probe. Used by load balancers / uptime checks and the desktop agent to
 * confirm the cloud API is reachable.
 */
@Controller('health')
export class HealthController {
  @Get()
  check(): ApiResponse<{ status: 'ok' }> {
    return ok({ status: 'ok' });
  }
}
