import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import { CryptomusProvider } from './cryptomus.provider';

const KEY = 'test-payment-key';

function provider(): CryptomusProvider {
  const config = {
    get: (k: string) =>
      ({
        CRYPTOMUS_MERCHANT_ID: 'merchant-uuid',
        CRYPTOMUS_PAYMENT_KEY: KEY,
        CRYPTOMUS_CALLBACK_URL: 'https://api.lobrowser.com/billing/webhook',
      })[k],
  } as never;
  return new CryptomusProvider(config);
}

/** Reproduce Cryptomus' PHP-side signing exactly, including the slash escaping. */
function signed(body: Record<string, unknown>): Buffer {
  const json = JSON.stringify(body).replace(/\//g, '\\/');
  const sign = createHash('md5')
    .update(Buffer.from(json, 'utf8').toString('base64') + KEY)
    .digest('hex');
  return Buffer.from(JSON.stringify({ ...body, sign }), 'utf8');
}

const PAID = {
  type: 'payment',
  uuid: 'pay-1',
  order_id: 'team-1:1',
  status: 'paid',
  payment_amount_usd: '10.00',
  payer_amount: '10.02',
  payer_currency: 'USDT',
  txid: '0xabc',
};

test('a correctly signed callback verifies and is normalised', () => {
  const out = provider().verifyWebhook(signed(PAID), {});
  assert.ok(out, 'a valid signature must verify');
  assert.equal(out.providerPaymentId, 'pay-1');
  assert.equal(out.status, 'confirmed');
  assert.equal(out.creditCents, 1000);
  assert.equal(out.txHash, '0xabc');
});

test('a payload containing a slash still verifies (the PHP json_encode escaping)', () => {
  // The single most common cause of a Cryptomus integration rejecting real callbacks: PHP emits
  // "\/" and JSON.stringify emits "/", so an unescaped reconstruction fails on any URL field.
  const withUrl = { ...PAID, additional_data: 'https://lobrowser.com/billing?ref=a/b' };
  const out = provider().verifyWebhook(signed(withUrl), {});
  assert.ok(out, 'a slash-bearing payload must still verify');
  assert.equal(out.status, 'confirmed');
});

test('a tampered amount is rejected', () => {
  const body = signed(PAID);
  const forged = Buffer.from(body.toString('utf8').replace('"10.00"', '"9999.00"'), 'utf8');
  assert.equal(provider().verifyWebhook(forged, {}), null);
});

test('a callback with no signature is rejected', () => {
  assert.equal(provider().verifyWebhook(Buffer.from(JSON.stringify(PAID)), {}), null);
});

test('an unknown status is refused rather than guessed', () => {
  const out = provider().verifyWebhook(signed({ ...PAID, status: 'something_new' }), {});
  assert.equal(out, null, 'an unmapped status must not be interpreted');
});

test('only paid and paid_over credit; every other status credits nothing', () => {
  const p = provider();
  for (const [status, expected] of [
    ['paid', 'confirmed'],
    ['paid_over', 'confirmed'],
    ['process', 'pending'],
    ['check', 'confirming'],
    ['confirm_check', 'confirming'],
    ['wrong_amount_waiting', 'confirming'],
    ['locked', 'confirming'],
    ['wrong_amount', 'failed'],
    ['fail', 'failed'],
    ['system_fail', 'failed'],
    ['refund_paid', 'failed'],
    ['cancel', 'expired'],
  ] as const) {
    const out = p.verifyWebhook(signed({ ...PAID, status }), {});
    assert.ok(out, `${status} should verify`);
    assert.equal(out.status, expected, `${status} maps to ${expected}`);
    if (expected !== 'confirmed') {
      assert.equal(out.creditCents, undefined, `${status} must never carry a credit`);
    }
  }
});

test('locked funds are held, never credited — money arrived but is frozen by AML', () => {
  const out = provider().verifyWebhook(signed({ ...PAID, status: 'locked' }), {});
  assert.equal(out?.status, 'confirming');
  assert.equal(out?.creditCents, undefined);
});

test('an underpayment that can still be topped up differs from one that cannot', () => {
  const p = provider();
  assert.equal(p.verifyWebhook(signed({ ...PAID, status: 'wrong_amount_waiting' }), {})?.status, 'confirming');
  assert.equal(p.verifyWebhook(signed({ ...PAID, status: 'wrong_amount' }), {})?.status, 'failed');
});

test('overpayment credits what actually arrived, not what was invoiced', () => {
  const out = provider().verifyWebhook(
    signed({ ...PAID, status: 'paid_over', payment_amount_usd: '12.34' }),
    {},
  );
  assert.equal(out?.creditCents, 1234);
});

test('sub-cent value floors rather than rounding up', () => {
  const out = provider().verifyWebhook(signed({ ...PAID, payment_amount_usd: '10.009' }), {});
  assert.equal(out?.creditCents, 1000, 'a half-cent we cannot represent is not ours to round up');
});

test('a settled payment with no usable USD amount credits nothing', () => {
  const out = provider().verifyWebhook(signed({ ...PAID, payment_amount_usd: 'not-a-number' }), {});
  assert.equal(out?.status, 'confirmed');
  assert.equal(out?.creditCents, 0);
});

test('an unconfirmed chain is refused before any money can move', async () => {
  // SOL/BASE/POLYGON are not in Cryptomus' documented service table, so they stay refused until
  // assertServicesCover() proves them against the live account.
  await assert.rejects(
    () => provider().createDeposit({ amountCents: 1000, currencyCode: 'usdcsol', orderId: 'o1' }),
    /unconfirmed against the live Cryptomus account/,
  );
});

test('an unknown deposit code is refused', async () => {
  await assert.rejects(
    () => provider().createDeposit({ amountCents: 1000, currencyCode: 'dogecoin', orderId: 'o1' }),
    /no Cryptomus pair/,
  );
});

test('isConfigured reflects credentials', () => {
  assert.equal(provider().isConfigured(), true);
  const bare = new CryptomusProvider({ get: () => undefined } as never);
  assert.equal(bare.isConfigured(), false);
  assert.equal(bare.verifyWebhook(signed(PAID), {}), null, 'no key must never verify');
});

test('supportsCurrency hides exactly what createDeposit would refuse', () => {
  const p = provider();
  // Verified from the published service table: offerable.
  assert.equal(p.supportsCurrency('usdttrc20'), true);
  assert.equal(p.supportsCurrency('btc'), true);
  assert.equal(p.supportsCurrency('usdtmatic'), true, 'POLYGON/USDT is in the documented table');
  assert.equal(p.supportsCurrency('sol'), true, "SOL/Solana is named in Cryptomus' own FAQ");
  // The network being supported is NOT the same claim as a token riding it.
  assert.equal(p.supportsCurrency('usdtsol'), false, 'SPL USDT is a separate, unconfirmed claim');
  // Unverified: hidden, because createDeposit would reject it after the user committed. This
  // pairing is the point — the list the account page renders and the list the provider accepts
  // must not diverge.
  assert.equal(p.supportsCurrency('usdcsol'), false);
  assert.equal(p.supportsCurrency('usdcbase'), false);
  assert.equal(p.supportsCurrency('xrp'), false);
  // Not a pair at all.
  assert.equal(p.supportsCurrency('dogecoin'), false);
});
