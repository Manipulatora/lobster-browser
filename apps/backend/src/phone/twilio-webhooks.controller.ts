import {
  Body,
  Controller,
  ForbiddenException,
  Header,
  Headers,
  HttpCode,
  Post,
  Query,
  Req,
} from '@nestjs/common';

import { PhoneEventsService } from './phone-events.service';
import { TwilioService } from './twilio.service';

import type { CallDirection, CallStatus, SmsStatus } from '@lobster/shared-types';

/** Minimal request shape (avoids an @types/express dependency), matching api-key.guard's approach. */
interface WebhookRequest {
  originalUrl: string;
}

type TwilioBody = Record<string, string>;

/**
 * Public endpoints Twilio POSTs to (voice + SMS + status). NOT behind PhoneAuthGuard — Twilio can't
 * send our bearer token — so each request is verified by the shared secret baked into the webhook URL
 * (`?k=`), and additionally by the real `X-Twilio-Signature` when an Auth Token is configured.
 *
 * Voice/SMS-inbound return TwiML (XML). Status callbacks just fan out a real-time event and 204.
 */
@Controller('twilio')
export class TwilioWebhooksController {
  constructor(
    private readonly twilio: TwilioService,
    private readonly events: PhoneEventsService,
  ) {}

  @Post('voice/outbound')
  @Header('Content-Type', 'text/xml')
  outboundVoice(
    @Body() body: TwilioBody,
    @Query('k') k: string,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: WebhookRequest,
  ): string {
    this.assertAuthentic(req, body, k, signature);
    return this.twilio.outboundVoiceTwiml(body);
  }

  @Post('voice/inbound')
  @Header('Content-Type', 'text/xml')
  inboundVoice(
    @Body() body: TwilioBody,
    @Query('k') k: string,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: WebhookRequest,
  ): string {
    this.assertAuthentic(req, body, k, signature);
    return this.twilio.inboundVoiceTwiml(body);
  }

  @Post('sms/inbound')
  @Header('Content-Type', 'text/xml')
  inboundSms(
    @Body() body: TwilioBody,
    @Query('k') k: string,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: WebhookRequest,
  ): string {
    this.assertAuthentic(req, body, k, signature);
    this.events.emit({
      type: 'sms.inbound',
      message: {
        sid: body.MessageSid ?? body.SmsSid ?? '',
        from: body.From ?? '',
        to: body.To ?? '',
        body: body.Body ?? '',
        direction: 'inbound',
        status: 'received',
        numMedia: Number(body.NumMedia ?? 0),
        dateCreated: new Date().toISOString(),
      },
    });
    return this.twilio.emptyMessagingTwiml();
  }

  @Post('status/sms')
  @HttpCode(204)
  smsStatus(
    @Body() body: TwilioBody,
    @Query('k') k: string,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: WebhookRequest,
  ): void {
    this.assertAuthentic(req, body, k, signature);
    this.events.emit({
      type: 'sms.status',
      sid: body.MessageSid ?? body.SmsSid ?? '',
      status: (body.MessageStatus ?? body.SmsStatus ?? 'sent') as SmsStatus,
      from: body.From ?? '',
      to: body.To ?? '',
    });
  }

  @Post('status/call')
  @HttpCode(204)
  callStatus(
    @Body() body: TwilioBody,
    @Query('k') k: string,
    @Headers('x-twilio-signature') signature: string,
    @Req() req: WebhookRequest,
  ): void {
    this.assertAuthentic(req, body, k, signature);
    this.events.emit({
      type: 'call.status',
      sid: body.CallSid ?? '',
      status: (body.CallStatus ?? 'completed') as CallStatus,
      direction: String(body.Direction ?? '').startsWith('inbound')
        ? 'inbound'
        : ('outbound' as CallDirection),
      from: body.From ?? '',
      to: body.To ?? '',
    });
  }

  private assertAuthentic(
    req: WebhookRequest,
    body: TwilioBody,
    urlSecret: string,
    signature: string,
  ): void {
    const ok = this.twilio.verifyWebhook({
      signature,
      originalUrl: req.originalUrl,
      params: body,
      urlSecret,
    });
    if (!ok) throw new ForbiddenException('webhook verification failed');
  }
}
