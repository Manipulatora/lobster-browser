import { DOCUMENT, DatePipe, TitleCasePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { BillingStore } from './billing.store';
import type { DepositInstruction, PaidPlanTier, PlanDefinition } from './billing.types';

/** Preset top-up amounts, in USD cents. Chosen to line up with the package prices. */
const PRESETS = [1_000, 6_000, 10_000, 20_000];

/** How often to re-check a pending deposit while the address is on screen. */
const POLL_MS = 15_000;

/**
 * Account billing: Credit balance, top-ups, and packages.
 *
 * THE MODEL, as the user sees it. Credit is a prepaid balance in USD, topped up with crypto in any
 * amount at any time. Buying a package deducts from it. There is no card and no recurring mandate
 * against anything outside the account — monthly renewal is another deduction from the same
 * balance, and if there is not enough, the package pauses instead of anything being chased.
 */
@Component({
  selector: 'app-billing-page',
  imports: [FormsModule, DatePipe, TitleCasePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './billing-page.html',
})
export class BillingPage {
  private readonly billing = inject(BillingStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  protected readonly presets = PRESETS;
  protected readonly loading = this.billing.loading;
  protected readonly error = this.billing.error;
  protected readonly balanceCents = this.billing.balanceCents;
  protected readonly plans = this.billing.plans;
  protected readonly subscription = this.billing.subscription;
  protected readonly transactions = this.billing.transactions;
  protected readonly deposits = this.billing.deposits;
  protected readonly recommendedChains = this.billing.recommendedChains;
  protected readonly otherChains = this.billing.otherChains;
  protected readonly user = this.auth.user;

  // --- Top-up form ---------------------------------------------------------
  protected readonly amountCents = signal(1_000);
  protected readonly chainCode = signal('');
  protected readonly showAllChains = signal(false);
  protected readonly instruction = signal<DepositInstruction | null>(null);
  protected readonly depositError = signal<string | null>(null);
  protected readonly creatingDeposit = signal(false);
  protected readonly copied = signal<'address' | 'amount' | null>(null);

  // --- Purchase ------------------------------------------------------------
  protected readonly purchasing = signal<PaidPlanTier | null>(null);
  protected readonly purchaseError = signal<string | null>(null);

  protected readonly currentTier = computed(() => this.subscription()?.tier ?? 'free');
  protected readonly isPastDue = computed(() => this.subscription()?.status === 'past_due');

  /** Dollars, for the amount input. Kept separate so the field can be edited freely. */
  protected readonly amountDollars = computed(() => (this.amountCents() / 100).toFixed(2));

  private pollTimer?: ReturnType<typeof setInterval>;

  constructor() {
    void this.init();
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  private async init(): Promise<void> {
    // The page is behind a guard, but a direct load races the token restore — wait for it rather
    // than firing an unauthenticated request that would clear the token on 401.
    await this.auth.restore();
    if (!this.auth.isAuthenticated()) {
      void this.router.navigate(['/login']);
      return;
    }
    await this.billing.load();
    // Preselect the first recommended (cheapest) rail.
    const first = this.recommendedChains()[0];
    if (first && !this.chainCode()) this.chainCode.set(first.code);
  }

  protected formatUsd(cents: number): string {
    return `$${(cents / 100).toFixed(2)}`;
  }

  /** Ledger amounts are signed; the statement renders the sign separately from the magnitude. */
  protected abs(value: number): number {
    return Math.abs(value);
  }

  /** Network fees span three orders of magnitude, so a fixed precision reads as "$0.00" or "$1.60000". */
  protected formatFee(usd: number): string {
    if (usd < 0.01) return '<$0.01';
    return `$${usd.toFixed(2)}`;
  }

  protected planIsCurrent(plan: PlanDefinition): boolean {
    return this.currentTier() === plan.tier && this.subscription()?.status === 'active';
  }

  protected canAfford(plan: PlanDefinition): boolean {
    return this.balanceCents() >= plan.priceCents;
  }

  protected shortfall(plan: PlanDefinition): number {
    return Math.max(0, plan.priceCents - this.balanceCents());
  }

  protected setPreset(cents: number): void {
    this.amountCents.set(cents);
  }

  protected onAmountInput(value: string): void {
    const dollars = Number.parseFloat(value);
    if (!Number.isFinite(dollars) || dollars < 0) return;
    // Round at the point of entry so the value sent to the API is always a whole number of cents;
    // 10.005 must not reach the backend as a fractional cent.
    this.amountCents.set(Math.round(dollars * 100));
  }

  protected async createDeposit(): Promise<void> {
    if (this.creatingDeposit()) return;
    this.depositError.set(null);
    this.creatingDeposit.set(true);
    try {
      const instruction = await this.billing.createDeposit(this.amountCents(), this.chainCode());
      this.instruction.set(instruction);
      this.startPolling();
    } catch (err) {
      this.depositError.set(err instanceof Error ? err.message : 'could not create a deposit');
    } finally {
      this.creatingDeposit.set(false);
    }
  }

  protected dismissInstruction(): void {
    this.instruction.set(null);
    this.stopPolling();
  }

  protected async copy(text: string, what: 'address' | 'amount'): Promise<void> {
    try {
      await this.document.defaultView?.navigator.clipboard.writeText(text);
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1_800);
    } catch {
      // Clipboard access can be denied; the value is visible and selectable either way.
    }
  }

  protected async purchase(plan: PlanDefinition): Promise<void> {
    if (this.purchasing()) return;
    this.purchaseError.set(null);
    this.purchasing.set(plan.tier);
    try {
      await this.billing.purchase(plan.tier);
    } catch (err) {
      this.purchaseError.set(err instanceof Error ? err.message : 'purchase failed');
    } finally {
      this.purchasing.set(null);
    }
  }

  protected async toggleAutoRenew(): Promise<void> {
    const current = this.subscription();
    if (!current) return;
    try {
      await this.billing.setAutoRenew(!current.autoRenew);
    } catch (err) {
      this.purchaseError.set(err instanceof Error ? err.message : 'could not change auto-renew');
    }
  }

  /**
   * Poll while a payment address is displayed.
   *
   * Crediting is driven by the processor's webhook, so the balance can change without the user
   * doing anything. Polling is how the page notices; the alternative is a socket, which is a lot of
   * machinery for a screen someone has open for a couple of minutes.
   */
  private startPolling(): void {
    this.stopPolling();
    this.pollTimer = setInterval(() => {
      void this.billing.refreshDeposits();
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
