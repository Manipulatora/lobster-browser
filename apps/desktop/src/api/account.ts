import { invoke } from '@tauri-apps/api/core';

import { isDesktopRuntime } from './tauri';

/** Balance, plan and profile allowance for the signed-in account. */
export interface AccountSummary {
  /** Credit balance in USD cents. Rendered as Credit, never with a currency symbol. */
  balanceCents: number;
  /** `free` | `light` | `plus` | `pro` | `max`. A lapsed subscription reports `free`. */
  tier: string;
  /** Profiles this plan allows — the cap the server actually enforces on create. */
  profileLimit: number;
  /**
   * When the next renewal is charged, ISO-8601. Absent on `free`, and absent once auto-renew is off
   * — there is no next payment to name, and showing the period end as one would promise a charge
   * that will not happen.
   */
  nextBillingAt?: string;
}

/**
 * What the sidebar knows about the account right now.
 *
 * ONE STATE PER MEANING. This replaced a bare `AccountSummary | null`, where `null` stood for
 * "still loading", "signed out", "offline", "token rejected", "billing returned 500" and "the
 * payload did not parse" — all six rendering as nothing at all. The user's report was simply that
 * the plan area was not there, and the UI had no way to say which of the six it was, or to offer a
 * retry. Each state now renders something, and `loading` is distinguishable from `error`.
 */
export type AccountState =
  | { kind: 'loading' }
  | { kind: 'ready'; summary: AccountSummary }
  /** A session is held but the API could not be reached. Not signed out — see auth_status. */
  | { kind: 'offline' }
  /** Reached, and refused or malformed. Retrying may work; signing in again may be required. */
  | { kind: 'error' };

export interface AccountClient {
  /** Open the account's billing page in the system browser. Top-ups happen there, not in the app. */
  openBilling(): Promise<void>;

  /**
   * The account summary, or null when it cannot be fetched.
   *
   * Null rather than a thrown error on purpose: this is supporting detail on a screen the user wants
   * immediately, and the shell renders fine without it. Callers map null onto an {@link AccountState}
   * so the distinction reaches the UI.
   */
  summary(): Promise<AccountSummary | null>;
}

const tauriAccount: AccountClient = {
  summary: () => invoke<AccountSummary | null>('account_summary'),
  openBilling: () => invoke<void>('open_billing'),
};

/** In-browser development: plausible numbers so the shell can be worked on without the Rust core. */
const mockAccount: AccountClient = {
  summary: async () => ({ balanceCents: 12_00, tier: 'pro', profileLimit: 200 }),
  openBilling: async () => {
    window.open('https://lobrowser.com/account/billing', '_blank', 'noopener');
  },
};

export const accountClient: AccountClient = isDesktopRuntime() ? tauriAccount : mockAccount;

/** Plan ids are lowercase on the wire; the UI shows them capitalised. */
export function planLabel(tier: string): string {
  return tier.charAt(0).toUpperCase() + tier.slice(1);
}

/**
 * Credit, formatted the way the billing page formats it: two decimals and the word, never a `$`.
 *
 * Credit is a prepaid balance that happens to be denominated 1:1 in USD. Printing "$12.00" invites
 * the reading that dollars are sitting there withdrawable.
 */
export function formatCredit(cents: number): string {
  return `${(cents / 100).toFixed(2)} Credit`;
}
