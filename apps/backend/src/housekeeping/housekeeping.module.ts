import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingModule } from '../billing/billing.module';
import { LeasesModule } from '../leases/leases.module';
import { HousekeepingService } from './housekeeping.service';

/**
 * Imports the modules that OWN the short-lived tables rather than re-binding their repositories,
 * so the sweep runs against the same stores the request path writes to — with the in-memory
 * backend a second binding would be a second empty Map and the sweep would clean nothing.
 * BillingModule is imported for the same reason, and the sweep goes through `BillingService`
 * rather than `BILLING_REPOSITORY` because the expiry cutoff is billing policy (it is coupled to
 * reconciliation's lookback), not a housekeeping constant.
 */
@Module({
  imports: [AuthModule, BillingModule, LeasesModule],
  providers: [HousekeepingService],
  exports: [HousekeepingService],
})
export class HousekeepingModule {}
