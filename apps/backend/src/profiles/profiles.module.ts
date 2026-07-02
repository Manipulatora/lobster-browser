import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { BLOB_STORE } from './blob/blob-store';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import { S3BlobStore } from './blob/s3-blob-store';
import { InMemoryProfilesRepository } from './in-memory-profiles.repository';
import { PrismaProfilesRepository } from './prisma-profiles.repository';
import { PROFILES_REPOSITORY } from './profiles.repository';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (used to resolve the
 * caller's team). Provides the `PROFILES_REPOSITORY` and `BLOB_STORE` via the same repo-factory
 * pattern as auth: the durable backend when its env is configured, otherwise the in-memory store
 * (so the service boots and is tested without a database or object store).
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
    {
      // CLIENT-encrypted blob store: S3 when an S3_BUCKET is configured, in-memory otherwise.
      provide: BLOB_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        config.get<string>('S3_BUCKET') ? new S3BlobStore(config) : new InMemoryBlobStore(),
    },
  ],
  exports: [ProfilesService],
})
export class ProfilesModule {}
