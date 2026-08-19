/**
 * Balances are shown in Credit, never with a currency symbol.
 *
 * Credit is what the account actually holds — a prepaid balance that happens to be denominated
 * 1:1 in USD. Printing "$12.00" invites the reading that dollars are sitting there withdrawable;
 * "12.00 Credit" says what it is.
 *
 * THE single formatter, so the figure a confirmation dialog quotes and the figure the account page
 * shows are written the same way. `cents` is an integer count of cents, as everything on the
 * billing wire is.
 */
export function formatCredit(cents: number): string {
  return `${(cents / 100).toFixed(2)} Credit`;
}
