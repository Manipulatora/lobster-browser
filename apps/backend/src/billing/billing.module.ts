import { Module } from '@nestjs/common';

import { AuthModule } from '../auth/auth.module';
import { BillingController } from './billing.controller';
import { BillingService } from './billing.service';

// Imports AuthModule for the shared `JwtAuthGuard` (checkout auth) and `TEAMS_REPOSITORY`
// (resolving the caller's team instead of trusting the request body).
@Module({
  imports: [AuthModule],
  controllers: [BillingController],
  providers: [BillingService],
  exports: [BillingService],
})
export class BillingModule {}
