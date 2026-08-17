import type { DepositStatus } from '@lobster/shared-types';

/** A deposit address issued by the processor for the user to send funds to. */
export interface CreatedDeposit {
  /** The processor's id for this payment, used as our idempotency key. */
  providerPaymentId: string;
  /** The address the user sends to. */
  address: string;
  /** Exact decimal string of the amount to send in `asset`. */
  amountCrypto: string;
  asset: string;
  chain: string;
  /** Optional hosted payment page, when the processor offers one. */
  hostedUrl?: string;
  /** ISO instant after which the quoted rate/address is no longer valid, when known. */
  expiresAt?: string;
}

/** A verified, normalised webhook from the processor. */
export interface ParsedWebhook {
  providerPaymentId: string;
  status: DepositStatus;
  /**
   * USD cents to credit. Present ONLY when `status` is `confirmed`, i.e. the processor has
   * settled and the money is really ours — never on an intermediate status.
   */
  creditCents?: number;
  txHash?: string;
  amountCrypto?: string;
  /** The raw payload, retained for dispute resolution. */
  raw: Record<string, unknown>;
}

/**
 * A crypto payment processor.
 *
 * WHY THIS INTERFACE EXISTS with exactly one implementation. Not speculative generality — it
 * pins down the two things that must not leak into business logic. `createDeposit` keeps
 * processor-specific currency codes (`usdtbsc` and friends) out of the service, and
 * `verifyWebhook` makes signature verification a precondition of parsing rather than a step a
 * caller might forget: the method returns null for anything unverified, so there is no way to
 * obtain a `ParsedWebhook` from an unauthenticated request.
 *
 * The rest of the codebase never names a processor. Swapping or adding one is a change to this
 * directory and a config value.
 */
export interface PaymentProvider {
  /** Stable slug persisted on each `Deposit` row, e.g. `nowpayments`. */
  readonly name: string;

  /** True when the processor is configured well enough to be used (API key present, etc.). */
  isConfigured(): boolean;

  /**
   * Will this processor actually accept `currencyCode` right now?
   *
   * Asked so the account page can OMIT rails that would be refused rather than offering one and
   * failing after the user has committed. It is a claim about this processor's current state, not
   * about the curated catalogue — a code can be perfectly valid and still be unavailable here.
   */
  supportsCurrency(currencyCode: string): boolean;

  createDeposit(args: {
    /** Amount the user wants to add to their Credit, in USD cents. */
    amountCents: number;
    /** Processor currency code chosen by the user, e.g. `usdtbsc`. */
    currencyCode: string;
    /** Our own reference, echoed back on the webhook. */
    orderId: string;
  }): Promise<CreatedDeposit>;

  /**
   * Verify and parse an inbound webhook.
   *
   * @param rawBody the EXACT bytes received — see the NOWPayments implementation for why the
   *                parsed object is not good enough on its own.
   * @returns the normalised event, or null if the signature did not verify.
   */
  verifyWebhook(rawBody: Buffer, headers: Record<string, string | string[] | undefined>): ParsedWebhook | null;
}

/** Nest DI token for the active `PaymentProvider`. */
export const PAYMENT_PROVIDER = Symbol('PaymentProvider');
