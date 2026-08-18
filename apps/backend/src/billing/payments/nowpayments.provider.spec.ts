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

// --- The payment request -------------------------------------------------------------------
//
// These exist because the request body was NOT covered before, and a wrong field name in it is
// silent: NOWPayments ignores what it does not recognise and returns 200, so `fixed_rate` (the
// real spelling is `is_fixed_rate`) disabled the rate lock for every payment while looking like
// it worked. Nothing failed, no log line appeared, and the only symptom was money.

/** Capture the outgoing request without reaching the network. */
function captureRequest(overrides: Record<string, string> = {}): {
  body: () => Record<string, unknown>;
  provider: NowPaymentsProvider;
} {
  let captured: Record<string, unknown> = {};
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('/currencies')) {
      return new Response(JSON.stringify({ currencies: ['usdtbsc'] }), { status: 200 });
    }
    captured = JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>;
    return new Response(
      JSON.stringify({
        payment_id: '4444444444',
        pay_address: '0xabc',
        pay_amount: 49.5,
        pay_currency: 'usdtbsc',
      }),
      { status: 200 },
    );
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

// --- Rail availability ---------------------------------------------------------------------

test('a rail the processor does not offer is not offerable', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ currencies: ['usdtbsc', 'usdcsol'] }), {
      status: 200,
    })) as typeof globalThis.fetch;
  after(() => {
    globalThis.fetch = original;
  });

  const p = provider();
  await p.onModuleInit();
  await new Promise((r) => setImmediate(r));

  assert.equal(p.supportsCurrency('usdtbsc'), true);
  // `dot` was in our catalogue and does not exist at NOWPayments. It must not reach the UI.
  assert.equal(p.supportsCurrency('dot'), false);
  assert.equal(p.supportsCurrency('USDCSOL'), true, 'codes are compared case-insensitively');
});

test('an unreachable currency list leaves every rail offerable rather than none', async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    throw new Error('network down');
  }) as typeof globalThis.fetch;
  after(() => {
    globalThis.fetch = original;
  });

  const p = provider();
  await p.onModuleInit();
  await new Promise((r) => setImmediate(r));

  // Hiding every deposit option because their status endpoint blipped is worse than showing one
  // that then fails closed at createDeposit.
  assert.equal(p.supportsCurrency('usdtbsc'), true);
});

test('an unconfigured account offers nothing', () => {
  assert.equal(provider({ NOWPAYMENTS_API_KEY: '' }).supportsCurrency('usdtbsc'), false);
});
