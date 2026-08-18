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
}

export interface AccountClient {
  /** Open the account's billing page in the system browser. Top-ups happen there, not in the app. */
  openBilling(): Promise<void>;

  /**
   * The account summary, or null when it cannot be fetched.
   *
   * Null rather than a thrown error on purpose: this is supporting detail on a screen the user wants
   * immediately, and the shell renders fine without it.
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
