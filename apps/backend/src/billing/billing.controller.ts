import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { IsBoolean, IsIn, IsInt, IsOptional, IsString } from 'class-validator';
import { Type } from 'class-transformer';
import type {
  BillingPeriod,
  CreditTransaction,
  Deposit,
  PaidPlanTier,
  PlanChangeQuote,
  Subscription,
} from '@lobster/shared-types';

import { CurrentUser } from '../auth/current-user.decorator';
import { EmailVerifiedGuard } from '../auth/email-verified.guard';
import { Public } from '../auth/public.decorator';
import { ok, type ApiResponse } from '../common/api-response';
import { AdminTokenGuard } from './admin-token.guard';
import { BillingService, type BillingOverview, type DepositInstruction } from './billing.service';
import { DEPOSIT_CHAINS } from './deposit-chains';
import { PAYMENT_PROVIDER, type PaymentProvider } from './payments/payment-provider';
import { RenewalService, type RenewalSweepResult } from './renewal.service';

/**
 * Minimal shape of the incoming request this controller touches. Avoids a hard dependency on
 * `@types/express` (not installed in this environment); the runtime object is Express's request.
 */
interface WebhookRequest {
  rawBody?: Buffer;
  headers: Record<string, string | string[] | undefined>;
}

const PAID_TIERS: PaidPlanTier[] = ['light', 'plus', 'pro', 'max'];
const BILLING_PERIODS: BillingPeriod[] = ['monthly', 'yearly'];
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

  /**
   * Monthly, or twelve months up front at the yearly discount. Optional, defaulting to monthly:
   * the price of a package is a decision the buyer makes, and omitting it means the cheaper
   * commitment rather than the larger charge.
   */
  @IsOptional()
  @IsIn(BILLING_PERIODS)
  period?: BillingPeriod;

  // Honoured only after the caller's membership is verified server-side — never trusted as an
  // ambient identity.
  @IsOptional()
  @IsString()
  teamId?: string;
}

/**
 * Query for the quote. Same fields as {@link PurchaseDto} and validated identically — a quote that
 * accepted a tier the purchase would reject is a dialog quoting a package nobody can buy.
 */
class QuoteDto {
  @IsIn(PAID_TIERS)
  tier!: PaidPlanTier;

  @IsOptional()
  @IsIn(BILLING_PERIODS)
  period?: BillingPeriod;

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
    private readonly renewals: RenewalService,
    @Inject(PAYMENT_PROVIDER) private readonly payments: PaymentProvider,
  ) {}

  /** Balance, current package, catalog and chain options — everything the billing page renders. */
  @Get('overview')
  async overview(
    @CurrentUser() user: { id: string },
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<BillingOverview>> {
    return ok(await this.billing.getOverview(user.id, teamId));
  }

  /** Credit statement, newest first. */
  @Get('transactions')
  async transactions(
    @CurrentUser() user: { id: string },
    @Query('limit') limit?: string,
    @Query('teamId') teamId?: string,
  ): Promise<ApiResponse<CreditTransaction[]>> {
    return ok(await this.billing.listTransactions(user.id, Number(limit) || 50, teamId));
  }

  @Get('deposits')
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
  @UseGuards(EmailVerifiedGuard)
  async createDeposit(
    @CurrentUser() user: { id: string },
    @Body() dto: CreateDepositDto,
  ): Promise<ApiResponse<DepositInstruction>> {
    return ok(
      await this.billing.createDeposit(user.id, dto.amountCents, dto.currencyCode, dto.teamId),
    );
  }

  /**
   * What buying a package would do, without doing it.
   *
   * A GET because it changes nothing and reserves nothing — the balance can move between this and
   * the purchase, and `purchasePlan` prices the change again for itself rather than trusting an
   * answer the client is holding.
   */
  @Get('quote')
  async quote(
    @CurrentUser() user: { id: string },
    @Query() query: QuoteDto,
  ): Promise<ApiResponse<PlanChangeQuote>> {
    return ok(
      await this.billing.quotePlanChange(
        user.id,
        query.tier,
        query.period ?? 'monthly',
        query.teamId,
      ),
    );
  }

  /** Buy a package, paid from Credit. */
  @Post('purchase')
  async purchase(
    @CurrentUser() user: { id: string },
    @Body() dto: PurchaseDto,
  ): Promise<ApiResponse<Subscription>> {
    return ok(
      await this.billing.purchasePlan(user.id, dto.tier, dto.period ?? 'monthly', dto.teamId),
    );
  }

  @Post('auto-renew')
  async autoRenew(
    @CurrentUser() user: { id: string },
    @Body() dto: AutoRenewDto,
  ): Promise<ApiResponse<Subscription>> {
    return ok(await this.billing.setAutoRenew(user.id, dto.autoRenew, dto.teamId));
  }

  /**
   * Run one renewal sweep now, for a deployment that drives billing from its own scheduler.
   *
   * THE ONLY WAY TO CHARGE ANYTHING when `RENEWAL_SWEEP_INTERVAL_MS=0`. That setting turns the
   * in-process timer off, which without this route means renewals simply stop happening — silently,
   * because nothing errors when a job that was never scheduled does not run.
   *
   * Guarded by a shared secret rather than a session (see {@link AdminTokenGuard}), and safe to
   * call as often as a cron likes: the sweep is the same idempotent pass the timer runs, so two
   * overlapping invocations cannot double-charge a subscription. The counts come back so the caller
   * has something to log and alert on.
   */
  // @Public exempts this from the global JWT guard so AdminTokenGuard is the ONLY authority
  // here; an operator's sweep call carries an admin token, not a user session.
  @Public()
  @Post('admin/renewal-sweep')
  @UseGuards(AdminTokenGuard)
  @HttpCode(200)
  async renewalSweep(): Promise<ApiResponse<RenewalSweepResult>> {
    return ok(await this.renewals.sweep());
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
  @Public()
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
