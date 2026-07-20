import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Sse,
  UseGuards,
} from '@nestjs/common';
import { type Observable, map } from 'rxjs';

import { err, ok, type ApiResponse } from '../common/api-response';
import { BuyNumberDto, MessageHistoryDto, SearchNumbersDto, SendSmsDto } from './dto';
import { PhoneAuthGuard } from './phone-auth.guard';
import { PhoneEventsService } from './phone-events.service';
import { TwilioService } from './twilio.service';

import type { PhoneEvent } from '@lobster/shared-types';

/**
 * Operator-facing Phone API. Guarded by {@link PhoneAuthGuard} (a static bearer token) because every
 * route here can spend money on the connected Twilio account. Returns the shared `{ code, data, msg }`
 * envelope; Twilio errors are mapped to `err()` so the desktop can surface a readable message.
 */
@UseGuards(PhoneAuthGuard)
@Controller('phone')
export class PhoneController {
  constructor(
    private readonly twilio: TwilioService,
    private readonly events: PhoneEventsService,
  ) {}

  @Get('status')
  status(): ApiResponse<unknown> {
    return ok({ configured: this.twilio.isConfigured(), ...this.twilio.configStatus() });
  }

  @Get('numbers/available')
  search(@Query() query: SearchNumbersDto): Promise<ApiResponse<unknown>> {
    return this.run(() => this.twilio.searchAvailable(query));
  }

  @Get('numbers')
  owned(): Promise<ApiResponse<unknown>> {
    return this.run(() => this.twilio.listOwned());
  }

  @Post('numbers')
  @HttpCode(200)
  buy(@Body() dto: BuyNumberDto): Promise<ApiResponse<unknown>> {
    return this.run(() => this.twilio.buyNumber(dto.phoneNumber));
  }

  @Delete('numbers/:sid')
  release(@Param('sid') sid: string): Promise<ApiResponse<unknown>> {
    return this.run(async () => {
      await this.twilio.releaseNumber(sid);
      return { released: sid };
    });
  }

  @Post('voice/token')
  @HttpCode(200)
  token(): ApiResponse<unknown> {
    try {
      return ok(this.twilio.createVoiceToken(this.twilio.clientIdentity()));
    } catch (e) {
      return err(errorMessage(e));
    }
  }

  @Post('sms')
  @HttpCode(200)
  send(@Body() dto: SendSmsDto): Promise<ApiResponse<unknown>> {
    return this.run(() => this.twilio.sendSms(dto.from, dto.to, dto.body));
  }

  @Get('sms')
  history(@Query() query: MessageHistoryDto): Promise<ApiResponse<unknown>> {
    return this.run(() => this.twilio.listMessages(query.number));
  }

  /** Server-Sent Events stream of inbound SMS + call/message status. EventSource authenticates via
   *  `?key=<PHONE_ACCESS_TOKEN>` (it cannot set headers) — see {@link PhoneAuthGuard}. */
  @Sse('events')
  stream(): Observable<{ data: PhoneEvent }> {
    return this.events.stream().pipe(map((event) => ({ data: event })));
  }

  private async run(fn: () => Promise<unknown>): Promise<ApiResponse<unknown>> {
    try {
      return ok(await fn());
    } catch (e) {
      return err(errorMessage(e));
    }
  }
}

function errorMessage(e: unknown): string {
  if (e && typeof e === 'object') {
    const anyE = e as { message?: string; code?: number | string; moreInfo?: string };
    const code = anyE.code ? ` (Twilio ${anyE.code})` : '';
    if (anyE.message) return `${anyE.message}${code}`;
  }
  return String(e);
}
