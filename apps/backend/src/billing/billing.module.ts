import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';

import { AuthModule } from '../auth/auth.module';
import { PrismaService } from '../prisma/prisma.service';
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
 * Credit, deposits and packages.
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
  exports: [BillingService, BILLING_REPOSITORY],
})
export class BillingModule {}
