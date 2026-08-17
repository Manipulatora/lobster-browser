import type { DepositChainOption } from '@lobster/shared-types';

/**
 * The chains a user may deposit on, ordered cheapest-first.
 *
 * `networkFeeUsd` IS NOT OUR FEE AND NOT THE PROCESSOR'S. It is what the user's own wallet pays the
 * chain to broadcast the transfer, and it is the dominant cost on a small deposit — a $10 deposit
 * over Ethereum can lose a fifth of its value to gas before it arrives, while the same deposit over
 * BSC or Solana loses a fraction of a cent. That spread is a property of the chains, not of the
 * processor, and surfacing it at the moment of choosing is the only thing that actually reduces
 * what users pay. Sorting by it is therefore the sort order that matters.
 *
 * EXPENSIVE RAILS ARE STILL LISTED, and still not recommended. Ethereum and Tron are the default
 * habit for a lot of people; removing them sends those users away rather than helping them. The
 * honest move is to keep them available with their real cost printed alongside.
 *
 * FIGURES ARE INDICATIVE, an order of magnitude rather than a quote — they move with gas and token
 * prices. Re-measure before relying on the exact numbers.
 *
 * THIS LIST IS ASPIRATIONAL UNTIL VERIFIED. Which pairs a processor actually offers is an account
 * fact, not a constant: `CryptomusProvider.assertServicesCover()` checks every code here against
 * the live service table and refuses any it cannot find, so an entry that turns out to be
 * unsupported fails closed at deposit time instead of stranding a payment.
 */
export const DEPOSIT_CHAINS: readonly DepositChainOption[] = [
  // --- Stablecoins on cheap rails: what most people should use --------------
  { code: 'usdcsol',   chain: 'Solana',                  asset: 'USDC', icon: 'usdc', networkIcon: 'sol',   networkFeeUsd: 0.001, recommended: true,  stable: true },
  { code: 'usdtsol',   chain: 'Solana',                  asset: 'USDT', icon: 'usdt', networkIcon: 'sol',   networkFeeUsd: 0.001, recommended: true,  stable: true },
  { code: 'usdtbsc',   chain: 'BNB Smart Chain (BEP20)', asset: 'USDT', icon: 'usdt', networkIcon: 'bnb',   networkFeeUsd: 0.002, recommended: true,  stable: true },
  { code: 'usdcbsc',   chain: 'BNB Smart Chain (BEP20)', asset: 'USDC', icon: 'usdc', networkIcon: 'bnb',   networkFeeUsd: 0.002, recommended: true,  stable: true },
  { code: 'usdcbase',  chain: 'Base',                    asset: 'USDC', icon: 'usdc', networkIcon: 'base',  networkFeeUsd: 0.003, recommended: true,  stable: true },
  { code: 'usdtmatic', chain: 'Polygon',                 asset: 'USDT', icon: 'usdt', networkIcon: 'matic', networkFeeUsd: 0.004, recommended: true,  stable: true },
  { code: 'usdcmatic', chain: 'Polygon',                 asset: 'USDC', icon: 'usdc', networkIcon: 'matic', networkFeeUsd: 0.004, recommended: true,  stable: true },

  // --- Native coins ---------------------------------------------------------
  // No `networkIcon`: the asset IS the chain, so a badge would repeat the icon underneath it.
  { code: 'sol',       chain: 'Solana',                  asset: 'SOL',  icon: 'sol',                        networkFeeUsd: 0.001, recommended: false, stable: false },
  { code: 'bnb',       chain: 'BNB Smart Chain (BEP20)', asset: 'BNB',  icon: 'bnb',                        networkFeeUsd: 0.005, recommended: false, stable: false },
  { code: 'matic',     chain: 'Polygon',                 asset: 'POL',  icon: 'matic',                      networkFeeUsd: 0.005, recommended: false, stable: false },
  { code: 'xlm',       chain: 'Stellar',                 asset: 'XLM',  icon: 'xlm',                        networkFeeUsd: 0.001, recommended: false, stable: false },
  { code: 'xrp',       chain: 'XRP Ledger',              asset: 'XRP',  icon: 'xrp',                        networkFeeUsd: 0.01,  recommended: false, stable: false },
  { code: 'bch',       chain: 'Bitcoin Cash',            asset: 'BCH',  icon: 'bch',                        networkFeeUsd: 0.01,  recommended: false, stable: false },
  { code: 'ltc',       chain: 'Litecoin',                asset: 'LTC',  icon: 'ltc',                        networkFeeUsd: 0.02,  recommended: false, stable: false },
  { code: 'dash',      chain: 'Dash',                    asset: 'DASH', icon: 'dash',                       networkFeeUsd: 0.02,  recommended: false, stable: false },
  { code: 'xmr',       chain: 'Monero',                  asset: 'XMR',  icon: 'xmr',                        networkFeeUsd: 0.02,  recommended: false, stable: false },
  { code: 'dot',       chain: 'Polkadot',                asset: 'DOT',  icon: 'dot',                        networkFeeUsd: 0.05,  recommended: false, stable: false },
  { code: 'ada',       chain: 'Cardano',                 asset: 'ADA',  icon: 'ada',                        networkFeeUsd: 0.12,  recommended: false, stable: false },
  { code: 'doge',      chain: 'Dogecoin',                asset: 'DOGE', icon: 'doge',                       networkFeeUsd: 0.15,  recommended: false, stable: false },
  { code: 'trx',       chain: 'Tron (TRC20)',            asset: 'TRX',  icon: 'trx',                        networkFeeUsd: 0.3,   recommended: false, stable: false },
  { code: 'btc',       chain: 'Bitcoin',                 asset: 'BTC',  icon: 'btc',                        networkFeeUsd: 1.5,   recommended: false, stable: false },
  { code: 'eth',       chain: 'Ethereum (ERC20)',        asset: 'ETH',  icon: 'eth',                        networkFeeUsd: 2.0,   recommended: false, stable: false },
  { code: 'link',      chain: 'Ethereum (ERC20)',        asset: 'LINK', icon: 'link', networkIcon: 'eth',   networkFeeUsd: 2.5,   recommended: false, stable: false },

  // --- Stablecoins on rails that are popular but genuinely expensive --------
  { code: 'usdttrc20', chain: 'Tron (TRC20)',            asset: 'USDT', icon: 'usdt', networkIcon: 'trx',   networkFeeUsd: 1.2,   recommended: false, stable: true },
  { code: 'usdctrc20', chain: 'Tron (TRC20)',            asset: 'USDC', icon: 'usdc', networkIcon: 'trx',   networkFeeUsd: 1.2,   recommended: false, stable: true },
  { code: 'usdterc20', chain: 'Ethereum (ERC20)',        asset: 'USDT', icon: 'usdt', networkIcon: 'eth',   networkFeeUsd: 3.0,   recommended: false, stable: true },
  { code: 'usdcerc20', chain: 'Ethereum (ERC20)',        asset: 'USDC', icon: 'usdc', networkIcon: 'eth',   networkFeeUsd: 3.0,   recommended: false, stable: true },
];

/** Look up a chain by its processor code. Unknown codes are rejected, never forwarded. */
export function depositChainByCode(code: string): DepositChainOption | undefined {
  return DEPOSIT_CHAINS.find((c) => c.code === code);
}

/**
 * Smallest deposit we accept, in USD cents.
 *
 * Below this the economics stop working for the user rather than for us: the processor enforces its
 * own per-currency minimum, and on an expensive chain the network fee alone can approach the
 * deposit. $5 keeps a Light package (one deposit, $10) two deposits away at worst.
 */
export const MIN_DEPOSIT_CENTS = 500;

/** Largest single deposit, in USD cents. A sanity bound, not a policy limit. */
export const MAX_DEPOSIT_CENTS = 10_000_00;
