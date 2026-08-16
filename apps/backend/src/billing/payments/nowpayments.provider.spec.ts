import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';

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
