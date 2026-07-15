import { Body, Controller, Headers, HttpCode, Post, Req, UseGuards } from '@nestjs/common';
import { IsIn, IsOptional, IsString } from 'class-validator';
import type { PlanTier, User } from '@lobster/shared-types';

/**
 * Minimal shape of the incoming request this controller touches. Avoids a hard dependency
 * on `@types/express` (not installed in this environment); the runtime object is Express's
 * request. TODO(DB infra): restore `import type { Request } from 'express'` once the
 * express types are available.
 */
interface WebhookRequest {
  rawBody?: Buffer;
}

import { CurrentUser } from '../auth/current-user.decorator';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok, type ApiResponse } from '../common/api-response';
import { BillingService, type CheckoutSession, type WebhookAck } from './billing.service';

const PLAN_TIERS: PlanTier[] = ['free', 'pro', 'team', 'enterprise'];

class CreateCheckoutDto {
  @IsIn(PLAN_TIERS)
  tier!: PlanTier;

  // Optional: the team to subscribe. When omitted the caller's own team is used. When present it is
  // validated against the caller's membership server-side — it is NEVER trusted as an ambient identity.
  @IsOptional()
  @IsString()
  teamId?: string;
}

/**
 * Billing endpoints. The checkout route requires authentication and resolves the team from the
 * authenticated caller (never from an unverified body). The webhook route is called by STRIPE (not our
 * clients), so it cannot use JWT auth — it must be verified by the Stripe signature instead.
 */
@Controller('billing')
export class BillingController {
  constructor(private readonly billingService: BillingService) {}

  @Post('checkout')
  @UseGuards(JwtAuthGuard)
  async createCheckout(
    @CurrentUser() user: User,
    @Body() dto: CreateCheckoutDto,
  ): Promise<ApiResponse<CheckoutSession>> {
    return ok(await this.billingService.createCheckoutSession(user.id, dto.tier, dto.teamId));
  }

  /**
   * Stripe webhook receiver. Authenticated by the Stripe signature, NOT a JWT (Stripe is the caller).
   *
   * IMPORTANT: signature verification needs the RAW request body. TODO(Day 2): register a
   * raw body parser for this exact path (e.g. `express.raw({ type: 'application/json' })`
   * in main.ts) so `req.rawBody` is populated, then verify in the service before dispatch.
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
