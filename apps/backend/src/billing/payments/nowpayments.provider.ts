import {
  BadRequestException,
  Injectable,
  Logger,
  ServiceUnavailableException,
  type OnModuleInit,
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import type { DepositStatus } from '@lobster/shared-types';

import type { CreatedDeposit, ParsedWebhook, PaymentProvider } from './payment-provider';

const API_BASE = 'https://api.nowpayments.io/v1';

/** How long a loaded currency list is trusted before a background refresh is triggered. */
const CURRENCY_TTL_MS = 60 * 60 * 1000;

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
export class NowPaymentsProvider implements PaymentProvider, OnModuleInit {
  readonly name = 'nowpayments';

  private readonly logger = new Logger(NowPaymentsProvider.name);
  private readonly apiKey: string;
  private readonly ipnSecret: string;
  private readonly ipnCallbackUrl: string;
  private readonly feePaidByUser: boolean;
  private readonly fixedRate: boolean;

  /** null until the first successful load — see `supportsCurrency` for why that means "allow". */
  private currencies: Set<string> | null = null;
  private currenciesFetchedAt = 0;
  private currenciesInFlight = false;

  constructor(config: ConfigService) {
    this.apiKey = config.get<string>('NOWPAYMENTS_API_KEY') ?? '';
    this.ipnSecret = config.get<string>('NOWPAYMENTS_IPN_SECRET') ?? '';
    this.ipnCallbackUrl = config.get<string>('NOWPAYMENTS_IPN_CALLBACK_URL') ?? '';
    // Both default OFF, and are only sent when switched on.
    //
    // `is_fee_paid_by_user` shifts the processor's commission onto the customer.
    // `is_fixed_rate` locks the quoted crypto→USD rate for the payment window.
    this.feePaidByUser = config.get<string>('NOWPAYMENTS_FEE_PAID_BY_USER') === 'true';
    this.fixedRate = config.get<string>('NOWPAYMENTS_FIXED_RATE') === 'true';
  }

  isConfigured(): boolean {
    return this.apiKey.length > 0 && this.ipnSecret.length > 0;
  }

  /** Warm the currency list at boot so the first deposit page does not race the first fetch. */
  onModuleInit(): void {
    if (this.isConfigured()) void this.refreshCurrencies();
  }

  /**
   * Is this rail actually on offer right now?
   *
   * CHECKED AGAINST THE PROCESSOR, not assumed. This used to answer `isConfigured()` for every
   * code — i.e. "yes" — and the first time it was checked for real, four of the catalogue's
   * codes turned out not to exist at NOWPayments at all. Each would have rendered as a deposit
   * option and failed only after the user picked it and committed to an amount.
   *
   * FAIL OPEN, DELIBERATELY. If the list has not loaded — first call, or their API is down — this
   * returns true rather than hiding every rail. The catalogue is verified, `createDeposit` still
   * fails closed against the live API, and an outage at NOWPayments taking our deposit page from
   * "some rails are missing" to "deposits appear impossible" is the worse of the two failures.
   */
  supportsCurrency(currencyCode: string): boolean {
    if (!this.isConfigured()) return false;
    if (Date.now() - this.currenciesFetchedAt > CURRENCY_TTL_MS) void this.refreshCurrencies();
    return this.currencies === null || this.currencies.has(currencyCode.toLowerCase());
  }

  /**
   * Reload the supported-currency list.
   *
   * `GET /v1/currencies` is unauthenticated and returns `{ currencies: string[] }` — the
   * platform-wide list. The per-account list lives behind `/v1/merchant/coins`, which would be
   * the stricter check; it is not used here because its response shape has not been observed
   * against a real account, and guessing at a schema is what put a wrong field name in the
   * payment request in the first place.
   */
  private async refreshCurrencies(): Promise<void> {
    if (this.currenciesInFlight) return;
    this.currenciesInFlight = true;
    // Stamped BEFORE the request, not after: on a failure this is what stops every call to
    // `supportsCurrency` from starting another one against an API that is already struggling.
    this.currenciesFetchedAt = Date.now();
    try {
      const res = await fetch(`${API_BASE}/currencies`, {
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = (await res.json()) as { currencies?: unknown };
      if (!Array.isArray(json.currencies)) throw new Error('no currencies array in response');
      this.currencies = new Set(json.currencies.map((c) => String(c).toLowerCase()));
      this.logger.log(`loaded ${this.currencies.size} supported currencies`);
    } catch (err) {
      // Left as-is: a stale list beats an empty one, and null keeps the fail-open path.
      this.logger.warn(
        `could not refresh the currency list (${err instanceof Error ? err.message : String(err)})` +
          ' — every catalogue rail stays offerable until it loads',
      );
    } finally {
      this.currenciesInFlight = false;
    }
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
    if (this.fixedRate) body.is_fixed_rate = true;

    const res = await fetch(`${API_BASE}/payment`, {
      method: 'POST',
      headers: { 'x-api-key': this.apiKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      this.logger.error(`createDeposit failed: HTTP ${res.status} ${detail.slice(0, 300)}`);

      // A 400 here is nearly always the amount being under this coin's minimum, which varies by
      // coin and moves with its price — so it is the user's to fix, and telling them "could not
      // create a deposit address" strands them with no idea what to change. The processor's own
      // message names the real limit; it is forwarded only for the below-minimum case, because
      // their other errors can carry account context.
      if (res.status === 400 && /minimal|minimum|too small/i.test(detail)) {
        throw new BadRequestException(
          `That amount is below the minimum for this coin. ${extractMinimumHint(detail)}`.trim(),
        );
      }
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
 * Pull the stated minimum out of a NOWPayments 400 so the user is told the number, not just that
 * one exists. Their message reads like `minimalAmount is 8.5 usdtbsc`; anything that does not
 * match yields an empty string and the caller's sentence stands on its own.
 */
function extractMinimumHint(detail: string): string {
  const match = /minimal\w*\s*(?:amount)?\s*(?:is|:)?\s*([0-9]*\.?[0-9]+)\s*([a-z0-9]+)?/i.exec(
    detail,
  );
  if (!match) return '';
  const [, amount, asset] = match;
  return `The minimum is ${amount}${asset ? ` ${asset.toUpperCase()}` : ''}.`;
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
