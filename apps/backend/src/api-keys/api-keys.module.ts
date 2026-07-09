import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { API_KEYS_REPOSITORY } from './api-keys.repository';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { AutomationController } from './automation.controller';
import { InMemoryApiKeysRepository } from './in-memory-api-keys.repository';
import { PrismaApiKeysRepository } from './prisma-api-keys.repository';
import { ApiKeyGuard } from '../auth/api-key.guard';

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (used to resolve the
 * caller's team). Provides the `API_KEYS_REPOSITORY` via the same repo-factory pattern as the
 * other feature modules: the Prisma backend when `DATABASE_URL` is configured, otherwise the
 * in-memory store (so the service boots and is tested without a database).
 *
 * Exports `ApiKeysService` + `ApiKeyGuard` so automation routes can authenticate by secret.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ApiKeysController, AutomationController],
  providers: [
    ApiKeysService,
    ApiKeyGuard,
    {
      provide: API_KEYS_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaApiKeysRepository(prisma)
          : new InMemoryApiKeysRepository(),
    },
  ],
  exports: [ApiKeysService, ApiKeyGuard],
})
export class ApiKeysModule {}
