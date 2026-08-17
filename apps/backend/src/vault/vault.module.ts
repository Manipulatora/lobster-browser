import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryVaultRepository } from './in-memory-vault.repository';
import { PrismaVaultRepository } from './prisma-vault.repository';
import { VaultController } from './vault.controller';
import { VAULT_REPOSITORY } from './vault.repository';
import { VaultService } from './vault.service';

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (the team an audit row is
 * attributed to), and AuditModule so enrollment and rotation are recorded. Same repo-factory pattern
 * as the other feature modules: Prisma when `DATABASE_URL` is set, otherwise in-memory so the service
 * boots and is tested without a database.
 */
@Module({
  imports: [AuthModule, AuditModule],
  controllers: [VaultController],
  providers: [
    VaultService,
    {
      provide: VAULT_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaVaultRepository(prisma)
          : new InMemoryVaultRepository(),
    },
  ],
  exports: [VaultService],
})
export class VaultModule {}
