import { createHmac, timingSafeEqual } from 'node:crypto';

import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import twilio from 'twilio';
import type { Twilio } from 'twilio';

import type {
  AvailableNumber,
  OwnedNumber,
  PhoneNumberType,
  SearchNumbersQuery,
  SmsMessage,
  VoiceToken,
} from '@lobster/shared-types';

/**
 * Thin, typed wrapper around the Twilio REST API + JWT/TwiML helpers. Holds the single operator's
 * credentials (env only — never persisted, never sent to the client) and is the ONLY place that talks
 * to Twilio. Numbers/messages live in Twilio; this service just maps them to our wire types.
 */
@Injectable()
export class TwilioService {
  private readonly logger = new Logger(TwilioService.name);
  private client: Twilio | null = null;

  constructor(private readonly config: ConfigService) {}

  // ---- config -------------------------------------------------------------------------------

  private env(key: string): string | undefined {
    const v = this.config.get<string>(key);
    return v && v.trim() ? v.trim() : undefined;
  }

  private require(key: string): string {
    const v = this.env(key);
    if (!v) throw new ServiceUnavailableException(`Twilio not configured: ${key} is unset`);
    return v;
  }

  /** True when the minimum env for REST + tokens is present. Surfaced by GET /phone/status. */
  isConfigured(): boolean {
    return Boolean(
      this.env('TWILIO_ACCOUNT_SID') &&
        this.env('TWILIO_API_KEY_SID') &&
        this.env('TWILIO_API_KEY_SECRET'),
    );
  }

  configStatus(): Record<string, boolean> {
    return {
      accountSid: Boolean(this.env('TWILIO_ACCOUNT_SID')),
      apiKey: Boolean(this.env('TWILIO_API_KEY_SID') && this.env('TWILIO_API_KEY_SECRET')),
      twimlApp: Boolean(this.env('TWILIO_TWIML_APP_SID')),
      publicBaseUrl: Boolean(this.env('PUBLIC_BASE_URL')),
      webhookSignatureValidation: Boolean(this.env('TWILIO_AUTH_TOKEN')),
    };
  }

  private rest(): Twilio {
    if (this.client) return this.client;
    this.client = twilio(this.require('TWILIO_API_KEY_SID'), this.require('TWILIO_API_KEY_SECRET'), {
      accountSid: this.require('TWILIO_ACCOUNT_SID'),
    });
    return this.client;
  }

  private publicBaseUrl(): string {
    return this.require('PUBLIC_BASE_URL').replace(/\/+$/, '');
  }

  private webhookSecret(): string {
    return this.env('TWILIO_WEBHOOK_SECRET') ?? '';
  }

  clientIdentity(): string {
    return this.env('PHONE_CLIENT_IDENTITY') ?? 'operator';
  }

  /** Webhook URL for a number, carrying the shared secret so spoofed posts are rejected. */
  private webhookUrl(path: string): string {
    const secret = this.webhookSecret();
    const q = secret ? `?k=${encodeURIComponent(secret)}` : '';
    return `${this.publicBaseUrl()}${path}${q}`;
  }

  // ---- numbers ------------------------------------------------------------------------------

  async searchAvailable(query: SearchNumbersQuery): Promise<AvailableNumber[]> {
    const country = query.country.toUpperCase();
    const type: PhoneNumberType = query.type ?? 'local';
    const kind = this.rest().availablePhoneNumbers(country);
    const opts = {
      ...(query.areaCode ? { areaCode: Number(query.areaCode) } : {}),
      ...(query.contains ? { contains: query.contains } : {}),
      smsEnabled: query.smsEnabled ?? true,
      voiceEnabled: query.voiceEnabled ?? true,
      limit: Math.min(Math.max(query.limit ?? 20, 1), 50),
    };
    // Call `.list()` on the concrete subresource (the three have distinct types, so a shared `list`
    // variable would be a non-callable union).
    const found =
      type === 'mobile'
        ? await kind.mobile.list(opts)
        : type === 'tollFree'
          ? await kind.tollFree.list(opts)
          : await kind.local.list(opts);
    const rows = found as unknown as AvailableRow[];

    const prices = await this.numberPrices(country).catch(() => ({}) as Record<string, string>);
    return rows.map((n) => ({
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName ?? n.phoneNumber,
      isoCountry: n.isoCountry ?? country,
      ...(n.locality ? { locality: n.locality } : {}),
      ...(n.region ? { region: n.region } : {}),
      capabilities: normalizeCaps(n.capabilities),
      ...(prices[type] ? { monthlyPrice: prices[type], priceUnit: prices.__unit } : {}),
    }));
  }

  /** Best-effort monthly rental prices per number type; empty if the Pricing API is unavailable. */
  private async numberPrices(country: string): Promise<Record<string, string>> {
    const p = await this.rest().pricing.v1.phoneNumbers.countries(country).fetch();
    const out: Record<string, string> = { __unit: p.priceUnit ?? 'USD' };
    for (const row of p.phoneNumberPrices ?? []) {
      const key = String(row.numberType ?? '').toLowerCase();
      const price = String(row.currentPrice ?? row.basePrice ?? '');
      if (key === 'local') out.local = price;
      else if (key === 'mobile') out.mobile = price;
      else if (key === 'toll free' || key === 'tollfree' || key === 'toll_free') out.tollFree = price;
    }
    return out;
  }

  async buyNumber(phoneNumber: string): Promise<OwnedNumber> {
    const n = await this.rest().incomingPhoneNumbers.create({
      phoneNumber,
      voiceUrl: this.webhookUrl('/twilio/voice/inbound'),
      voiceMethod: 'POST',
      statusCallback: this.webhookUrl('/twilio/status/call'),
      statusCallbackMethod: 'POST',
      smsUrl: this.webhookUrl('/twilio/sms/inbound'),
      smsMethod: 'POST',
    });
    return this.mapOwned(n);
  }

  async listOwned(): Promise<OwnedNumber[]> {
    const list = await this.rest().incomingPhoneNumbers.list({ limit: 100 });
    return list.map((n) => this.mapOwned(n));
  }

  async releaseNumber(sid: string): Promise<void> {
    await this.rest().incomingPhoneNumbers(sid).remove();
  }

  private mapOwned(n: {
    sid: string;
    phoneNumber: string;
    friendlyName?: string | null;
    capabilities?: unknown;
    dateCreated?: Date | null;
  }): OwnedNumber {
    return {
      sid: n.sid,
      phoneNumber: n.phoneNumber,
      friendlyName: n.friendlyName ?? n.phoneNumber,
      capabilities: normalizeCaps(n.capabilities),
      ...(n.dateCreated ? { dateCreated: new Date(n.dateCreated).toISOString() } : {}),
    };
  }

  // ---- messaging ----------------------------------------------------------------------------

  async sendSms(from: string, to: string, body: string): Promise<SmsMessage> {
    const m = await this.rest().messages.create({
      from,
      to,
      body,
      statusCallback: this.webhookUrl('/twilio/status/sms'),
    });
    return mapMessage(m);
  }

  /** Message history for one owned number (both directions), newest first. */
  async listMessages(ownedNumber: string, limit = 200): Promise<SmsMessage[]> {
    const [inbound, outbound] = await Promise.all([
      this.rest().messages.list({ to: ownedNumber, limit }),
      this.rest().messages.list({ from: ownedNumber, limit }),
    ]);
    return [...inbound, ...outbound]
      .map(mapMessage)
      .sort((a, b) => Date.parse(a.dateCreated) - Date.parse(b.dateCreated));
  }

  // ---- voice tokens + TwiML -----------------------------------------------------------------

  createVoiceToken(identity: string, ttlSeconds = 3600): VoiceToken {
    const AccessToken = twilio.jwt.AccessToken;
    const VoiceGrant = AccessToken.VoiceGrant;
    const token = new AccessToken(
      this.require('TWILIO_ACCOUNT_SID'),
      this.require('TWILIO_API_KEY_SID'),
      this.require('TWILIO_API_KEY_SECRET'),
      { identity, ttl: ttlSeconds },
    );
    token.addGrant(
      new VoiceGrant({
        outgoingApplicationSid: this.require('TWILIO_TWIML_APP_SID'),
        incomingAllow: true,
      }),
    );
    return {
      token: token.toJwt(),
      identity,
      expiresAt: new Date(Date.now() + ttlSeconds * 1000).toISOString(),
    };
  }

  /** TwiML for an OUTBOUND call the SDK client places: bridge to the dialed PSTN number. */
  outboundVoiceTwiml(params: { From?: string; To?: string }): string {
    const response = new twilio.twiml.VoiceResponse();
    const to = (params.To ?? '').trim();
    const callerId = (params.From ?? '').trim();
    if (!to || !callerId) {
      response.say('Call could not be completed: missing number.');
      return response.toString();
    }
    const dial = response.dial({ callerId, answerOnBridge: true });
    dial.number(to);
    return response.toString();
  }

  /** TwiML for an INBOUND PSTN call: ring the connected SDK client, tagging which line + caller. */
  inboundVoiceTwiml(params: { From?: string; To?: string }): string {
    const response = new twilio.twiml.VoiceResponse();
    const dial = response.dial({ answerOnBridge: true });
    const client = dial.client();
    client.identity(this.clientIdentity());
    client.parameter({ name: 'line', value: params.To ?? '' });
    client.parameter({ name: 'caller', value: params.From ?? '' });
    return response.toString();
  }

  emptyMessagingTwiml(): string {
    return new twilio.twiml.MessagingResponse().toString();
  }

  // ---- webhook authenticity -----------------------------------------------------------------

  /**
   * Verify a webhook is really from Twilio. Prefers the real `X-Twilio-Signature` (needs the account
   * Auth Token); falls back to the shared secret baked into the webhook URL (`?k=`) so validation
   * still works with API-key-only credentials.
   */
  verifyWebhook(input: {
    signature?: string;
    originalUrl: string;
    params: Record<string, unknown>;
    urlSecret?: string;
  }): boolean {
    const authToken = this.env('TWILIO_AUTH_TOKEN');
    if (authToken && input.signature) {
      const url = `${this.publicBaseUrl()}${input.originalUrl}`;
      return twilio.validateRequest(authToken, input.signature, url, input.params);
    }
    const expected = this.webhookSecret();
    if (!expected) return true; // no secret configured → don't hard-fail local/dev
    return safeEqual(input.urlSecret ?? '', expected);
  }
}

/** Structural view of the fields we read off an available-number instance (any of local/mobile/tollFree). */
interface AvailableRow {
  phoneNumber: string;
  friendlyName?: string | null;
  isoCountry?: string | null;
  locality?: string | null;
  region?: string | null;
  capabilities?: unknown;
}

function normalizeCaps(cap: unknown): { voice: boolean; sms: boolean; mms: boolean } {
  const c = (cap ?? {}) as Record<string, unknown>;
  const bool = (...keys: string[]): boolean => keys.some((k) => c[k] === true);
  return {
    voice: bool('voice', 'Voice'),
    sms: bool('sms', 'SMS'),
    mms: bool('mms', 'MMS'),
  };
}

function mapMessage(m: {
  sid: string;
  from?: string | null;
  to?: string | null;
  body?: string | null;
  direction?: string | null;
  status?: string | null;
  numMedia?: string | number | null;
  dateCreated?: Date | null;
}): SmsMessage {
  const direction = String(m.direction ?? '').startsWith('inbound') ? 'inbound' : 'outbound';
  return {
    sid: m.sid,
    from: m.from ?? '',
    to: m.to ?? '',
    body: m.body ?? '',
    direction,
    status: (m.status as SmsMessage['status']) ?? (direction === 'inbound' ? 'received' : 'sent'),
    numMedia: Number(m.numMedia ?? 0),
    dateCreated: m.dateCreated ? new Date(m.dateCreated).toISOString() : new Date(0).toISOString(),
  };
}

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

// Reserved for signing our own callback URLs if we later add per-number webhook secrets.
export function signPath(secret: string, path: string): string {
  return createHmac('sha256', secret).update(path).digest('hex').slice(0, 16);
}
