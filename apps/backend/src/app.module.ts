import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { AuthModule } from './auth/auth.module';
import { BillingModule } from './billing/billing.module';
import { HealthModule } from './health/health.module';
import { PrismaModule } from './prisma/prisma.module';
import { ProfilesModule } from './profiles/profiles.module';
import { TeamsModule } from './teams/teams.module';

/**
 * Root module. Wires the feature modules together.
 *
 * `ConfigModule.forRoot({ isGlobal: true })` loads `.env` once and exposes `ConfigService`
 * everywhere. `PrismaModule` is global and provides the single `PrismaService` (which connects to
 * Postgres only when `DATABASE_URL` is set — see prisma.service.ts).
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
    HealthModule,
    AuthModule,
    TeamsModule,
    ProfilesModule,
    BillingModule,
  ],
})
export class AppModule {}
