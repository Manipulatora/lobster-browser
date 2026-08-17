import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { BLOB_STORE, type BlobStore } from './blob/blob-store';
import { InMemoryBlobStore } from './blob/in-memory-blob-store';
import { S3BlobStore } from './blob/s3-blob-store';
import { InMemoryProfilesRepository } from './in-memory-profiles.repository';
import { PrismaProfilesRepository } from './prisma-profiles.repository';
import { PROFILES_REPOSITORY } from './profiles.repository';
import { ProfilesController } from './profiles.controller';
import { ProfilesService } from './profiles.service';

/**
 * Resolve the CLIENT-encrypted blob store: S3 when `S3_BUCKET` is configured, in-memory otherwise.
 *
 * In **production** an S3 bucket is REQUIRED and we hard-fail without one, mirroring
 * `resolveJwtSecret` (auth/jwt-secret.ts). `InMemoryBlobStore` is a process-local Map: it keeps
 * only the latest version, is invisible to a second replica, and vanishes on restart — while the
 * API keeps handing clients version numbers and blob refs that promise durable storage. A
 * deployment that boots that way loses every pushed profile blob on the next restart with no error
 * anywhere, so refusing to start is strictly better than the lie.
 */
/** Module-scope: this runs in a provider factory, before any instance exists. */
const logger = new Logger('ProfilesModule');

export function resolveBlobStore(config: ConfigService): BlobStore {
  if (config.get<string>('S3_BUCKET')) {
    return new S3BlobStore(config);
  }
  const env = config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development';
  if (env === 'production') {
    // ACKNOWLEDGED, NOT ACCIDENTAL. The failure this guard exists to prevent is a deployment that
    // silently promises durable storage; it is not a problem to run without object storage while
    // no client pushes a blob at all, which is the case until the sync client of Phase 5 ships
    // (see docs/PROFILE_DATA_SYNC.md). So the ephemeral store stays reachable in production, but
    // only for an operator who wrote the words down — an unset variable still refuses to start,
    // which is what stops it being reached by forgetting.
    if (config.get<string>('ALLOW_EPHEMERAL_BLOB_STORE') !== '1') {
      throw new Error(
        'S3_BUCKET is required in production. Refusing to start with the in-memory blob store, ' +
          'which loses every synced profile blob on restart. Set S3_BUCKET, or set ' +
          'ALLOW_EPHEMERAL_BLOB_STORE=1 to acknowledge that profile blobs are not durable yet.',
      );
    }
    logger.warn(
      'BLOB STORAGE IS EPHEMERAL: ALLOW_EPHEMERAL_BLOB_STORE=1 and no S3_BUCKET. Any profile blob ' +
        'pushed to this instance is lost on restart. This must be removed before profile sync ships.',
    );
  }
  return new InMemoryBlobStore();
}

/**
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (used to resolve the
 * caller's team). Provides the `PROFILES_REPOSITORY` and `BLOB_STORE` via the same repo-factory
 * pattern as auth: the durable backend when its env is configured, otherwise — outside production
 * only, see {@link resolveBlobStore} — the in-memory store, so the service boots and is tested
 * without a database or object store.
 */
@Module({
  imports: [AuthModule, AuditModule],
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
      provide: BLOB_STORE,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => resolveBlobStore(config),
    },
  ],
  exports: [ProfilesService],
})
export class ProfilesModule {}
