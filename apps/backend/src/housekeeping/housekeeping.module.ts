import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { LeasesModule } from '../leases/leases.module';
import { HousekeepingService } from './housekeeping.service';

/**
 * Imports the modules that OWN the short-lived tables rather than re-binding their repositories,
 * so the sweep runs against the same stores the request path writes to — with the in-memory
 * backend a second binding would be a second empty Map and the sweep would clean nothing.
 */
@Module({
  imports: [AuthModule, LeasesModule],
  providers: [HousekeepingService],
  exports: [HousekeepingService],
})
export class HousekeepingModule {}
