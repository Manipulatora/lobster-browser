import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

import { PrismaService } from '../prisma/prisma.service';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { InMemoryUsersRepository } from './in-memory-users.repository';
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
    AuthService,
    JwtAuthGuard,
    // The real data layer: persist to Postgres (PrismaUsersRepository) when DATABASE_URL is set;
    // otherwise fall back to the in-memory store for local dev / tests (no DB required to boot).
    {
      provide: USERS_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaUsersRepository(prisma)
          : new InMemoryUsersRepository(),
    },
  ],
  exports: [AuthService, JwtAuthGuard],
})
export class AuthModule {}
