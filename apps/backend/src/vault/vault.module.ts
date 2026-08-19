import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryVaultRepository } from './in-memory-vault.repository';
import { VaultKeyWrapper } from './key-wrapping';
import { PrismaVaultRepository } from './prisma-vault.repository';
import { VaultController } from './vault.controller';
import { VAULT_REPOSITORY } from './vault.repository';

/** Imports AuthModule for the shared `JwtAuthGuard`. Same repo-factory pattern as the other modules. */
@Module({
  imports: [AuthModule],
  controllers: [VaultController],
  providers: [
    {
      provide: VAULT_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? // Constructed here rather than in the repository so a misconfigured master key is a boot
            // failure, not a 500 on the first user who tries to reach their profiles.
            new PrismaVaultRepository(prisma, new VaultKeyWrapper(config))
          : new InMemoryVaultRepository(),
    },
  ],
})
export class VaultModule {}
