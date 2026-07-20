/**
 * Phone — the Twilio-backed number/voice/SMS feature. One wire contract shared by the desktop UI and
 * the cloud backend that brokers Twilio. Numbers, messages, and calls are owned by Twilio (the source
 * of truth); the backend is a stateless broker + real-time relay, so these types mirror the shapes the
 * backend maps out of the Twilio REST/webhook payloads.
 */

/** Twilio number classes we let users buy. */
export type PhoneNumberType = 'local' | 'mobile' | 'tollFree';

export interface NumberCapabilities {
  voice: boolean;
  sms: boolean;
  mms: boolean;
}

/** A purchasable number returned by a search (not yet owned). */
export interface AvailableNumber {
  /** E.164, e.g. `+14155550123`. */
  phoneNumber: string;
  friendlyName: string;
  /** ISO-3166 alpha-2, e.g. `US`. */
  isoCountry: string;
  locality?: string;
  region?: string;
  capabilities: NumberCapabilities;
  /** Monthly rental from the Pricing API, decimal string e.g. `"1.15"`. Absent if pricing lookup off. */
  monthlyPrice?: string;
  priceUnit?: string;
}

/** A number the account owns (an `IncomingPhoneNumber`). */
export interface OwnedNumber {
  /** Twilio SID, `PN…`. */
  sid: string;
  phoneNumber: string;
  friendlyName: string;
  isoCountry?: string;
  capabilities: NumberCapabilities;
  /** ISO timestamp. */
  dateCreated?: string;
}

export type SmsDirection = 'inbound' | 'outbound';
export type SmsStatus =
  | 'queued'
  | 'sending'
  | 'sent'
  | 'delivered'
  | 'undelivered'
  | 'failed'
  | 'received';

export interface SmsMessage {
  /** Twilio SID, `SM…`/`MM…`. */
  sid: string;
  /** E.164 sender. */
  from: string;
  /** E.164 recipient. */
  to: string;
  body: string;
  direction: SmsDirection;
  status: SmsStatus;
  numMedia: number;
  /** ISO timestamp. */
  dateCreated: string;
}

export type CallDirection = 'inbound' | 'outbound';
export type CallStatus =
  | 'queued'
  | 'ringing'
  | 'in-progress'
  | 'completed'
  | 'busy'
  | 'failed'
  | 'no-answer'
  | 'canceled';

export interface CallLogEntry {
  sid: string;
  from: string;
  to: string;
  direction: CallDirection;
  status: CallStatus;
  /** Seconds; present once the call ends. */
  duration?: number;
  dateCreated: string;
}

/** A short-lived Twilio Voice access token the desktop feeds to the Voice SDK `Device`. */
export interface VoiceToken {
  token: string;
  identity: string;
  /** ISO timestamp when the token expires and must be refreshed. */
  expiresAt: string;
}

/**
 * Real-time events the backend pushes to the desktop over SSE (`GET /phone/events`). Incoming *calls*
 * do NOT come through here — they ring via the Voice SDK's own signaling; this carries SMS + status.
 */
export type PhoneEvent =
  | { type: 'sms.inbound'; message: SmsMessage }
  | { type: 'sms.status'; sid: string; status: SmsStatus; from: string; to: string }
  | {
      type: 'call.status';
      sid: string;
      status: CallStatus;
      direction: CallDirection;
      from: string;
      to: string;
    }
  | { type: 'number.updated' };

/* -------------------------------------------------------------------------------------------------
 * Request payloads (also validated server-side).
 * ---------------------------------------------------------------------------------------------- */

export interface SearchNumbersQuery {
  /** ISO-3166 alpha-2. */
  country: string;
  type?: PhoneNumberType;
  areaCode?: string;
  /** Digit/letter pattern the number should contain (Twilio wildcard search). */
  contains?: string;
  smsEnabled?: boolean;
  voiceEnabled?: boolean;
  limit?: number;
}

export interface BuyNumberInput {
  /** E.164 taken from a search result. */
  phoneNumber: string;
}

export interface SendSmsInput {
  /** An owned E.164 number to send from. */
  from: string;
  /** E.164 recipient. */
  to: string;
  body: string;
}

/** Countries offered in the buy-number picker. `instant` = provisionable without KYC paperwork. */
export interface SupportedCountry {
  iso: string;
  name: string;
  instant: boolean;
}
