import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
import { AdminTokenGuard } from './admin-token.guard';
import { AgentSpendService } from './agent-spend.service';
import { BILLING_REPOSITORY } from './billing.repository';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';
import { DepositReconciliationService } from './deposit-reconciliation.service';
import { InMemoryBillingRepository } from './in-memory-billing.repository';
import { NowPaymentsProvider } from './payments/nowpayments.provider';
import { PAYMENT_PROVIDER } from './payments/payment-provider';
import { PrismaBillingRepository } from './prisma-billing.repository';
import { RenewalService } from './renewal.service';

/**
 * Credit, deposits, packages and metered agent spend.
 *
 * Imports AuthModule for the shared `JwtAuthGuard` and `TEAMS_REPOSITORY` (resolving the caller's
 * team rather than trusting the request body — on a billing endpoint that distinction is what
 * stops one team spending another's Credit).
 *
 * NOTE ON profileLimit. ProfilesModule does NOT go through this module to read it — its own
 * repository reads `subscriptions.profileLimit` directly, which predates this module and still
 * works. `BILLING_REPOSITORY` is exported so that path can be consolidated here later without a
 * second consumer having to reach into Prisma; nothing depends on it yet.
 */
@Module({
  imports: [AuthModule, ConfigModule],
  controllers: [BillingController],
  providers: [
    BillingService,
    RenewalService,
    DepositReconciliationService,
    AgentSpendService,
    AdminTokenGuard,
    {
      provide: BILLING_REPOSITORY,
      inject: [ConfigService, PrismaService],
      useFactory: (config: ConfigService, prisma: PrismaService) =>
        config.get<string>('DATABASE_URL')
          ? new PrismaBillingRepository(prisma)
          : new InMemoryBillingRepository(),
    },
    {
      // One provider, bound behind a token. The rest of the codebase never names a processor, so
      // swapping one is a change to ./payments and this binding.
      //
      // There is no env-var selector. It existed to choose between two processors; with one, a
      // selector is a way for a deployment to typo itself into a boot failure, and its default
      // silently decided which company handles the money.
      provide: PAYMENT_PROVIDER,
      inject: [ConfigService],
      useFactory: (config: ConfigService) => new NowPaymentsProvider(config),
    },
  ],
  // `AgentSpendService` is exported for AgentModule: metering agent calls is billing's job, and the
  // agent module has no business owning a second way to move Credit.
  exports: [BillingService, AgentSpendService, BILLING_REPOSITORY],
})
export class BillingModule {}
