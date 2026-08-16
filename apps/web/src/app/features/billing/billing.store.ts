import { Injectable, computed, inject, signal } from '@angular/core';

import { ApiClient } from '../../core/api/api.client';
import type {
  BillingOverview,
  CreditTransaction,
  Deposit,
  DepositInstruction,
  PaidPlanTier,
} from './billing.types';

/**
 * Billing state for the account area: Credit balance, packages, deposits and the statement.
 *
 * Holds the loaded data so the page can be re-entered without re-fetching, and so a purchase can
 * update the balance everywhere at once.
 */
@Injectable({ providedIn: 'root' })
export class BillingStore {
  private readonly api = inject(ApiClient);

  private readonly _overview = signal<BillingOverview | null>(null);
  private readonly _transactions = signal<CreditTransaction[]>([]);
  private readonly _deposits = signal<Deposit[]>([]);
  private readonly _loading = signal(false);
  private readonly _error = signal<string | null>(null);

  readonly overview = this._overview.asReadonly();
  readonly transactions = this._transactions.asReadonly();
  readonly deposits = this._deposits.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly error = this._error.asReadonly();

  readonly balanceCents = computed(() => this._overview()?.balanceCents ?? 0);
  readonly plans = computed(() => this._overview()?.plans ?? []);
  readonly chains = computed(() => this._overview()?.chains ?? []);
  readonly subscription = computed(() => this._overview()?.subscription ?? null);

  /** Cheap rails first, then the rest — the ordering the backend already sorted them into. */
  readonly recommendedChains = computed(() => this.chains().filter((c) => c.recommended));
  readonly otherChains = computed(() => this.chains().filter((c) => !c.recommended));

  async load(): Promise<void> {
    this._loading.set(true);
    this._error.set(null);
    try {
      // One round trip each, in parallel: the page renders all three and staggering them would
      // show three separate spinners resolving at different times.
      const [overview, transactions, deposits] = await Promise.all([
        this.api.get<BillingOverview>('/billing/overview'),
        this.api.get<CreditTransaction[]>('/billing/transactions?limit=25'),
        this.api.get<Deposit[]>('/billing/deposits?limit=10'),
      ]);
      this._overview.set(overview);
      this._transactions.set(transactions);
      this._deposits.set(deposits);
    } catch (err) {
      this._error.set(err instanceof Error ? err.message : 'could not load billing');
    } finally {
      this._loading.set(false);
    }
  }

  /** Request a deposit address. Throws on failure so the caller can surface it inline. */
  async createDeposit(amountCents: number, currencyCode: string): Promise<DepositInstruction> {
    const instruction = await this.api.post<DepositInstruction>('/billing/deposits', {
      amountCents,
      currencyCode,
    });
    // Refresh the pending list so the new deposit appears without a manual reload.
    void this.refreshDeposits();
    return instruction;
  }

  async purchase(tier: PaidPlanTier): Promise<void> {
    await this.api.post('/billing/purchase', { tier });
    // Reload rather than patch: a purchase changes the balance, the subscription AND the ledger,
    // and reconstructing all three client-side is how they drift apart.
    await this.load();
  }

  async setAutoRenew(autoRenew: boolean): Promise<void> {
    await this.api.post('/billing/auto-renew', { autoRenew });
    await this.load();
  }

  /** Poll for deposit progress while the user is watching the address. */
  async refreshDeposits(): Promise<void> {
    try {
      const [deposits, overview] = await Promise.all([
        this.api.get<Deposit[]>('/billing/deposits?limit=10'),
        this.api.get<BillingOverview>('/billing/overview'),
      ]);
      this._deposits.set(deposits);
      this._overview.set(overview);
    } catch {
      // A failed poll is not worth surfacing — the next tick retries, and the user is looking at a
      // payment address, not at this list.
    }
  }
}
