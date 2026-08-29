import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { Public } from '../auth/public.decorator';
import { ok, type ApiResponse } from '../common/api-response';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Liveness + readiness probes.
 *
 * - `GET /health` — always 200 when the process is up (load balancer liveness).
 * - `GET /health/ready` — 503 in production (or when `HEALTH_REQUIRE_DB=1`) if Postgres
 *   is configured but unreachable; 200 otherwise (SEC-6 readiness).
 */
// Public by design: load balancers and uptime checks have no session, and a health probe that
// requires one measures the auth layer, not the service.
@Public()
@Controller('health')
export class HealthController {
  constructor(
    private readonly config: ConfigService,
    private readonly prisma: PrismaService,
  ) {}

  @Get()
  check(): ApiResponse<{ status: 'ok' }> {
    return ok({ status: 'ok' });
  }

  @Get('ready')
  async ready(): Promise<ApiResponse<{ status: 'ready'; database: 'up' | 'skipped' }>> {
    const requireDb =
      this.config.get<string>('NODE_ENV') === 'production' ||
      this.config.get<string>('HEALTH_REQUIRE_DB') === '1';
    const databaseUrl = this.config.get<string>('DATABASE_URL');

    if (!requireDb || !databaseUrl) {
      return ok({ status: 'ready', database: 'skipped' });
    }

    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return ok({ status: 'ready', database: 'up' });
    } catch {
      throw new ServiceUnavailableException('database unavailable');
    }
  }
}
