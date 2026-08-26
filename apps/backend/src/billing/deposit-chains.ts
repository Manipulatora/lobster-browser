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
 * CODES ARE THE PROCESSOR'S, NOT OURS, so this list can drift out from under us when the processor
 * changes what it offers. It is checked rather than trusted: `NowPaymentsProvider` fetches the live
 * currency list and `supportsCurrency` returns false for anything missing from it, so an entry that
 * stops being offered disappears from the deposit UI instead of failing after the user has chosen
 * it. Four entries — `bnb`, `dot`, `usdctrc20`, `usdcerc20` — were removed when that check was
 * first run against the live API; three do not exist there at all and BNB's real code is `bnbbsc`.
 *
 * ADDING AN ENTRY MEANS CONFIRMING ITS NETWORK, not just that the code resolves. The code alone
 * does not say which chain the address will be on — NOWPayments has a bare `usdc` whose network is
 * only visible through the authenticated `/v1/full-currencies` — and a wrong `chain` label here
 * tells the user to send on a chain the address cannot receive, which loses the deposit. Two codes
 * below are actively misleading and were each read off `/v1/full-currencies` one at a time:
 * `usdcarc20` reads like Arbitrum and its network is `avaxc`, the AVALANCHE C-CHAIN (`usdtarb` is
 * the real Arbitrum one), and bare `avax` is the X-CHAIN asset, not the C-Chain most people mean.
 *
 * ADDING AN ENTRY ALSO MEANS CHECKING IT IS PAYABLE. `/v1/full-currencies` carries both `enable`
 * and `available_for_payment`, and a currency can be enabled while refusing payments — `busd` is
 * enabled with `available_for_payment: false` today, so it is deliberately absent.
 *
 * AND IT MEANS SHIPPING ITS ICONS. `icon` and `networkIcon` are slugs resolved as
 * `apps/web/public/coins/<slug>.svg`. A slug with no file behind it no longer vanishes — the picker
 * swaps in the neutral `generic.svg` — but that fallback makes an omission visible, not harmless:
 * a grey disc where a network badge belongs still fails to tell USDT-on-Tron from USDT-on-BNB, and
 * the badge is the only thing on the row that does. Ship the icon.
 */
export const DEPOSIT_CHAINS: readonly DepositChainOption[] = [
  // --- Stablecoins on cheap rails: what most people should use --------------
  {
    code: 'usdcsol',
    chain: 'Solana',
    asset: 'USDC',
    icon: 'usdc',
    networkIcon: 'sol',
    networkFeeUsd: 0.001,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdtsol',
    chain: 'Solana',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'sol',
    networkFeeUsd: 0.001,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdtbsc',
    chain: 'BNB Smart Chain (BEP20)',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'bnb',
    networkFeeUsd: 0.002,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdcbsc',
    chain: 'BNB Smart Chain (BEP20)',
    asset: 'USDC',
    icon: 'usdc',
    networkIcon: 'bnb',
    networkFeeUsd: 0.002,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdcbase',
    chain: 'Base',
    asset: 'USDC',
    icon: 'usdc',
    networkIcon: 'base',
    networkFeeUsd: 0.003,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdtmatic',
    chain: 'Polygon',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'matic',
    networkFeeUsd: 0.004,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdcmatic',
    chain: 'Polygon',
    asset: 'USDC',
    icon: 'usdc',
    networkIcon: 'matic',
    networkFeeUsd: 0.004,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdtop',
    chain: 'Optimism',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'op',
    networkFeeUsd: 0.01,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdcop',
    chain: 'Optimism',
    asset: 'USDC',
    icon: 'usdc',
    networkIcon: 'op',
    networkFeeUsd: 0.01,
    recommended: true,
    stable: true,
  },
  {
    code: 'usdtton',
    chain: 'TON',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'ton',
    networkFeeUsd: 0.01,
    recommended: true,
    stable: true,
  },
  {
    // The Arbitrum USDT. Not to be confused with `usdcarc20` below, which is Avalanche.
    code: 'usdtarb',
    chain: 'Arbitrum One',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'arbitrum',
    networkFeeUsd: 0.02,
    recommended: true,
    stable: true,
  },
  {
    // `arc20` reads like Arbitrum and is not: `/v1/full-currencies` gives this code the network
    // `avaxc`, the Avalanche C-Chain. An Arbitrum address cannot receive it.
    code: 'usdcarc20',
    chain: 'Avalanche C-Chain',
    asset: 'USDC',
    icon: 'usdc',
    networkIcon: 'avax',
    networkFeeUsd: 0.03,
    recommended: true,
    stable: true,
  },

  // --- Native coins and other non-pegged assets -----------------------------
  // A native coin carries no `networkIcon`: the asset IS the chain, so a badge would repeat the
  // icon underneath it. Tokens down here (LINK, SHIB) do carry one, because their chain is a
  // separate fact from the coin.
  {
    code: 'sol',
    chain: 'Solana',
    asset: 'SOL',
    icon: 'sol',
    networkFeeUsd: 0.001,
    recommended: false,
    stable: false,
  },
  {
    code: 'xlm',
    chain: 'Stellar',
    asset: 'XLM',
    icon: 'xlm',
    networkFeeUsd: 0.001,
    recommended: false,
    stable: false,
  },
  {
    code: 'near',
    chain: 'NEAR',
    asset: 'NEAR',
    icon: 'near',
    networkFeeUsd: 0.001,
    recommended: false,
    stable: false,
  },
  {
    code: 'apt',
    chain: 'Aptos',
    asset: 'APT',
    icon: 'apt',
    networkFeeUsd: 0.001,
    recommended: false,
    stable: false,
  },
  {
    code: 'sui',
    chain: 'Sui',
    asset: 'SUI',
    icon: 'sui',
    networkFeeUsd: 0.002,
    recommended: false,
    stable: false,
  },
  {
    code: 'bnbbsc',
    chain: 'BNB Smart Chain (BEP20)',
    asset: 'BNB',
    icon: 'bnb',
    networkFeeUsd: 0.005,
    recommended: false,
    stable: false,
  },
  {
    code: 'matic',
    chain: 'Polygon',
    asset: 'POL',
    icon: 'matic',
    networkFeeUsd: 0.005,
    recommended: false,
    stable: false,
  },
  {
    code: 'xrp',
    chain: 'XRP Ledger',
    asset: 'XRP',
    icon: 'xrp',
    networkFeeUsd: 0.01,
    recommended: false,
    stable: false,
  },
  {
    code: 'bch',
    chain: 'Bitcoin Cash',
    asset: 'BCH',
    icon: 'bch',
    networkFeeUsd: 0.01,
    recommended: false,
    stable: false,
  },
  {
    // NOWPayments names this one "Gram (ex Ton/TonCoin)"; the asset users know is TON.
    code: 'ton',
    chain: 'TON',
    asset: 'TON',
    icon: 'ton',
    networkFeeUsd: 0.01,
    recommended: false,
    stable: false,
  },
  {
    code: 'atom',
    chain: 'Cosmos Hub',
    asset: 'ATOM',
    icon: 'atom',
    networkFeeUsd: 0.01,
    recommended: false,
    stable: false,
  },
  {
    code: 'ltc',
    chain: 'Litecoin',
    asset: 'LTC',
    icon: 'ltc',
    networkFeeUsd: 0.02,
    recommended: false,
    stable: false,
  },
  {
    code: 'dash',
    chain: 'Dash',
    asset: 'DASH',
    icon: 'dash',
    networkFeeUsd: 0.02,
    recommended: false,
    stable: false,
  },
  {
    code: 'xmr',
    chain: 'Monero',
    asset: 'XMR',
    icon: 'xmr',
    networkFeeUsd: 0.02,
    recommended: false,
    stable: false,
  },
  {
    // The bare `avax` code is the X-Chain asset — `/v1/full-currencies` gives it the network
    // `xchain`, not `avaxc`. A C-Chain (0x…) address cannot receive it.
    code: 'avax',
    chain: 'Avalanche X-Chain',
    asset: 'AVAX',
    icon: 'avax',
    networkFeeUsd: 0.02,
    recommended: false,
    stable: false,
  },
  {
    code: 'ada',
    chain: 'Cardano',
    asset: 'ADA',
    icon: 'ada',
    networkFeeUsd: 0.12,
    recommended: false,
    stable: false,
  },
  {
    code: 'doge',
    chain: 'Dogecoin',
    asset: 'DOGE',
    icon: 'doge',
    networkFeeUsd: 0.15,
    recommended: false,
    stable: false,
  },
  {
    code: 'trx',
    chain: 'Tron (TRC20)',
    asset: 'TRX',
    icon: 'trx',
    networkFeeUsd: 0.3,
    recommended: false,
    stable: false,
  },
  {
    code: 'btc',
    chain: 'Bitcoin',
    asset: 'BTC',
    icon: 'btc',
    networkFeeUsd: 1.5,
    recommended: false,
    stable: false,
  },
  {
    code: 'eth',
    chain: 'Ethereum (ERC20)',
    asset: 'ETH',
    icon: 'eth',
    networkFeeUsd: 2.0,
    recommended: false,
    stable: false,
  },
  {
    code: 'link',
    chain: 'Ethereum (ERC20)',
    asset: 'LINK',
    icon: 'link',
    networkIcon: 'eth',
    networkFeeUsd: 2.5,
    recommended: false,
    stable: false,
  },
  {
    code: 'shib',
    chain: 'Ethereum (ERC20)',
    asset: 'SHIB',
    icon: 'shib',
    networkIcon: 'eth',
    networkFeeUsd: 2.5,
    recommended: false,
    stable: false,
  },

  // --- Stablecoins on rails that are popular but genuinely expensive --------
  {
    code: 'usdttrc20',
    chain: 'Tron (TRC20)',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'trx',
    networkFeeUsd: 1.2,
    recommended: false,
    stable: true,
  },
  {
    code: 'usdterc20',
    chain: 'Ethereum (ERC20)',
    asset: 'USDT',
    icon: 'usdt',
    networkIcon: 'eth',
    networkFeeUsd: 3.0,
    recommended: false,
    stable: true,
  },
  {
    code: 'dai',
    chain: 'Ethereum (ERC20)',
    asset: 'DAI',
    icon: 'dai',
    networkIcon: 'eth',
    networkFeeUsd: 3.0,
    recommended: false,
    stable: true,
  },
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
 *
 * IT IS NOT THE ONLY FLOOR, and on some coins it is not the binding one. The processor's own
 * per-currency minimum is quoted by `/v1/min-amount` and varies by orders of magnitude: measured in
 * USD it was ~$0.02 on `usdcbase` but $11.46 on `usdttrc20` and $20.62 on `btc`. A $5–$20 BTC
 * deposit therefore passes this check and is rejected by the processor with AMOUNT_MINIMAL_ERROR
 * only after the user has picked a coin, which the production journal shows happening for real.
 * Fixing it means surfacing the live per-currency minimum in the picker, not raising this constant
 * to the worst coin's floor — that would price everyone out of the cheap rails to protect BTC.
 */
export const MIN_DEPOSIT_CENTS = 500;

/** Largest single deposit, in USD cents. A sanity bound, not a policy limit. */
export const MAX_DEPOSIT_CENTS = 10_000_00;
