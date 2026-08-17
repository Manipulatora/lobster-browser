import { createHash, timingSafeEqual } from 'node:crypto';
import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import type { DepositStatus } from '@lobster/shared-types';

import type { CreatedDeposit, ParsedWebhook, PaymentProvider } from './payment-provider';

const API_BASE = 'https://api.cryptomus.com/v1';

/** The single IP Cryptomus documents as the source of callbacks. Defence in depth, not the boundary. */
export const CRYPTOMUS_WEBHOOK_IP = '91.227.144.54';

/**
 * Our curated deposit code -> Cryptomus `to_currency` + `network`.
 *
 * Cryptomus does not use NOWPayments' single-token codes (`usdtbsc`); it takes an asset and a
 * network separately, both upper-case. This map is the whole translation layer, and it is
 * deliberately explicit rather than derived: a wrong network on a stablecoin sends the user's
 * money to an address on a chain we are not watching, and no amount of cleverness is worth that.
 *
 * `verified` records whether the pair appears in Cryptomus' published service table. The three
 * unverified entries are chains the docs' example table did not cover; `assertServicesCover()`
 * checks the live account before any of them can be used, and `createDeposit` refuses an
 * unverified pair until that check has passed.
 */
interface CryptomusPair {
  currency: string;
  network: string;
  verified: boolean;
}

const PAIRS: Readonly<Record<string, CryptomusPair>> = {
  // Every `verified: true` pair below appears verbatim in Cryptomus' documented service table
  // (doc.cryptomus.com/business/payments/list-of-services). The strings are theirs, not ours.
  usdttrc20: { currency: 'USDT', network: 'TRON', verified: true },
  usdctrc20: { currency: 'USDC', network: 'TRON', verified: true },
  trx: { currency: 'TRX', network: 'TRON', verified: true },
  usdtbsc: { currency: 'USDT', network: 'BSC', verified: true },
  usdcbsc: { currency: 'USDC', network: 'BSC', verified: true },
  bnb: { currency: 'BNB', network: 'BSC', verified: true },
  usdterc20: { currency: 'USDT', network: 'ETH', verified: true },
  usdcerc20: { currency: 'USDC', network: 'ETH', verified: true },
  eth: { currency: 'ETH', network: 'ETH', verified: true },
  usdtmatic: { currency: 'USDT', network: 'POLYGON', verified: true },
  usdcmatic: { currency: 'USDC', network: 'POLYGON', verified: true },
  matic: { currency: 'MATIC', network: 'POLYGON', verified: true },
  btc: { currency: 'BTC', network: 'BTC', verified: true },
  ltc: { currency: 'LTC', network: 'LTC', verified: true },
  doge: { currency: 'DOGE', network: 'DOGE', verified: true },
  bch: { currency: 'BCH', network: 'BCH', verified: true },
  dash: { currency: 'DASH', network: 'DASH', verified: true },
  xmr: { currency: 'XMR', network: 'XMR', verified: true },

  // ABSENT FROM THAT TABLE — which the docs present as an example response, so absence is not
  // proof of non-support. They stay hidden (`supportsCurrency` is false) and unusable until
  // `assertServicesCover()` finds them on the live account; the guessed network strings below are
  // therefore never sent anywhere until that check has vouched for them.
  // SOL on Solana: Cryptomus' own FAQ names both the asset and the network as supported
  // (cryptomus.com/faq/which-assets-and-networks-are-available-for-payment). The SPL stablecoins
  // below are a different claim — that a given TOKEN rides that chain — which no Cryptomus page
  // states, so they stay gated even though the network itself is confirmed.
  sol: { currency: 'SOL', network: 'SOL', verified: true },
  usdcsol: { currency: 'USDC', network: 'SOL', verified: false },
  usdtsol: { currency: 'USDT', network: 'SOL', verified: false },
  usdcbase: { currency: 'USDC', network: 'BASE', verified: false },
  xrp: { currency: 'XRP', network: 'XRP', verified: false },
  ada: { currency: 'ADA', network: 'ADA', verified: false },
  xlm: { currency: 'XLM', network: 'XLM', verified: false },
  dot: { currency: 'DOT', network: 'DOT', verified: false },
  link: { currency: 'LINK', network: 'ETH', verified: false },
};
/**
 * Cryptomus status -> our `DepositStatus`.
 *
 * `paid` and `paid_over` are the only two that mean the money is ours. Everything else either
 * moves toward that or away from it, and nothing else may credit.
 *
 * Three deserve their reasoning written down:
 *  - `wrong_amount_waiting` is an UNDERPAYMENT THE USER CAN STILL TOP UP, so it is `confirming`,
 *    not a failure. `wrong_amount` is the same shortfall with the door shut, so it is `failed`.
 *    Collapsing the two would either strand a user mid-payment or promise a completion that
 *    cannot happen.
 *  - `locked` means the funds arrived and Cryptomus froze them under its AML programme. It is NOT
 *    a success and must never credit; it is also not a failure we can resolve in code, so it maps
 *    to `confirming` and stays visible as an unfinished deposit for a human to chase.
 *  - Cryptomus has no `expired`. `cancel` is "the client did not pay", which after `lifetime`
 *    elapses is what expiry looks like from the processor's side.
 */
const STATUS: Readonly<Record<string, DepositStatus>> = {
  paid: 'confirmed',
  paid_over: 'confirmed',
  process: 'pending',
  check: 'confirming',
  confirm_check: 'confirming',
  wrong_amount_waiting: 'confirming',
  locked: 'confirming',
  wrong_amount: 'failed',
  fail: 'failed',
  system_fail: 'failed',
  refund_process: 'failed',
  refund_fail: 'failed',
  refund_paid: 'failed',
  cancel: 'expired',
};

/**
 * PHP's `json_encode` escapes forward slashes; `JSON.stringify` does not. Cryptomus signs the PHP
 * output, so a payload containing any `/` — a URL we echoed back in `additional_data`, a callback
 * address — verifies only if we reproduce that escaping. Their own docs call this out, and it is
 * the single most common reason a correct-looking Cryptomus integration rejects real webhooks.
 *
 * `JSON_UNESCAPED_UNICODE` (which they do pass) leaves non-ASCII raw, which is already what
 * `JSON.stringify` emits, so no further transform is needed for that half.
 */
function phpJsonEncode(value: unknown): string {
  return JSON.stringify(value).replace(/\//g, '\\/');
}

/** `md5(base64(json(payload)) + apiKey)` — Cryptomus' signature for both requests and webhooks. */
function sign(payloadJson: string, apiKey: string): string {
  return createHash('md5')
    .update(Buffer.from(payloadJson, 'utf8').toString('base64') + apiKey)
    .digest('hex');
}

/**
 * Cryptomus (https://cryptomus.com) as a `PaymentProvider`.
 *
 * TWO THINGS HERE ARE WEAKER THAN THE NOWPAYMENTS IMPLEMENTATION and are properties of Cryptomus'
 * protocol, not choices made here:
 *
 *  1. The webhook MAC is `md5(base64(body) + key)` — a secret-suffix construction over a broken
 *     hash, rather than HMAC-SHA512. It is verified in constant time below, but constant time does
 *     not make MD5 collision-resistant.
 *  2. The signature travels INSIDE the JSON body, so verifying it requires re-serialising the
 *     parsed object. We cannot simply MAC the bytes we received the way the NOWPayments provider
 *     does. Key order survives `JSON.parse`/`JSON.stringify` for string keys, and slashes are
 *     re-escaped above, but this is reconstruction and it is inherently more fragile than signing
 *     the wire bytes.
 *
 * Both are recorded so the next person does not assume the two providers are equally strong.
 */
export class CryptomusProvider implements PaymentProvider {
  readonly name = 'cryptomus';

  private readonly logger = new Logger(CryptomusProvider.name);
  private readonly merchantId: string;
  private readonly paymentKey: string;
  private readonly callbackUrl: string;
  /** Codes proven present on the live account by `assertServicesCover()`. */
  private liveVerified: ReadonlySet<string> | null = null;

  constructor(config: ConfigService) {
    this.merchantId = config.get<string>('CRYPTOMUS_MERCHANT_ID') ?? '';
    this.paymentKey = config.get<string>('CRYPTOMUS_PAYMENT_KEY') ?? '';
    this.callbackUrl = config.get<string>('CRYPTOMUS_CALLBACK_URL') ?? '';
  }

  /**
   * A pair is offerable when Cryptomus lists it and we have either verified it from the published
   * service table or confirmed it against the live account. Unverified pairs stay hidden rather
   * than being shown and then refused inside `createDeposit`.
   */
  supportsCurrency(currencyCode: string): boolean {
    const pair = PAIRS[currencyCode];
    return pair ? pair.verified || this.liveVerified?.has(currencyCode) === true : false;
  }

  isConfigured(): boolean {
    return Boolean(this.merchantId && this.paymentKey);
  }

  /**
   * Check every curated pair against the live `/v1/payment/services` table.
   *
   * Called at startup. It is the only thing that lets an `verified: false` pair be used, and it
   * also catches a pair that Cryptomus later disables (`is_available: false`) — which would
   * otherwise surface as a failed payment at the worst possible moment, with the user already
   * committed.
   */
  async assertServicesCover(): Promise<{ ok: string[]; missing: string[] }> {
    const services = (await this.post<{
      result?: Array<{ currency: string; network: string; is_available: boolean }>;
    }>('/payment/services', {})).result;

    const live = new Set(
      (services ?? [])
        .filter((s) => s.is_available)
        .map((s) => `${s.currency.toUpperCase()}:${s.network.toUpperCase()}`),
    );

    const ok: string[] = [];
    const missing: string[] = [];
    for (const [code, pair] of Object.entries(PAIRS)) {
      (live.has(`${pair.currency}:${pair.network}`) ? ok : missing).push(code);
    }
    this.liveVerified = new Set(ok);
    if (missing.length) {
      this.logger.error(
        `Cryptomus does not offer these curated deposit chains: ${missing.join(', ')} — they will be refused`,
      );
    }
    return { ok, missing };
  }

  async createDeposit(args: {
    amountCents: number;
    currencyCode: string;
    orderId: string;
  }): Promise<CreatedDeposit> {
    const pair = PAIRS[args.currencyCode];
    if (!pair) throw new Error(`no Cryptomus pair for deposit code ${args.currencyCode}`);

    // Fail closed on a chain we have not proven exists. Guessing a network string is how a
    // stablecoin ends up on a chain nobody is watching.
    const proven = pair.verified || this.liveVerified?.has(args.currencyCode);
    if (!proven) {
      throw new Error(
        `deposit chain ${args.currencyCode} (${pair.currency}/${pair.network}) is unconfirmed against the live Cryptomus account`,
      );
    }

    // Price in USD, settle in crypto. `amount` is a decimal STRING — never a float, and never
    // cents. Integer cents -> string dollars is exact; `amountCents / 100` in float is not.
    const dollars = `${Math.trunc(args.amountCents / 100)}.${String(args.amountCents % 100).padStart(2, '0')}`;

    const body: Record<string, unknown> = {
      amount: dollars,
      currency: 'USD',
      to_currency: pair.currency,
      network: pair.network,
      order_id: args.orderId,
      // A short-priced quote is a promise about an exchange rate. An hour is long enough to pay
      // and short enough that the rate we quoted is still roughly the rate we settle at.
      lifetime: 3600,
      // The user must not be able to pay a smaller amount and have it read as complete.
      is_payment_multiple: false,
      accuracy_payment_percent: 1,
    };
    if (this.callbackUrl) body.url_callback = this.callbackUrl;

    const res = await this.post<{ result?: Record<string, unknown> }>('/payment', body);
    const r = res.result;
    if (!r || typeof r.uuid !== 'string' || typeof r.address !== 'string') {
      throw new Error('Cryptomus did not return a payable invoice');
    }

    return {
      providerPaymentId: r.uuid,
      address: r.address,
      amountCrypto: String(r.payer_amount ?? ''),
      asset: String(r.payer_currency ?? pair.currency),
      chain: String(r.network ?? pair.network),
      hostedUrl: typeof r.url === 'string' ? r.url : undefined,
      expiresAt:
        typeof r.expired_at === 'number' ? new Date(r.expired_at * 1000).toISOString() : undefined,
    };
  }

  verifyWebhook(
    rawBody: Buffer,
    _headers: Record<string, string | string[] | undefined>,
  ): ParsedWebhook | null {
    if (!this.paymentKey) {
      this.logger.error('callback received but CRYPTOMUS_PAYMENT_KEY is unset — rejecting');
      return null;
    }

    let payload: Record<string, unknown>;
    try {
      payload = JSON.parse(rawBody.toString('utf8')) as Record<string, unknown>;
    } catch {
      return null;
    }

    const received = payload.sign;
    if (typeof received !== 'string' || received.length === 0) return null;

    // The signature covers the body WITHOUT `sign`. Deleting from the parsed object preserves the
    // order of the remaining keys, which the reconstruction depends on.
    const { sign: _omit, ...signed } = payload;
    const expected = sign(phpJsonEncode(signed), this.paymentKey);

    const a = Buffer.from(expected, 'utf8');
    const b = Buffer.from(received, 'utf8');
    if (a.length !== b.length || !timingSafeEqual(a, b)) {
      this.logger.warn('Cryptomus callback failed signature verification — rejecting');
      return null;
    }

    const rawStatus = String(payload.status ?? '');
    const status = STATUS[rawStatus];
    if (!status) {
      // An unmapped status is not a failure to record — it is a status we do not understand, and
      // guessing it could credit money or discard a live payment. Refuse it loudly instead.
      this.logger.error(`unknown Cryptomus status "${rawStatus}" — refusing to interpret`);
      return null;
    }

    return {
      providerPaymentId: String(payload.uuid ?? ''),
      status,
      creditCents: status === 'confirmed' ? creditableCents(payload, this.logger) : undefined,
      txHash: typeof payload.txid === 'string' ? payload.txid : undefined,
      amountCrypto: typeof payload.payer_amount === 'string' ? payload.payer_amount : undefined,
      raw: payload,
    };
  }

  /** Signed POST. Cryptomus signs the exact JSON body, so the signed string is the one we send. */
  private async post<T>(path: string, body: Record<string, unknown>): Promise<T> {
    const json = phpJsonEncode(body);
    const res = await fetch(`${API_BASE}${path}`, {
      method: 'POST',
      headers: {
        merchant: this.merchantId,
        sign: sign(json, this.paymentKey),
        'Content-Type': 'application/json',
      },
      body: json,
      signal: AbortSignal.timeout(20_000),
    });
    if (!res.ok) {
      throw new Error(`Cryptomus ${path} failed: HTTP ${res.status}`);
    }
    return (await res.json()) as T;
  }
}

/**
 * USD cents to credit for a settled payment.
 *
 * Uses `payment_amount_usd` — what Cryptomus says actually arrived in USD — rather than the amount
 * we invoiced. On `paid_over` the user sent more than asked, and crediting the invoice would keep
 * the difference; on a within-tolerance underpayment (`accuracy_payment_percent`) Cryptomus still
 * settles, and crediting the invoice would hand over value that never arrived. Credit what landed.
 *
 * Floors rather than rounds: a half-cent we cannot represent is not ours to round up.
 */
function creditableCents(payload: Record<string, unknown>, logger: Logger): number {
  const usd = Number(payload.payment_amount_usd);
  if (!Number.isFinite(usd) || usd <= 0) {
    logger.error(
      `settled Cryptomus payment ${String(payload.uuid)} has no usable payment_amount_usd — crediting 0`,
    );
    return 0;
  }
  return Math.floor(usd * 100);
}
