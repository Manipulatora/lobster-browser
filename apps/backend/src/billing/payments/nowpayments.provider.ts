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

  /**
   * null until the first successful load — see `supportsCurrency` for why that means "allow".
   * A successful load is never empty; `refreshCurrencies` treats an empty list as a failure, so
   * this is either null or a list the processor actually stood behind.
   */
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
   * THE SOURCE IS THE ACCOUNT'S LIST, NOT THE PLATFORM'S. `GET /v1/merchant/coins`, authenticated
   * with the API key, answers `{ selectedCurrencies: string[] }` with UPPERCASE codes (356 of them
   * at the time of writing) — the coins THIS merchant account has switched on, which is precisely
   * what governs whether `createDeposit` will be accepted. An earlier revision read the
   * unauthenticated platform-wide `/v1/currencies` instead and said so in this comment, on the
   * grounds that the merchant shape had not been observed against a real account. It has been now,
   * hence the swap; the codes are lowercased on the way into the Set because the rest of this class
   * and the catalogue in `deposit-chains.ts` are lowercase.
   *
   * `/v1/currencies` REMAINS THE FALLBACK. It is a looser check — a platform-wide superset that can
   * name coins this account does not offer — but a superset still filters out codes that do not
   * exist at all, which is the failure it was added to catch, and the two endpoints have been seen
   * failing independently rather than together.
   *
   * AN EMPTY LIST IS A FAILED REFRESH, NOT AN ANSWER OF "NONE". `/v1/currencies` has been observed
   * replying `200 {"currencies":[]}` — well-formed, and claiming the processor supports no coin at
   * all. An API that answers 200 with nothing is indistinguishable from an outage, and the safe
   * reading is "unknown", not "none": a payment processor whose account can take money always has
   * coins. Read literally it is also the worst possible value to store, because it defeats the
   * safety net rather than tripping it — an empty Set is not null, so `supportsCurrency`'s
   * documented fail-open never fires, every catalogue code returns false, and the deposit page
   * renders with zero rails. So an empty list throws like any other bad response: whatever list was
   * already loaded is kept, a first-ever load stays null so the fail-open applies, and it is logged.
   */
  private async refreshCurrencies(): Promise<void> {
    if (this.currenciesInFlight) return;
    this.currenciesInFlight = true;
    // Stamped BEFORE the request, not after: on a failure this is what stops every call to
    // `supportsCurrency` from starting another one against an API that is already struggling.
    // It covers the fallback too — one stamp per refresh, however many endpoints it took.
    this.currenciesFetchedAt = Date.now();
    try {
      let source = 'merchant/coins';
      let codes: string[];
      try {
        codes = await this.fetchCurrencyList('/merchant/coins', 'selectedCurrencies', true);
      } catch (primaryErr) {
        this.logger.warn(
          'merchant/coins did not yield a currency list ' +
            `(${primaryErr instanceof Error ? primaryErr.message : String(primaryErr)})` +
            ' — falling back to the platform-wide /currencies',
        );
        source = 'currencies';
        codes = await this.fetchCurrencyList('/currencies', 'currencies', false);
      }
      this.currencies = new Set(codes);
      this.logger.log(`loaded ${this.currencies.size} supported currencies from ${source}`);
    } catch (err) {
      // Left as-is: a stale list beats an empty one, and null keeps the fail-open path. This is
      // also where the empty-list case lands, deliberately — see the note above.
      this.logger.warn(
        `could not refresh the currency list (${err instanceof Error ? err.message : String(err)})` +
          ' — the previously loaded list stands, or every catalogue rail stays offerable if none has loaded yet',
      );
    } finally {
      this.currenciesInFlight = false;
    }
  }

  /**
   * Read one currency-list endpoint, strictly.
   *
   * Returns lowercased codes, or throws. Everything short of a non-empty array of usable codes is
   * a throw — a non-OK status, a missing field, a field that is not an array, and an array with
   * nothing in it — so that the caller has exactly one thing to decide: fall back, or keep the
   * list it already has. `refreshCurrencies` explains why the empty case belongs in that set.
   */
  private async fetchCurrencyList(
    path: string,
    field: string,
    authenticated: boolean,
  ): Promise<string[]> {
    const res = await fetch(`${API_BASE}${path}`, {
      headers: authenticated ? { 'x-api-key': this.apiKey } : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${path}`);
    const json = (await res.json()) as Record<string, unknown>;
    const list = json[field];
    if (!Array.isArray(list)) throw new Error(`no ${field} array in the ${path} response`);
    // Filtered to strings BEFORE mapping, not coerced. `String(x)` turns every non-string into a
    // plausible-looking code — `String(null)` is 'null', an object becomes '[object object]' — each
    // long enough to survive the emptiness check below. That is not hypothetical: /v1/full-currencies
    // returns an array of OBJECTS under this very field name, so one endpoint swap would fill the set
    // with a single junk entry, log it as a success, and leave a non-null Set that answers false for
    // every real code until the TTL expires. Strictly worse than the outage this method exists to
    // survive, because the fail-open cannot see it.
    const codes = list
      .filter((c): c is string => typeof c === 'string')
      .map((c) => c.trim().toLowerCase())
      .filter((code) => code.length > 0);
    if (codes.length === 0) throw new Error(`${path} returned an empty ${field} list`);
    return codes;
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
      paymentTag: readPaymentTag(json, this.logger),
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

    let canonical: string;
    try {
      canonical = JSON.stringify(sortDeep(payload));
    } catch (err) {
      if (err instanceof PayloadTooDeepError) {
        this.logger.warn('IPN payload nested past the depth cap — rejecting unread');
        return null;
      }
      throw err;
    }

    const expected = createHmac('sha512', this.ipnSecret).update(canonical).digest('hex');

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

    return this.toEvent(payload, 'IPN');
  }

  /**
   * `GET /v1/payment/{id}` — the same payment, told to us instead of shouted at us.
   *
   * The response carries the same fields the IPN does, so it goes through the same normalisation
   * and reaches the same crediting path. There is no signature to check because there is nothing
   * to authenticate: we made the request, over TLS, with our own API key.
   *
   * Errors are swallowed into null on purpose. The caller is a periodic sweep over payments that
   * are already unsettled — an unreachable API means it stays unsettled and the next pass tries
   * again, which is exactly what should happen.
   */
  async fetchPayment(providerPaymentId: string): Promise<ParsedWebhook | null> {
    if (!this.isConfigured() || !providerPaymentId) return null;

    try {
      const res = await fetch(`${API_BASE}/payment/${encodeURIComponent(providerPaymentId)}`, {
        headers: { 'x-api-key': this.apiKey },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        // A 404 is a payment they have no record of; anything else is theirs to recover from.
        if (res.status !== 404) {
          this.logger.warn(`payment lookup for ${providerPaymentId} failed: HTTP ${res.status}`);
        }
        return null;
      }
      const payload = (await res.json()) as Record<string, unknown>;
      // Their lookup response omits `payment_id` on some plans; the id we asked for is authoritative.
      return this.toEvent({ ...payload, payment_id: providerPaymentId }, 'payment lookup');
    } catch (err) {
      this.logger.warn(
        `payment lookup for ${providerPaymentId} failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return null;
    }
  }

  /**
   * Normalise a NOWPayments payment payload, whichever direction it arrived from.
   *
   * Shared so a pushed callback and a pulled lookup can never disagree about what a payment means
   * — the reconciliation sweep exists precisely to be a substitute for the webhook, and would be
   * worthless if it credited a different amount.
   */
  private toEvent(payload: Record<string, unknown>, source: string): ParsedWebhook | null {
    const rawStatus = String(payload.payment_status ?? '');
    const status = STATUS_MAP[rawStatus];
    if (!status) {
      this.logger.warn(`${source} with unknown payment_status "${rawStatus}" — ignoring`);
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
 * The memo / destination tag for this payment, from `payin_extra_id`.
 *
 * WHY THIS FIELD DECIDES WHETHER THE MONEY ARRIVES. On XRP, Stellar, Cosmos and the like the
 * processor does not issue a fresh address per payment — it hands out ONE shared deposit address
 * for the whole account and tells depositors apart by this tag alone. It is the only thing on the
 * transfer that says which payment, and therefore which user, the funds belong to. A transfer that
 * lands on that address without its tag credits nobody, and there is nothing on-chain left to
 * attribute it by: it is not recoverable. So this is not an extra detail to show if convenient, it
 * is half of the address.
 *
 * PER PAYMENT, NOT PER COIN. Observed against the live API: xrp, xlm and atom each returned a tag,
 * ton returned null on the same call — so nothing here keys off the currency code. Present means
 * present.
 *
 * READ, NEVER COERCED. `String(json.payin_extra_id ?? '')` would turn the null that TON returns
 * into the four characters "null" — a tag the user would dutifully paste into their wallet, which
 * is precisely the unrecoverable transfer this exists to prevent. Only a non-empty string counts;
 * null, undefined and '' are the processor saying this chain needs no tag. Anything else present
 * is neither, so it is logged loudly rather than dropped in silence: on a memo chain a missing tag
 * is money, and a log line is the only chance of noticing the shape changed under us.
 */
function readPaymentTag(json: Record<string, unknown>, logger: Logger): string | undefined {
  const raw = json.payin_extra_id;
  if (typeof raw === 'string') {
    const tag = raw.trim();
    return tag.length > 0 ? tag : undefined;
  }
  // A NUMBER IS THE LIKELY DRIFT, AND IT IS USABLE. Every tag this API has returned is digits in a
  // string — XRP's is `"648105598"` — so serialising it as a JSON number instead is the one shape
  // change that could plausibly happen, and it is the one where guessing wrong costs the deposit.
  // Accepting it is safe: the value is the same digits either way.
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return String(raw);
  }
  // Null and undefined are the processor saying this chain needs no tag; anything else present is
  // neither that nor a tag we can show. REFUSE rather than fall through to `undefined`: downstream
  // cannot tell "no tag needed" from "we failed to read one", and it uses that absence to decide a
  // bare-address QR is safe. On a shared-address chain that is the unrecoverable transfer. A failed
  // deposit the user can retry is strictly better than a successful one they cannot claim.
  if (raw !== null && raw !== undefined) {
    logger.error(
      `createDeposit: payin_extra_id arrived as ${typeof raw} (${JSON.stringify(raw).slice(0, 60)}), ` +
        'which is neither a tag nor an absence — refusing the deposit rather than issuing an ' +
        'address whose tag we could not read',
    );
    throw new ServiceUnavailableException(
      'the payment processor returned a deposit tag we could not read — no address has been ' +
        'issued, please try again',
    );
  }
  return undefined;
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
 * How deep a payload may nest before it is refused unread.
 *
 * An IPN is one flat object; nothing legitimate comes close. The cap exists because the sort below
 * runs BEFORE the signature can be checked — it is work an unauthenticated caller gets to ask for,
 * and unbounded recursion over a body they chose is the cheapest way to ask for a lot of it.
 */
const MAX_PAYLOAD_DEPTH = 8;

/** Signals a payload nested past {@link MAX_PAYLOAD_DEPTH}. */
class PayloadTooDeepError extends Error {}

/**
 * Recursively sort object keys. Arrays keep their order — order is meaningful in an array, and
 * NOWPayments does not reorder them either.
 */
function sortDeep(value: unknown, depth = 0): unknown {
  if (depth > MAX_PAYLOAD_DEPTH) throw new PayloadTooDeepError();
  if (Array.isArray(value)) return value.map((item) => sortDeep(item, depth + 1));
  if (value === null || typeof value !== 'object') return value;
  const src = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(src).sort()) out[key] = sortDeep(src[key], depth + 1);
  return out;
}
