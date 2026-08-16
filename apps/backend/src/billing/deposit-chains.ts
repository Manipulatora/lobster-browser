import type { DepositChainOption } from '@lobster/shared-types';

/**
 * The chains a user may deposit on, ordered cheapest-first.
 *
 * WHY THIS LIST IS CURATED RATHER THAN FETCHED. NOWPayments supports hundreds of currencies.
 * Offering all of them is worse than offering eight: the user has to make an informed choice about
 * network economics in order to avoid overpaying, and almost nobody can. So the list is short,
 * every entry is a USD-stable asset or a major coin, and it is sorted by what it costs the user to
 * send.
 *
 * `networkFeeUsd` IS NOT OUR FEE AND NOT THE PROCESSOR'S. It is what the user's own wallet pays
 * the chain to broadcast the transfer, and it is the dominant cost on a small deposit — a $10
 * deposit over Tron loses 10-20% to the network before it arrives, while the same deposit over BSC
 * loses about a fiftieth of a cent. That spread is a property of the chains, not of NOWPayments,
 * and it is identical wherever the payment is processed. Surfacing it at the moment of choosing is
 * the only thing that actually reduces what users pay.
 *
 * TRON IS DELIBERATELY STILL HERE, and deliberately not recommended. It is the default habit for a
 * lot of people in this market and removing it would just send them away; the honest move is to
 * keep it available with its real cost printed next to it.
 *
 * FIGURES ARE INDICATIVE, measured 2026-08-14 from live chain state — Tron `getEnergyFee` at 100
 * SUN against 32k-65k energy with TRX at $0.332, BSC at 0.05 gwei against 55k gas with BNB at $606.
 * They move with gas prices and token prices, so treat them as an order of magnitude rather than a
 * quote. Re-measure before relying on the exact numbers.
 */
export const DEPOSIT_CHAINS: readonly DepositChainOption[] = [
  {
    code: 'usdcsol',
    chain: 'Solana',
    asset: 'USDC',
    networkFeeUsd: 0.001,
    recommended: true,
  },
  {
    code: 'usdtbsc',
    chain: 'BNB Smart Chain (BEP20)',
    asset: 'USDT',
    networkFeeUsd: 0.002,
    recommended: true,
  },
  {
    code: 'usdcbsc',
    chain: 'BNB Smart Chain (BEP20)',
    asset: 'USDC',
    networkFeeUsd: 0.002,
    recommended: true,
  },
  {
    code: 'usdcbase',
    chain: 'Base',
    asset: 'USDC',
    networkFeeUsd: 0.003,
    recommended: true,
  },
  {
    code: 'usdtmatic',
    chain: 'Polygon',
    asset: 'USDT',
    networkFeeUsd: 0.01,
    recommended: true,
  },
  {
    code: 'ltc',
    chain: 'Litecoin',
    asset: 'LTC',
    networkFeeUsd: 0.01,
    recommended: false,
  },
  {
    code: 'usdttrc20',
    chain: 'Tron (TRC20)',
    asset: 'USDT',
    // The expensive one, and the one users reach for by habit. 32k energy for an address that
    // already holds USDT, ~65k for one that does not — so a first-time depositor pays the top of
    // this range.
    networkFeeUsd: 1.6,
    recommended: false,
  },
  {
    code: 'usdterc20',
    chain: 'Ethereum (ERC20)',
    asset: 'USDT',
    // Wildly variable with base fee; this is a quiet-period figure and it can be several times
    // higher during congestion.
    networkFeeUsd: 1.5,
    recommended: false,
  },
  {
    code: 'btc',
    chain: 'Bitcoin',
    asset: 'BTC',
    networkFeeUsd: 1.0,
    recommended: false,
  },
];

/** Look up a chain option by its processor currency code. Unknown codes must be rejected. */
export function depositChainByCode(code: string): DepositChainOption | undefined {
  return DEPOSIT_CHAINS.find((c) => c.code === code);
}

/**
 * Smallest deposit we accept, in USD cents.
 *
 * Below this the economics stop working for the user rather than for us: NOWPayments enforces its
 * own per-currency minimum, and on an expensive chain the network fee alone can approach the
 * deposit. $5 keeps a Light package (one deposit, $10) two deposits away at worst.
 */
export const MIN_DEPOSIT_CENTS = 500;

/** Largest single deposit, in USD cents. A sanity bound, not a policy limit. */
export const MAX_DEPOSIT_CENTS = 10_000_00;
