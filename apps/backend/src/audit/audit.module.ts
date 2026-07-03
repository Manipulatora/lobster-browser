import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { AUDIT_REPOSITORY } from './audit.repository';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';
import { InMemoryAuditRepository } from './in-memory-audit.repository';
import { PrismaAuditRepository } from './prisma-audit.repository';

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (used to resolve the
 * caller's team). Provides the `AUDIT_REPOSITORY` via the same repo-factory pattern as the other
 * feature modules: the durable Prisma backend when `DATABASE_URL` is configured, otherwise the
 * in-memory store (so the service boots and is tested without a database).
 *
 * EXPORTS `AuditService` so other feature modules can inject it to append history via
 * `AuditService.record(...)`.
 */
@Module({
  imports: [AuthModule],
  controllers: [AuditController],
  providers: [
    AuditService,
    {
      provide: AUDIT_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaAuditRepository(prisma)
          : new InMemoryAuditRepository(),
    },
  ],
  exports: [AuditService],
})
export class AuditModule {}
