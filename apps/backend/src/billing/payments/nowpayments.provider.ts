import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { DepositStatus } from '@lobster/shared-types';

import type { CreatedDeposit, ParsedWebhook, PaymentProvider } from './payment-provider';

const API_BASE = 'https://api.nowpayments.io/v1';

/**
 * NOWPayments payment statuses, and what each means for a Credit deposit.
 *
 * The distinction that matters is `confirmed` vs `finished`. NOWPayments uses `confirmed` for
 * "the blockchain has confirmed the transaction" and `finished` for "the funds have settled to
 * the merchant account". Only the latter is money we actually hold, so `finished` is the single
 * status that mints Credit — crediting on `confirmed` would hand out balance for a payment that
 * can still fail during settlement.
 *
 * `partially_paid` maps to `confirming`, not to a terminal state: the user underpaid, the payment
 * is still open, and NOWPayments will move it to `finished` once the remainder arrives or the
 * merchant accepts it. Treating it as a failure would strand real money.
 */
const STATUS_MAP: Record<string, DepositStatus> = {
  waiting: 'pending',
  confirming: 'confirming',
  confirmed: 'confirming',
  sending: 'confirming',
  partially_paid: 'confirming',
  finished: 'confirmed',
  failed: 'failed',
  refunded: 'failed',
  expired: 'expired',
};

/**
 * NOWPayments (https://nowpayments.io) — the project's payment processor.
 *
 * ON FEES, because it is the reason this processor was chosen and the reason it is worth knowing
 * what it cannot fix. NOWPayments takes a percentage of the payment. The NETWORK fee — what the
 * user's wallet pays to broadcast — is not theirs and not ours: a USDT transfer costs fractions
 * of a cent on BSC and over a dollar on Tron because of how the two chains price execution, and
 * that gap is identical at every processor. It is addressed in the deposit UI by showing the cost
 * per chain and defaulting to a cheap one, not here. See `deposit-chains.ts`.
 */
@Injectable()
export class NowPaymentsProvider implements PaymentProvider {
  readonly name = 'nowpayments';

  private readonly logger = new Logger(NowPaymentsProvider.name);
  private readonly apiKey: string;
  private readonly ipnSecret: string;
  private readonly ipnCallbackUrl: string;
  private readonly feePaidByUser: boolean;
  private readonly fixedRate: boolean;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('NOWPAYMENTS_API_KEY') ?? '';
    this.ipnSecret = config.get<string>('NOWPAYMENTS_IPN_SECRET') ?? '';
    this.ipnCallbackUrl = config.get<string>('NOWPAYMENTS_IPN_CALLBACK_URL') ?? '';
    // Both default OFF, and are only sent when switched on.
    //
    // These two request fields could not be confirmed against a live spec at build time (the
    // Postman documentation renders client-side and the public OpenAPI excerpt omits request
    // bodies). Defaulting them off means the request we send by default contains only fields
    // verified from the response schema; if a name turns out to be wrong, the failure appears
    // when an operator opts in, not on every payment. Confirm both against the account's own API
    // reference before enabling.
    //
    // `is_fee_paid_by_user` shifts the processor's commission onto the customer.
    // `fixed_rate` locks the quoted crypto→USD rate for the payment window.
    this.feePaidByUser = config.get<string>('NOWPAYMENTS_FEE_PAID_BY_USER') === 'true';
    this.fixedRate = config.get<string>('NOWPAYMENTS_FIXED_RATE') === 'true';
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.ipnSecret.length > 0;
  }

  async createDeposit(args: {
    amountCents: number;
    currencyCode: string;
    orderId: string;
  }): Promise<CreatedDeposit> {
    if (!this.isConfigured()) {
      throw new ServiceUnavailableException('crypto payments are not configured');
    }

    const body: Record<string, unknown> = {
      price_amount: args.amountCents / 100,
      price_currency: 'usd',
      pay_currency: args.currencyCode,
      order_id: args.orderId,
      order_description: 'Lobster Browser Credit',
    };
    if (this.ipnCallbackUrl) body.ipn_callback_url = this.ipnCallbackUrl;
    if (this.feePaidByUser) body.is_fee_paid_by_user = true;
    if (this.fixedRate) body.fixed_rate = true;

    const res = await fetch(`${API_BASE}/payment`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      // Log the processor's own message (it names the actual problem — unsupported currency,
      // below minimum amount) but do not surface it: it can contain account context.
      this.logger.error(`createDeposit failed: HTTP ${res.status} ${detail.slice(0, 300)}`);
      throw new ServiceUnavailableException('could not create a deposit address');
    }

    const json = (await res.json()) as Record<string, unknown>;
    const address = String(json.pay_address ?? '');
    const paymentId = String(json.payment_id ?? '');
    if (!address || !paymentId) {
      this.logger.error(`createDeposit: malformed response ${JSON.stringify(json).slice(0, 300)}`);
      throw new ServiceUnavailableException('could not create a deposit address');
    }

    return {
      providerPaymentId: paymentId,
      address,
      // String, never Number: `pay_amount` can carry more precision than a double holds exactly,
      // and this value is what the user is told to send.
      amountCrypto: String(json.pay_amount ?? ''),
      asset: String(json.pay_currency ?? args.currencyCode).toUpperCase(),
      chain: args.currencyCode,
      hostedUrl: typeof json.invoice_url === 'string' ? json.invoice_url : undefined,
    };
  }

  /**
   * Verify an IPN callback.
   *
   * THE ALGORITHM, which is unusual and worth stating exactly: NOWPayments does not sign the raw
   * bytes it sent. It signs `JSON.stringify(<payload with every object's keys sorted,
   * recursively>)`, HMAC-SHA512, hex, keyed with the IPN secret, in `x-nowpayments-sig`.
   *
   * So verification has to PARSE the body, re-sort it, and re-serialise it — meaning the
   * comparison depends on this process's `JSON.stringify` producing the same text theirs did.
   * That is the realistic failure mode here, and it is a numeric one: a value they emit as `5.0`
   * re-serialises from a JS number as `5`, and the signature will not match. It has not been
   * observed against the live API, and there is no way to defend against it without them signing
   * raw bytes, so the mismatch path logs enough to identify it immediately rather than leaving a
   * silent "all callbacks rejected" outage to be diagnosed from nothing.
   */
  verifyWebhook(
    rawBody: Buffer,
    headers: Record<string, string | string[] | undefined>,
  ): ParsedWebhook | null {
    if (!this.ipnSecret) {
      this.logger.error('IPN received but NOWPAYMENTS_IPN_SECRET is unset — rejecting');
      return null;
    }

    const header = headers['x-nowpayments-sig'];
    const received = Array.isArray(header) ? header[0] : header;
    if (!received) return null;

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }

    const expected = createHmac('sha512', this.ipnSecret)
      .update(JSON.stringify(sortDeep(payload)))
      .digest('hex');

    // Constant-time compare. A plain `===` leaks, through timing, how many leading characters of
    // a guess were right, which is enough to forge a signature byte by byte over many attempts.
    // The length check first is required because timingSafeEqual throws on unequal lengths — and
    // length is not a secret.
    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn(
        `IPN signature mismatch for payment_id=${String(payload.payment_id ?? '?')} ` +
          `(expected ${expected.slice(0, 12)}…, got ${received.slice(0, 12)}…) — ` +
          'if EVERY callback is landing here, suspect JSON number re-serialisation, not an attacker',
      );
      return null;
    }

    const rawStatus = String(payload.payment_status ?? '');
    const status = STATUS_MAP[rawStatus];
    if (!status) {
      this.logger.warn(`IPN with unknown payment_status "${rawStatus}" — ignoring`);
      return null;
    }

    return {
      providerPaymentId: String(payload.payment_id ?? ''),
      status,
      creditCents: status === 'confirmed' ? creditableCents(payload) : undefined,
      txHash: typeof payload.payin_hash === 'string' ? payload.payin_hash : undefined,
      amountCrypto:
        payload.actually_paid !== undefined && payload.actually_paid !== null
          ? String(payload.actually_paid)
          : undefined,
      raw: payload,
    };
  }
}

/**
 * How much Credit a settled payment is worth, in USD cents.
 *
 * Credited GROSS — the user gets the full USD value of what they sent, and the processor's
 * commission is our cost rather than a silent haircut on their balance. Someone who deposits $50
 * expects to see $50 of Credit; anything else turns every deposit into a support question. (If
 * that trade is ever unwanted, `NOWPAYMENTS_FEE_PAID_BY_USER=true` moves the commission onto the
 * customer at checkout, where it is visible, instead of hiding it here.)
 *
 * The ratio handles under- and overpayment in one expression. `price_amount` is the USD the
 * payment was quoted at and `pay_amount` the crypto that corresponds to it, so scaling by
 * `actually_paid / pay_amount` converts whatever actually arrived into USD at the quoted rate.
 * Send half, get half; send extra, get the extra.
 */
function creditableCents(payload: Record<string, unknown>): number {
  const priceUsd = Number(payload.price_amount ?? 0);
  const payAmount = Number(payload.pay_amount ?? 0);
  const actuallyPaid = Number(payload.actually_paid ?? 0);

  if (!Number.isFinite(priceUsd) || priceUsd <= 0) return 0;

  // A `finished` payment with no usable pay_amount/actually_paid is the ordinary exact-payment
  // case on some responses; fall back to the quoted price rather than crediting zero.
  if (!Number.isFinite(payAmount) || payAmount <= 0) return Math.round(priceUsd * 100);
  if (!Number.isFinite(actuallyPaid) || actuallyPaid <= 0) return Math.round(priceUsd * 100);

  return Math.round((priceUsd * actuallyPaid * 100) / payAmount);
}

/**
 * Recursively sort object keys. Arrays keep their order — order is meaningful in an array, and
 * NOWPayments does not reorder them either.
 */
function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key]);
  return out;
}
