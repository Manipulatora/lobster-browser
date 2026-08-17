import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryLeasesRepository } from './in-memory-leases.repository';
import { LeasesController } from './leases.controller';
import { LEASES_REPOSITORY } from './leases.repository';
import { LeasesService } from './leases.service';
import { PrismaLeasesRepository } from './prisma-leases.repository';

/** Imports AuthModule for the shared `JwtAuthGuard`. Same repo-factory pattern as the other modules. */
@Module({
  imports: [AuthModule],
  controllers: [LeasesController],
  providers: [
    LeasesService,
    {
      provide: LEASES_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaLeasesRepository(prisma)
          : new InMemoryLeasesRepository(),
    },
  ],
  exports: [LeasesService],
})
export class LeasesModule {}
