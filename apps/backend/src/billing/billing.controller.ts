import { Body, Controller, Get, HttpCode, Inject, Post, Query, Req, UseGuards } from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import type { CreditTransaction, Deposit, PaidPlanTier, Subscription } from '@lobster/shared-types';

import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { ok, type ApiResponse } from '../common/api-response';
import {
  BillingService,
  type BillingOverview,
  type DepositInstruction,
} from './billing.service';
import { DEPOSIT_CHAINS } from './deposit-chains';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payments/payment-provider';

/**
 * Minimal shape of the incoming request this controller touches. Avoids a hard dependency on
 * `@types/express` (not installed in this environment); the runtime object is Express's request.
 */
interface WebhookRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

const PAID_TIERS: PaidPlanTier[] = ['light', 'plus', 'pro', 'max'];
const CHAIN_CODES = DEPOSIT_CHAINS.map((c) => c.code);

class CreateDepositDto {
  /** Amount to add to Credit, in USD cents. */
  @Type(() => Number)
  @IsInt()
  amountCents!: number;

  @IsIn(CHAIN_CODES)
  currencyCode!: string;

  @IsOptional()
  @IsString()
  teamId?: string;
}

class PurchaseDto {
  @IsIn(PAID_TIERS)
  tier!: PaidPlanTier;

  // Honoured only after the caller's membership is verified server-side — never trusted as an
  // ambient identity.
  @IsOptional()
  @IsString()
  teamId?: string;
}

class AutoRenewDto {
  @IsBoolean()
  autoRenew!: boolean;

  @IsOptional()
  @IsString()
  teamId?: string;
}

/**
 * Billing endpoints.
 *
 * Everything except the webhook requires a JWT and resolves the team from the authenticated
 * caller. The webhook is called by the payment processor, which has no JWT — it is authenticated
 * by an HMAC signature over the payload instead, and that check is the only thing standing between
 * a POST and minted Credit.
 */
@Controller('billing')
export class BillingController {
  constructor(
    private readonly billing: BillingService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  /** Balance, current package, catalog and chain options — everything the billing page renders. */
  @Get('overview')
  @UseGuards(JwtAuthGuard)
  async overview(
    @CurrentUser() user: { id: string },
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<BillingOverview>> {
    return ok(await this.billing.getOverview(user.id, teamId));
  }

  /** Credit statement, newest first. */
  @Get('transactions')
  @UseGuards(JwtAuthGuard)
  async transactions(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<CreditTransaction[]>> {
    return ok(await this.billing.listTransactions(user.id, Number(limit) || 50, teamId));
  }

  @Get('deposits')
  @UseGuards(JwtAuthGuard)
  async deposits(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<Deposit[]>> {
    return ok(await this.billing.listDeposits(user.id, Number(limit) || 20, teamId));
  }

  /**
   * Issue a deposit address. The user sends funds to it; Credit appears when the IPN confirms.
   *
   * `EmailVerifiedGuard` is the money gate: an account whose address was never proven cannot open
   * a deposit, because it is an account we could not send a receipt to or resolve a dispute with.
   */
  @Post('deposits')
  @UseGuards(JwtAuthGuard, EmailVerifiedGuard)
  async createDeposit(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateDepositDto,
  ): Promise<ApiResponse<DepositInstruction>> {
    return ok(
      await this.billing.createDeposit(user.id, dto.amountCents, dto.currencyCode, dto.teamId),
    );
  }

  /** Buy a package, paid from Credit. */
  @Post('purchase')
  @UseGuards(JwtAuthGuard)
  async purchase(
    @CurrentUser() user: { id: string },
    @Body() dto: PurchaseDto,
  ): Promise<ApiResponse<Subscription>> {
    return ok(await this.billing.purchasePlan(user.id, dto.tier, dto.teamId));
  }

  @Post('auto-renew')
  @UseGuards(JwtAuthGuard)
  async autoRenew(
    @CurrentUser() user: { id: string },
    @Body() dto: AutoRenewDto,
  ): Promise<ApiResponse<Subscription>> {
    return ok(await this.billing.setAutoRenew(user.id, dto.autoRenew, dto.teamId));
  }

  /**
   * Payment-processor callback (NOWPayments IPN).
   *
   * NOT JWT-AUTHENTICATED, because the caller is the processor. Authentication is the HMAC
   * signature over the payload, verified in `PaymentProvider.verifyWebhook` before anything is
   * parsed or persisted. An unverified body is rejected outright: this endpoint mints money, so a
   * forged POST that reached the crediting path would be a direct theft of service.
   *
   * SIGNING NEEDS THE RAW BYTES, which is why `rawBody` is read here rather than `@Body()`. See
   * `body-limit.ts` for where the raw buffer is captured.
   *
   * ALWAYS RETURNS 200, including for a rejected signature. The processor treats a non-2xx as a
   * delivery failure and retries with backoff; retrying a forged or malformed callback can never
   * succeed, and answering 4xx tells a prober which payloads were structurally interesting. The
   * body distinguishes the cases for our own logs.
   */
  @Post('webhook')
  @HttpCode(200)
  async webhook(@Req() req: WebhookRequest): Promise<{ received: true; credited: boolean }> {
    const rawBody = req.rawBody;
    if (!rawBody || rawBody.length === 0) {
      return { received: true, credited: false };
    }

    const event = this.payments.verifyWebhook(rawBody, req.headers);
    if (!event) {
      // Logged with detail inside the provider; nothing actionable is returned to the caller.
      return { received: true, credited: false };
    }

    const credited = await this.billing.applyWebhook(event);
    return { received: true, credited };
  }
}
