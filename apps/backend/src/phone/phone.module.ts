import { Module } from '@nestjs/common';

import { PhoneAuthGuard } from './phone-auth.guard';
import { PhoneController } from './phone.controller';
import { PhoneEventsService } from './phone-events.service';
import { TwilioService } from './twilio.service';
import { TwilioWebhooksController } from './twilio-webhooks.controller';

/**
 * Phone feature — Twilio-backed numbers, voice, and SMS.
 *
 * `PhoneController` is the operator-facing API (guarded by a static token); `TwilioWebhooksController`
 * is the public surface Twilio calls (verified by URL secret / signature). `PhoneEventsService` fans
 * inbound webhooks out to the desktop over SSE. `ConfigService` is available globally (AppModule).
 */
@Module({
  controllers: [PhoneController, TwilioWebhooksController],
  providers: [TwilioService, PhoneEventsService, PhoneAuthGuard],
})
export class PhoneModule {}
