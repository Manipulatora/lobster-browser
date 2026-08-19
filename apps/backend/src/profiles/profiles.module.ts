import { Logger, Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { AuditModule } from '../audit/audit.module';
import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { BLOB_STORE, type BlobStore } from './blob/blob-store';
import { FilesystemBlobStore } from './blob/filesystem-blob-store';
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
  // A directory on the server's own disk is a first-class choice, not a fallback. The blobs are
  // encrypted by the client before upload, so the server stores opaque bytes either way — durability
  // and atomicity are all that is required of the store, and a backed-up filesystem provides both
  // without an external dependency or a set of credentials.
  if (config.get<string>('BLOB_STORE_PATH')) {
    return new FilesystemBlobStore(config);
  }
  const env = config.get<string>('NODE_ENV') ?? process.env.NODE_ENV ?? 'development';
  if (env === 'production') {
    // ACKNOWLEDGED, NOT ACCIDENTAL. The failure this guard exists to prevent is a deployment that
    // silently promises durable storage while the store is a process-local Map that empties on
    // restart. Now that BLOB_STORE_PATH is available, running ephemeral in production has no good
    // reason left — but an operator who writes the words down can still do it, and an unset variable
    // still refuses to start, which is what stops it being reached by forgetting.
    if (config.get<string>('ALLOW_EPHEMERAL_BLOB_STORE') !== '1') {
      throw new Error(
        'no durable blob storage configured. Set BLOB_STORE_PATH (a directory on this server) or ' +
          'S3_BUCKET. Refusing to start with the in-memory blob store, which loses every synced ' +
          'profile blob on restart. Set ALLOW_EPHEMERAL_BLOB_STORE=1 to acknowledge that anyway.',
      );
    }
    logger.warn(
      'BLOB STORAGE IS EPHEMERAL: ALLOW_EPHEMERAL_BLOB_STORE=1 with no BLOB_STORE_PATH or S3_BUCKET. ' +
        'Any profile blob pushed to this instance is lost on restart.',
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
  // PROFILES_REPOSITORY is exported so LeasesModule can check profile ownership against the SAME
  // store this module writes to, rather than binding a second (and, in-memory, empty) one.
  exports: [ProfilesService, PROFILES_REPOSITORY],
})
export class ProfilesModule {}
