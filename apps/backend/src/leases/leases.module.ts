import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { ProfilesModule } from '../profiles/profiles.module';
import { InMemoryLeasesRepository } from './in-memory-leases.repository';
import { LeasesController } from './leases.controller';
import { LEASES_REPOSITORY } from './leases.repository';
import { LeasesService } from './leases.service';
import { PrismaLeasesRepository } from './prisma-leases.repository';

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY`, and ProfilesModule for
 * `PROFILES_REPOSITORY` — a lease is a claim on a profile, so the service has to be able to check
 * the caller can see that profile at all. Importing the module (rather than re-binding the repo
 * factory here) is what keeps the in-memory store a single shared instance: a second binding would
 * give this module its own empty Map and every profile would read as missing.
 *
 * Same repo-factory pattern as the other modules for the leases store itself.
 */
@Module({
  imports: [AuthModule, ProfilesModule],
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
  // LEASES_REPOSITORY is exported for the housekeeping sweep, for the same single-instance reason
  // ProfilesModule exports its own repository.
  exports: [LeasesService, LEASES_REPOSITORY],
})
export class LeasesModule {}
