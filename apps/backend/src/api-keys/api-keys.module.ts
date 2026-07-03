import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { API_KEYS_REPOSITORY } from './api-keys.repository';
import { ApiKeysController } from './api-keys.controller';
import { ApiKeysService } from './api-keys.service';
import { InMemoryApiKeysRepository } from './in-memory-api-keys.repository';
import { PrismaApiKeysRepository } from './prisma-api-keys.repository';

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (used to resolve the
 * caller's team). Provides the `API_KEYS_REPOSITORY` via the same repo-factory pattern as the
 * other feature modules: the Prisma backend when `DATABASE_URL` is configured, otherwise the
 * in-memory store (so the service boots and is tested without a database).
 *
 * Exports `ApiKeysService` so a future automation-API guard can call `verify()` to authenticate
 * programmatic requests by their secret.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [ApiKeysController],
  providers: [
    ApiKeysService,
    {
      provide: API_KEYS_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaApiKeysRepository(prisma)
          : new InMemoryApiKeysRepository(),
    },
  ],
  exports: [ApiKeysService],
})
export class ApiKeysModule {}
