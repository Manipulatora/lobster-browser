import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  AGENT_MODEL_PRICES,
  DEFAULT_AGENT_MARGIN,
  MICROS_PER_CENT,
  MICROS_PER_USD,
  agentModelPrice,
  computeAgentCostMicros,
  estimateAgentCostMicros,
  resolveAgentMargin,
} from './agent-pricing';

const OPUS = 'anthropic/claude-opus-4.8';

test('an unknown model has no price, so the caller can refuse it', () => {
  assert.equal(agentModelPrice('nobody/invented-this'), undefined);
  assert.equal(
    computeAgentCostMicros({
      model: 'nobody/invented-this',
      tokensIn: 1000,
      tokensOut: 1000,
      cachedIn: 0,
    }),
    undefined,
  );
});

test('a routing suffix selects a provider, not a different price', () => {
  assert.deepEqual(agentModelPrice(`${OPUS}:nitro`), AGENT_MODEL_PRICES[OPUS]);
  assert.deepEqual(agentModelPrice(OPUS.toUpperCase()), AGENT_MODEL_PRICES[OPUS]);
});

test('input, output and cached input are priced at their own rates, not summed at parity', () => {
  // 1M fresh input on Opus is $5.00 = 5,000,000 µ$, times the 1.5x margin.
  const input = computeAgentCostMicros({
    model: OPUS,
    tokensIn: 1_000_000,
    tokensOut: 0,
    cachedIn: 0,
  });
  assert.equal(input, 7_500_000);

  // 1M output is $25.00 — five times the input rate, which is the whole reason they are separate.
  const output = computeAgentCostMicros({
    model: OPUS,
    tokensIn: 0,
    tokensOut: 1_000_000,
    cachedIn: 0,
  });
  assert.equal(output, 37_500_000);
  assert.equal(output, input! * 5);

  // 1M cached input is a tenth of fresh input.
  const cached = computeAgentCostMicros({
    model: OPUS,
    tokensIn: 1_000_000,
    tokensOut: 0,
    cachedIn: 1_000_000,
  });
  assert.equal(cached, 750_000);
});

test('cachedIn is a subset of tokensIn and is not billed twice', () => {
  const halfCached = computeAgentCostMicros({
    model: OPUS,
    tokensIn: 1_000_000,
    tokensOut: 0,
    cachedIn: 500_000,
  });
  // 500k fresh at $5/MTok + 500k cached at $0.50/MTok = $2.75, times 1.5.
  assert.equal(halfCached, 4_125_000);
});

test('the margin is one configurable multiplier applied once', () => {
  assert.equal(DEFAULT_AGENT_MARGIN, 1.5);
  const raw = computeAgentCostMicros(
    { model: OPUS, tokensIn: 1_000_000, tokensOut: 0, cachedIn: 0 },
    1,
  );
  assert.equal(raw, 5_000_000);
  assert.equal(
    computeAgentCostMicros({ model: OPUS, tokensIn: 1_000_000, tokensOut: 0, cachedIn: 0 }, 2),
    10_000_000,
  );
});

test('a margin that is absent, malformed or below cost falls back to the default', () => {
  assert.equal(resolveAgentMargin(undefined), DEFAULT_AGENT_MARGIN);
  assert.equal(resolveAgentMargin(''), DEFAULT_AGENT_MARGIN);
  assert.equal(resolveAgentMargin('not-a-number'), DEFAULT_AGENT_MARGIN);
  assert.equal(resolveAgentMargin('0.5'), DEFAULT_AGENT_MARGIN);
  assert.equal(resolveAgentMargin('1'), 1);
  assert.equal(resolveAgentMargin('2.25'), 2.25);
});

test("the provider's own cost wins over the local table", () => {
  const cost = computeAgentCostMicros({
    model: OPUS,
    tokensIn: 1_000_000,
    tokensOut: 1_000_000,
    cachedIn: 0,
    providerCostUsd: 0.02,
  });
  // $0.02 = 20,000 µ$, times 1.5 — nothing to do with the token counts beside it.
  assert.equal(cost, 30_000);
});

test('a provider cost is honoured even for a model with no table entry', () => {
  const cost = computeAgentCostMicros({
    model: 'nobody/invented-this',
    tokensIn: 10,
    tokensOut: 10,
    cachedIn: 0,
    providerCostUsd: 0.001,
  });
  assert.equal(cost, 1_500);
});

test('a tiny call keeps its sub-cent value instead of rounding to a whole cent', () => {
  // 100 fresh input + 100 output on Opus: well under a hundredth of a cent, and it must survive.
  const cost = computeAgentCostMicros({ model: OPUS, tokensIn: 100, tokensOut: 100, cachedIn: 0 });
  assert.ok(cost! > 0, 'a real call must never price at zero');
  assert.ok(cost! < MICROS_PER_CENT, 'a call this small must not reach a whole cent');
  assert.equal(cost, 4_500);
});

test('the pre-flight estimate prices the whole output allowance', () => {
  const estimate = estimateAgentCostMicros({ model: OPUS, tokensIn: 10_000, maxTokensOut: 4_000 });
  // 10k input at $5/MTok + 4k output at $25/MTok = $0.15, times 1.5.
  assert.equal(estimate, 225_000);
  assert.equal(
    estimateAgentCostMicros({ model: 'nobody/invented-this', tokensIn: 1, maxTokensOut: 1 }),
    undefined,
  );
});

test('the money units are the ones the wallet and the ledger use', () => {
  assert.equal(MICROS_PER_USD, 100 * MICROS_PER_CENT);
});
