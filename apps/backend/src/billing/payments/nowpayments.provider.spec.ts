import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { after, test } from 'node:test';

import type { ConfigService } from '@nestjs/config';

import { NowPaymentsProvider } from './nowpayments.provider';

const IPN_SECRET = 'test-ipn-secret';

function provider(overrides: Record<string, string> = {}): NowPaymentsProvider {
  const values: Record<string, string> = {
    NOWPAYMENTS_API_KEY: 'test-key',
    NOWPAYMENTS_IPN_SECRET: IPN_SECRET,
    ...overrides,
  };
  return new NowPaymentsProvider({
    get: (key: string) => values[key],
  } as unknown as ConfigService);
}

/**
 * Produce a correctly-signed callback the way NOWPayments does: HMAC-SHA512 over the payload
 * re-serialised with its keys sorted, NOT over the bytes as sent. Deliberately written
 * independently of the implementation — a shared helper would make both agree on the same mistake.
 */
function signed(payload: Record<string, unknown>): {
  body: Buffer;
  headers: Record<string, string>;
} {
  const sortedKeys = Object.keys(payload).sort();
  const canonical: Record<string, unknown> = {};
  for (const k of sortedKeys) canonical[k] = payload[k];
  const sig = createHmac('sha512', IPN_SECRET).update(JSON.stringify(canonical)).digest('hex');
  // The body is serialised in a DIFFERENT key order from the signed form, which is the realistic
  // case: the signature covers the sorted projection, not the wire bytes.
  return {
    body: Buffer.from(JSON.stringify(payload)),
    headers: { 'x-nowpayments-sig': sig },
  };
}

const FINISHED = {
  payment_id: '5745459419',
  payment_status: 'finished',
  pay_address: '0xabc',
  price_amount: 50,
  price_currency: 'usd',
  pay_amount: 50.5,
  actually_paid: 50.5,
  pay_currency: 'usdtbsc',
  order_id: 'team-1:1700000000000',
  outcome_amount: 49.75,
  outcome_currency: 'usdtbsc',
};

test('a correctly signed callback verifies and credits the full USD value', () => {
  const { body, headers } = signed(FINISHED);
  const event = provider().verifyWebhook(body, headers);

  assert.ok(event, 'a valid signature must verify');
  assert.equal(event.providerPaymentId, '5745459419');
  assert.equal(event.status, 'confirmed');
  // Gross: the user gets the $50 they paid for, the processor's cut is our cost.
  assert.equal(event.creditCents, 5_000);
});

test('a tampered amount is rejected', () => {
  const { body, headers } = signed(FINISHED);
  // Attacker inflates the price after signing.
  const tampered = Buffer.from(body.toString().replace('"price_amount":50', '"price_amount":5000'));

  assert.equal(provider().verifyWebhook(tampered, headers), null);
});

test('a missing or wrong signature header is rejected', () => {
  const { body } = signed(FINISHED);

  assert.equal(provider().verifyWebhook(body, {}), null);
  assert.equal(provider().verifyWebhook(body, { 'x-nowpayments-sig': 'deadbeef' }), null);
});

test('an unset IPN secret rejects everything rather than accepting anything', () => {
  const { body, headers } = signed(FINISHED);

  // Misconfiguration must fail closed: an empty secret must never mean "skip verification".
  assert.equal(provider({ NOWPAYMENTS_IPN_SECRET: '' }).verifyWebhook(body, headers), null);
});

test('key order on the wire does not affect verification', () => {
  // The signature covers the SORTED projection, so a processor that emits keys in any order still
  // verifies. This is the property that makes re-serialisation legitimate.
  const reordered = Object.fromEntries(Object.entries(FINISHED).reverse());
  const { body, headers } = signed(reordered as Record<string, unknown>);

  assert.ok(provider().verifyWebhook(body, headers));
});

test('intermediate statuses verify but carry no credit', () => {
  for (const status of ['waiting', 'confirming', 'confirmed', 'sending', 'partially_paid']) {
    const { body, headers } = signed({ ...FINISHED, payment_status: status });
    const event = provider().verifyWebhook(body, headers);

    assert.ok(event, `${status} should verify`);
    assert.equal(event.creditCents, undefined, `${status} must not credit`);
    assert.notEqual(event.status, 'confirmed', `${status} must not map to confirmed`);
  }
});

test('NOWPayments "confirmed" is NOT settled and must not credit', () => {
  // The distinction that costs money if missed: NOWPayments uses `confirmed` for blockchain
  // confirmation and `finished` for funds settled to the merchant. Crediting the former hands out
  // balance for payments that can still fail in settlement.
  const { body, headers } = signed({ ...FINISHED, payment_status: 'confirmed' });
  const event = provider().verifyWebhook(body, headers);

  assert.equal(event?.status, 'confirming');
});

test('failure statuses map to terminal states', () => {
  const cases: Array<[string, string]> = [
    ['failed', 'failed'],
    ['refunded', 'failed'],
    ['expired', 'expired'],
  ];
  for (const [raw, expected] of cases) {
    const { body, headers } = signed({ ...FINISHED, payment_status: raw });
    assert.equal(provider().verifyWebhook(body, headers)?.status, expected);
  }
});

test('underpayment credits proportionally', () => {
  // Sent half of what was quoted → half the Credit, rather than the full amount or nothing.
  const { body, headers } = signed({ ...FINISHED, actually_paid: 25.25 });

  assert.equal(provider().verifyWebhook(body, headers)?.creditCents, 2_500);
});

test('overpayment credits the extra', () => {
  const { body, headers } = signed({ ...FINISHED, actually_paid: 101 });

  assert.equal(provider().verifyWebhook(body, headers)?.creditCents, 10_000);
});

test('a settled payment with no actually_paid falls back to the quoted price', () => {
  const payload = { ...FINISHED } as Record<string, unknown>;
  delete payload.actually_paid;
  const { body, headers } = signed(payload);

  assert.equal(provider().verifyWebhook(body, headers)?.creditCents, 5_000);
});

test('an unknown status is ignored rather than guessed at', () => {
  const { body, headers } = signed({ ...FINISHED, payment_status: 'something_new' });

  assert.equal(provider().verifyWebhook(body, headers), null);
});

test('a non-JSON body is rejected without throwing', () => {
  assert.equal(
    provider().verifyWebhook(Buffer.from('not json'), { 'x-nowpayments-sig': 'x' }),
    null,
  );
});

test('nested objects are sorted recursively', () => {
  // NOWPayments sorts every level. A shallow sort would produce a different string and reject
  // every callback that happens to carry a nested object.
  const nested = { ...FINISHED, meta: { z: 1, a: { y: 2, b: 3 } } };
  const canonicalise = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(canonicalise);
    if (v === null || typeof v !== 'object') return v;
    const src = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(src).sort()) out[k] = canonicalise(src[k]);
    return out;
  };
  const sig = createHmac('sha512', IPN_SECRET)
    .update(JSON.stringify(canonicalise(nested)))
    .digest('hex');

  const event = provider().verifyWebhook(Buffer.from(JSON.stringify(nested)), {
    'x-nowpayments-sig': sig,
  });

  assert.ok(event, 'recursively sorted payloads must verify');
});

test('a payload nested past the depth cap is refused instead of sorted', () => {
  // The sort runs BEFORE the signature can be checked, so its cost is work an unauthenticated
  // caller gets to ask for. A real IPN is one object deep; anything approaching this is a probe.
  let deep: Record<string, unknown> = { end: true };
  for (let i = 0; i < 64; i += 1) deep = { nest: deep };

  assert.equal(
    provider().verifyWebhook(Buffer.from(JSON.stringify(deep)), { 'x-nowpayments-sig': 'x' }),
    null,
  );
});

// --- The payment request -------------------------------------------------------------------
//
// These exist because the request body was NOT covered before, and a wrong field name in it is
// silent: NOWPayments ignores what it does not recognise and returns 200, so `fixed_rate` (the
// real spelling is `is_fixed_rate`) disabled the rate lock for every payment while looking like
// it worked. Nothing failed, no log line appeared, and the only symptom was money.

/** A JSON reply, the shape both currency endpoints answer in. */
function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Everything after the API base, so a failure names the endpoint rather than the host. */
function endpoint(url: string): string {
  return url.replace('https://api.nowpayments.io/v1', '');
}

/** Capture the outgoing request without reaching the network. */
function captureRequest(overrides: Record<string, string> = {}): {
  body: () => Record<string, unknown>;
  provider: NowPaymentsProvider;
} {
  let captured: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const target = String(url);
    // Answered per URL, and anything unrecognised is an error rather than a default. The version
    // of this stub that replied to EVERY url with one body is the reason the currency refresh went
    // uncovered: a stub that answers everything cannot show which endpoint was asked.
    if (target.endsWith('/merchant/coins'))
      return jsonResponse({ selectedCurrencies: ['USDTBSC'] });
    if (target.endsWith('/currencies')) return jsonResponse({ currencies: ['usdtbsc'] });
    if (target.endsWith('/payment')) {
      captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
      return jsonResponse({
        payment_id: '4444444444',
        pay_address: '0xabc',
        pay_amount: 49.5,
        pay_currency: 'usdtbsc',
      });
    }
    throw new Error(`unexpected fetch of ${target}`);
  }) as typeof globalThis.fetch;
  after(() => {
    globalThis.fetch = original;
  });
  return { body: () => captured, provider: provider(overrides) };
}

test('the rate lock is sent as is_fixed_rate, the name the API actually reads', async () => {
  const { body, provider: p } = captureRequest({ NOWPAYMENTS_FIXED_RATE: 'true' });
  await p.createDeposit({ amountCents: 5_000, currencyCode: 'usdtbsc', orderId: 'ord_1' });

  assert.equal(body().is_fixed_rate, true);
  assert.equal(
    'fixed_rate' in body(),
    false,
    'fixed_rate is not a field NOWPayments reads — sending it silently does nothing',
  );
});

test('optional flags are omitted entirely when off, not sent as false', async () => {
  const { body, provider: p } = captureRequest();
  await p.createDeposit({ amountCents: 5_000, currencyCode: 'usdtbsc', orderId: 'ord_2' });

  assert.equal('is_fixed_rate' in body(), false);
  assert.equal('is_fee_paid_by_user' in body(), false);
});

test('the amount is sent in dollars, not cents', async () => {
  const { body, provider: p } = captureRequest();
  await p.createDeposit({ amountCents: 5_000, currencyCode: 'usdtbsc', orderId: 'ord_3' });

  // Sending 5000 here would quote a $5,000 payment for a $50 deposit.
  assert.equal(body().price_amount, 50);
  assert.equal(body().price_currency, 'usd');
  assert.equal(body().pay_currency, 'usdtbsc');
  assert.equal(body().order_id, 'ord_3');
});

// --- The memo / destination tag -------------------------------------------------------------
//
// `payin_extra_id` is the field, and it is money. Chains like XRP, Stellar and Cosmos do not get a
// fresh address per payment — the processor hands out ONE shared address and tells depositors
// apart by this tag, so a transfer that arrives without it credits nobody and cannot be recovered.
// Confirmed against the live API: xrp, xlm and atom each returned a tag on `POST /v1/payment`,
// ton returned null on the same call, which is why nothing here keys off the currency code.

/** Answer `POST /payment` with a chosen response body, and take the stub down afterwards. */
function respondWith(payment: Record<string, unknown>): NowPaymentsProvider {
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request) => {
    if (String(url).endsWith('/currencies')) {
      return new Response(JSON.stringify({ currencies: ['xrp'] }), { status: 200 });
    }
    return new Response(JSON.stringify(payment), { status: 200 });
  }) as typeof globalThis.fetch;
  after(() => {
    globalThis.fetch = original;
  });
  return provider();
}

const XRP_PAYMENT = {
  payment_id: '4444444444',
  pay_address: 'rKKbNYZRqwPgZYkFWvqNUFBuscEyiFyCE',
  payin_extra_id: '648105598',
  pay_amount: 21.5,
  pay_currency: 'xrp',
};

test('a memo chain surfaces its destination tag', async () => {
  const p = respondWith(XRP_PAYMENT);
  const created = await p.createDeposit({ amountCents: 5_000, currencyCode: 'xrp', orderId: 'o1' });

  assert.equal(created.paymentTag, '648105598');
  assert.equal(created.address, 'rKKbNYZRqwPgZYkFWvqNUFBuscEyiFyCE');
});

test('a tag that arrives as a NUMBER is still handed to the user', async () => {
  // Every tag this API returns today is digits inside a string ("648105598"), so serialising it as
  // a JSON number is the one shape change that could plausibly happen — and the one where guessing
  // wrong costs the deposit, because an unread tag reads downstream as "this chain needs none" and
  // re-enables the bare-address QR.
  const p = respondWith({ ...XRP_PAYMENT, payin_extra_id: 648105598 });
  const created = await p.createDeposit({ amountCents: 5_000, currencyCode: 'xrp', orderId: 'o1' });

  assert.equal(created.paymentTag, '648105598');
});

test('a tag we cannot read REFUSES the deposit rather than issuing an untagged address', async () => {
  // The failure this prevents is the quiet one: returning `undefined` here is indistinguishable
  // from "this chain needs no tag", and that absence is what the page uses to decide a scannable
  // address-only QR is safe. On a shared-address chain that is an unrecoverable transfer, so a
  // refusal the user can retry is strictly the better outcome.
  for (const unreadable of [{ id: 1 }, ['648105598'], true]) {
    const p = respondWith({ ...XRP_PAYMENT, payin_extra_id: unreadable });
    await assert.rejects(
      () => p.createDeposit({ amountCents: 5_000, currencyCode: 'xrp', orderId: 'o1' }),
      /could not read|deposit tag/i,
      `${JSON.stringify(unreadable)} must not be silently dropped`,
    );
  }
});

test('a chain with no tag reports none — never the string "null"', async () => {
  // TON's real answer: a per-payment address and an explicit null. Coercing it with
  // `String(json.payin_extra_id ?? '')` yields "null", which a user would paste into their wallet.
  const p = respondWith({
    payment_id: '4444444445',
    pay_address: 'UQC5nDtMZVy4AYPGYY-XmsAEUcYNVchAQwFCnDI0dlHBz4cE',
    payin_extra_id: null,
    pay_amount: 9.1,
    pay_currency: 'ton',
  });
  const created = await p.createDeposit({ amountCents: 5_000, currencyCode: 'ton', orderId: 'o2' });

  assert.equal(created.paymentTag, undefined);
});

test('an empty or blank tag is absent, not an empty field to paste', async () => {
  for (const blank of ['', '   ']) {
    const p = respondWith({ ...XRP_PAYMENT, payin_extra_id: blank });
    const created = await p.createDeposit({
      amountCents: 5_000,
      currencyCode: 'xrp',
      orderId: 'o3',
    });
    assert.equal(created.paymentTag, undefined, `"${blank}" is the processor saying there is none`);
  }
});

test('a tag is never trusted to the response omitting the field', async () => {
  const { payin_extra_id: _omitted, ...noTagField } = XRP_PAYMENT;
  const p = respondWith(noTagField);
  const created = await p.createDeposit({ amountCents: 5_000, currencyCode: 'xrp', orderId: 'o4' });

  assert.equal(created.paymentTag, undefined);
});

// --- Rail availability ---------------------------------------------------------------------
//
// The refresh reads TWO endpoints that carry their list under DIFFERENT field names — the
// account's own `/merchant/coins` (`selectedCurrencies`, UPPERCASE, authenticated) and the
// platform-wide `/currencies` (`currencies`) as the fallback. So every stub below routes on the
// url and throws on one it was not written to answer. A stub that replies to everything with the
// fallback's shape makes the primary path look covered while never running it, which is exactly
// what happened here.

/**
 * Run one test against a fetch stub that answers per url, and take the stub down again whatever
 * happens — restoring in a `finally` rather than a hook, so a stub can never outlive the test that
 * installed it and be read as some other endpoint's answer.
 */
async function withFetch(
  handler: (url: string, init?: RequestInit) => Promise<Response>,
  body: (calls: string[]) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(String(url));
    return handler(String(url), init);
  }) as typeof globalThis.fetch;
  try {
    await body(calls);
  } finally {
    globalThis.fetch = original;
  }
}

/** Let the fire-and-forget refresh finish, fallback leg included. */
async function settle(turns = 20): Promise<void> {
  for (let i = 0; i < turns; i += 1) await new Promise((r) => setImmediate(r));
}

/** Boot the provider the way Nest does, then wait out the refresh it starts and does not await. */
async function booted(p: NowPaymentsProvider): Promise<NowPaymentsProvider> {
  p.onModuleInit();
  await settle();
  return p;
}

/**
 * Force another refresh now.
 *
 * Reaches for the private method deliberately: the only public trigger is a one-hour TTL, so
 * "what does a LATER refresh do to a list that is already loaded" is otherwise unaskable without
 * faking the clock, which would test Date.now() instead of the provider.
 */
function refreshNow(p: NowPaymentsProvider): Promise<void> {
  return (p as unknown as { refreshCurrencies(): Promise<void> }).refreshCurrencies();
}

/**
 * The loaded set, or null if none ever loaded.
 *
 * Read directly because the difference between the two IS the subject: null answers true for every
 * code by design, so a fail-open assertion alone cannot tell "nothing loaded" from "something
 * loaded and it happens to contain what I asked about". Naming the set says which happened, and
 * shows the junk if any got in.
 */
function loadedCodes(p: NowPaymentsProvider): Set<string> | null {
  return (p as unknown as { currencies: Set<string> | null }).currencies;
}

test("the account's own coin list wins, lowercased on the way in", async () => {
  let sentApiKey: string | null = null;
  await withFetch(
    async (url, init) => {
      if (url.endsWith('/merchant/coins')) {
        sentApiKey = new Headers(init?.headers).get('x-api-key');
        // The real endpoint answers UPPERCASE; the rest of this class and the catalogue in
        // deposit-chains.ts are lowercase.
        return jsonResponse({ selectedCurrencies: ['USDTBSC', 'USDCSOL'] });
      }
      // The platform-wide list is deliberately DIFFERENT. If a code from here shows up as
      // supported, the primary was skipped and the fallback quietly answered for it.
      if (url.endsWith('/currencies')) return jsonResponse({ currencies: ['dot'] });
      throw new Error(`unexpected fetch of ${url}`);
    },
    async (calls) => {
      const p = await booted(provider());

      assert.deepEqual([...(loadedCodes(p) ?? [])].sort(), ['usdcsol', 'usdtbsc']);
      assert.equal(p.supportsCurrency('usdtbsc'), true);
      assert.equal(p.supportsCurrency('USDCSOL'), true, 'codes are compared case-insensitively');
      assert.equal(
        p.supportsCurrency('dot'),
        false,
        'dot is only in the platform-wide list — answering true would mean the account list was ignored',
      );
      assert.deepEqual(
        calls.map(endpoint),
        ['/merchant/coins'],
        'the fallback must not be reached when the account list answered',
      );
      // Unauthenticated, this endpoint is a 403 and every refresh would run on the fallback.
      assert.equal(sentApiKey, 'test-key');
    },
  );
});

test('a rail the processor does not offer is not offerable', async () => {
  await withFetch(
    async (url) => {
      if (url.endsWith('/merchant/coins')) {
        return jsonResponse({ selectedCurrencies: ['USDTBSC', 'USDCSOL'] });
      }
      throw new Error(`unexpected fetch of ${url}`);
    },
    async () => {
      const p = await booted(provider());

      assert.equal(p.supportsCurrency('usdtbsc'), true);
      // `dot` was in our catalogue and does not exist at NOWPayments. It must not reach the UI.
      assert.equal(p.supportsCurrency('dot'), false);
      assert.equal(p.supportsCurrency('USDCSOL'), true, 'codes are compared case-insensitively');
    },
  );
});

test('a merchant/coins that refuses the key falls back to the platform-wide list', async () => {
  await withFetch(
    async (url) => {
      if (url.endsWith('/merchant/coins')) return new Response('Forbidden', { status: 403 });
      if (url.endsWith('/currencies')) return jsonResponse({ currencies: ['usdtbsc', 'usdcsol'] });
      throw new Error(`unexpected fetch of ${url}`);
    },
    async (calls) => {
      const p = await booted(provider());

      assert.deepEqual(calls.map(endpoint), ['/merchant/coins', '/currencies']);
      assert.deepEqual([...(loadedCodes(p) ?? [])].sort(), ['usdcsol', 'usdtbsc']);
      assert.equal(p.supportsCurrency('usdtbsc'), true);
      // A platform-wide superset is a looser check than the account's own list, but it still
      // catches the failure the check exists for: a code that exists nowhere.
      assert.equal(p.supportsCurrency('dot'), false);
    },
  );
});

test('an unreachable currency list leaves every rail offerable rather than none', async () => {
  await withFetch(
    async () => {
      throw new Error('network down');
    },
    async (calls) => {
      const p = await booted(provider());

      // Hiding every deposit option because their status endpoint blipped is worse than showing
      // one that then fails closed at createDeposit.
      assert.equal(p.supportsCurrency('usdtbsc'), true);
      assert.equal(loadedCodes(p), null, 'nothing loaded, so nothing to compare against');
      assert.deepEqual(calls.map(endpoint), ['/merchant/coins', '/currencies']);
    },
  );
});

test('both endpoints answering 200 with an empty list is an outage, not an answer of "none"', async () => {
  // Observed live: `200 {"currencies":[]}`. Stored literally it is the worst possible value,
  // because it defeats the safety net instead of tripping it — an empty Set is not null, so the
  // documented fail-open never fires, every catalogue code answers false, and the deposit page
  // renders with zero rails while the API looks healthy.
  await withFetch(
    async (url) => {
      if (url.endsWith('/merchant/coins')) return jsonResponse({ selectedCurrencies: [] });
      if (url.endsWith('/currencies')) return jsonResponse({ currencies: [] });
      throw new Error(`unexpected fetch of ${url}`);
    },
    async (calls) => {
      const p = await booted(provider());

      assert.equal(loadedCodes(p), null, 'an empty list must not be stored as an empty Set');
      assert.equal(p.supportsCurrency('usdtbsc'), true, 'fail open');
      assert.equal(
        p.supportsCurrency('dot'),
        true,
        'fail open, for every code, not just real ones',
      );
      assert.deepEqual(
        calls.map(endpoint),
        ['/merchant/coins', '/currencies'],
        'an empty primary is a failed leg and must fall through to the fallback',
      );
    },
  );
});

test('a later empty list does not erase the list already loaded', async () => {
  let gone = false;
  await withFetch(
    async (url) => {
      if (url.endsWith('/merchant/coins')) {
        return jsonResponse({ selectedCurrencies: gone ? [] : ['USDTBSC', 'USDCSOL'] });
      }
      if (url.endsWith('/currencies')) return jsonResponse({ currencies: gone ? [] : ['usdtbsc'] });
      throw new Error(`unexpected fetch of ${url}`);
    },
    async () => {
      const p = await booted(provider());
      assert.equal(p.supportsCurrency('usdcsol'), true);

      // An hour later, both endpoints have gone empty.
      gone = true;
      await refreshNow(p);

      // A stale list beats an empty one: these rails still work at the processor.
      assert.deepEqual([...(loadedCodes(p) ?? [])].sort(), ['usdcsol', 'usdtbsc']);
      assert.equal(p.supportsCurrency('usdtbsc'), true);
      assert.equal(p.supportsCurrency('dot'), false, 'and the list is still doing its job');
    },
  );
});

test('an array of objects under the same field name is a failed refresh, not a set with one junk code in it', async () => {
  // `/v1/full-currencies` answers `{ currencies: [{ code: 'BTC', ... }, ...] }` — the SAME field
  // name, a different shape. Coerced with String() each entry becomes '[object object]': long
  // enough to survive an emptiness check, so the set would be non-null, logged as a success, and
  // answer false for every real code until the TTL expires. Worse than the outage the fail-open
  // exists to survive, because the fail-open cannot see it.
  await withFetch(
    async (url) => {
      if (url.endsWith('/merchant/coins')) return new Response('Forbidden', { status: 403 });
      if (url.endsWith('/currencies')) {
        return jsonResponse({
          currencies: [
            { code: 'BTC', name: 'Bitcoin', network: 'btc' },
            { code: 'ETH', name: 'Ethereum', network: 'eth' },
          ],
        });
      }
      throw new Error(`unexpected fetch of ${url}`);
    },
    async () => {
      const p = await booted(provider());

      assert.equal(
        loadedCodes(p),
        null,
        `poisoned set: ${JSON.stringify([...(loadedCodes(p) ?? [])])}`,
      );
      assert.equal(
        p.supportsCurrency('usdtbsc'),
        true,
        'fail open, as with any other bad response',
      );
      assert.equal(p.supportsCurrency('dot'), true);
    },
  );
});

test('junk mixed into a real list is dropped, not coerced into codes', async () => {
  await withFetch(
    async (url) => {
      if (url.endsWith('/merchant/coins')) {
        return jsonResponse({
          selectedCurrencies: ['USDTBSC', null, 42, { code: 'BTC' }, '  usdcsol  ', ''],
        });
      }
      throw new Error(`unexpected fetch of ${url}`);
    },
    async () => {
      const p = await booted(provider());

      assert.deepEqual([...(loadedCodes(p) ?? [])].sort(), ['usdcsol', 'usdtbsc']);
      assert.equal(p.supportsCurrency('null'), false);
      assert.equal(p.supportsCurrency('42'), false);
      assert.equal(p.supportsCurrency('[object object]'), false);
      assert.equal(
        p.supportsCurrency('usdcsol'),
        true,
        'and surrounding whitespace is trimmed off',
      );
    },
  );
});

test('a hanging API is asked once, not once per rail the deposit page renders', async () => {
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => {
    release = r;
  });

  await withFetch(
    async () => {
      await gate;
      throw new Error('connect ETIMEDOUT');
    },
    async (calls) => {
      const p = provider();
      p.onModuleInit();
      assert.equal(calls.length, 1, 'boot opens one request, which now hangs');

      // The deposit page asks about every rail in the catalogue, in a tight loop, while that first
      // request is still open.
      for (let i = 0; i < 50; i += 1) {
        assert.equal(p.supportsCurrency('usdtbsc'), true, 'unknown means offerable');
      }
      // currenciesFetchedAt is stamped BEFORE the request, so those calls do not even reach
      // refreshCurrencies...
      assert.equal(calls.length, 1, 'a TTL stamped after the response would be 51 requests here');
      // ...and currenciesInFlight stops a caller that gets past the TTL anyway.
      const concurrent = refreshNow(p);
      assert.equal(calls.length, 1, 'currenciesInFlight must be set before the first await');

      release();
      await concurrent;
      await settle();

      // Two, not fifty-one: the primary and then its fallback. One stamp per refresh, however many
      // endpoints that refresh took.
      assert.deepEqual(calls.map(endpoint), ['/merchant/coins', '/currencies']);

      // And a refresh that FAILED does not re-arm the next fifty callers against an API that is
      // already struggling — the stamp stands either way.
      for (let i = 0; i < 50; i += 1) assert.equal(p.supportsCurrency('dot'), true);
      assert.equal(calls.length, 2);
    },
  );
});

test('an unconfigured account offers nothing', () => {
  assert.equal(provider({ NOWPAYMENTS_API_KEY: '' }).supportsCurrency('usdtbsc'), false);
});
