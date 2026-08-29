import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { APP_GUARD } from '@nestjs/core';
import { JwtModule } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { InMemoryTeamsRepository } from '../teams/in-memory-teams.repository';
import { PrismaTeamsRepository } from '../teams/prisma-teams.repository';
import { TEAMS_REPOSITORY, type TeamsRepository } from '../teams/teams.repository';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { DesktopAuthService } from './desktop-auth.service';
import {
  DESKTOP_AUTH_REPOSITORY,
  InMemoryDesktopAuthRepository,
  PrismaDesktopAuthRepository,
} from './desktop-auth.repository';
import { InMemoryUsersRepository } from './in-memory-users.repository';
import { EmailVerifiedGuard } from './email-verified.guard';
import { JwtAuthGuard } from './jwt-auth.guard';
import { PrismaUsersRepository } from './prisma-users.repository';
import { resolveJwtSecret } from './jwt-secret';
import { USERS_REPOSITORY } from './users.repository';

@Module({
  imports: [
    // Signs/verifies JWTs. The secret hard-fails in production when JWT_SECRET is unset.
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: resolveJwtSecret(config),
        signOptions: { expiresIn: '7d' },
      }),
    }),
  ],
  controllers: [AuthController],
  providers: [
    // Authenticate-by-default: every route in the application requires a Bearer JWT unless it is
    // explicitly annotated `@Public()` (see public.decorator.ts for what qualifies). Registered
    // here rather than in AppModule because this module owns the guard's dependencies — and every
    // e2e module graph already imports AuthModule, so the tests exercise the same default.
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    EmailVerifiedGuard,
    AuthService,
    DesktopAuthService,
    JwtAuthGuard,
    {
      provide: DESKTOP_AUTH_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaDesktopAuthRepository(prisma)
          : new InMemoryDesktopAuthRepository(),
    },
    // The real data layer: persist to Postgres (Prisma*Repository) when DATABASE_URL is set;
    // otherwise fall back to the in-memory store for local dev / tests (no DB required to boot).
    //
    // Users AND teams live here (and are exported) so they are single shared singletons: the
    // personal team registration creates is in the SAME store TeamsModule and
    // ProfilesModule read from.
    {
      provide: TEAMS_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaTeamsRepository(prisma)
          : new InMemoryTeamsRepository(),
    },
    {
      provide: USERS_REPOSITORY,
      inject: [ConfigService, PrismaService, TEAMS_REPOSITORY],
      useFactory: (config: ConfigService, prisma: PrismaService, teams: TeamsRepository) => {
        if (config.get<string>('DATABASE_URL')) return new PrismaUsersRepository(prisma);
        if (!(teams instanceof InMemoryTeamsRepository)) {
          throw new Error('in-memory users require the shared in-memory teams repository');
        }
        return new InMemoryUsersRepository((ownerUserId, name) =>
          teams.prepareTeamWithOwner(ownerUserId, name),
        );
      },
    },
  ],
  // Re-export JwtModule so modules that import AuthModule to reuse JwtAuthGuard (Teams, Profiles)
  // can resolve the guard's JwtService dependency in their own context.
  exports: [
    AuthService,
    JwtAuthGuard,
    EmailVerifiedGuard,
    JwtModule,
    USERS_REPOSITORY,
    TEAMS_REPOSITORY,
    // For the housekeeping sweep, which has to reach the same grant store the handoff writes to.
    DESKTOP_AUTH_REPOSITORY,
  ],
})
export class AuthModule {}
