import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { InMemoryProfilesRepository } from './in-memory-profiles.repository';
import { PrismaProfilesRepository } from './prisma-profiles.repository';
import { PROFILES_REPOSITORY } from './profiles.repository';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (used to resolve the
 * caller's team). Provides the `PROFILES_REPOSITORY` via the same repo-factory pattern as auth:
 * Prisma when DATABASE_URL is set, otherwise the in-memory store.
 */
@Module({
  imports: [AuthModule],
  controllers: [ProfilesController],
  providers: [
    ProfilesService,
    {
      provide: PROFILES_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaProfilesRepository(prisma)
          : new InMemoryProfilesRepository(),
    },
  ],
  exports: [ProfilesService],
})
export class ProfilesModule {}
