import { Body, Controller, Headers, HttpCode, Post, Req } from '@nestjs/common';
import { IsIn, IsString } from 'class-validator';
import type { PlanTier } from '@lobster/shared-types';

/**
 * Minimal shape of the incoming request this controller touches. Avoids a hard dependency
 * on `@types/express` (not installed in this environment); the runtime object is Express's
 * request. TODO(DB infra): restore `import type { Request } from 'express'` once the
 * express types are available.
 */
interface WebhookRequest {
  rawBody?: Buffer;
}

import { ok, type ApiResponse } from '../common/api-response';
import { BillingService, type CheckoutSession, type WebhookAck } from './billing.service';

const PLAN_TIERS: PlanTier[] = ['free', 'pro', 'team', 'enterprise'];

class CreateCheckoutDto {
  // TODO(Day 2): derive teamId from the authenticated JWT instead of the body.
  @IsString()
  teamId!: string;

  @IsIn(PLAN_TIERS)
  tier!: PlanTier;
}

/**
 * Billing endpoints. The checkout route uses the shared `{ code, data, msg }` envelope.
 * The webhook route replies to STRIPE (not our clients), so it returns a plain 200.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout')
  async createCheckout(@Body() dto: CreateCheckoutDto): Promise<ApiResponse<CheckoutSession>> {
    return ok(await this.billingService.createCheckoutSession(dto.teamId, dto.tier));
  }

  /**
   * Stripe webhook receiver.
   *
   * IMPORTANT: signature verification needs the RAW request body. TODO(Day 2): register a
   * raw body parser for this exact path (e.g. `express.raw({ type: 'application/json' })`
   * in main.ts) so `req.body` is a Buffer here instead of parsed JSON.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(
    @Req() req: WebhookRequest,
    @Headers('stripe-signature') signature: string,
  ): Promise<WebhookAck> {
    const rawBody = req.rawBody ?? Buffer.from([]);
    return this.billingService.handleWebhook(rawBody, signature);
  }
}
