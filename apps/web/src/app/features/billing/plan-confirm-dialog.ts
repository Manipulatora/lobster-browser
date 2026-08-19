import { DatePipe } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  computed,
  effect,
  inject,
  input,
  output,
  signal,
  untracked,
} from '@angular/core';
import { Router } from '@angular/router';

import { BillingStore } from './billing.store';
import { formatCredit } from './credit';
import type { BillingPeriod, PaidPlanTier, PlanChangeQuote } from './billing.types';

/**
 * The stop between choosing a package and paying for it.
 *
 * DELIBERATELY SMALL. This is a confirmation, not a checkout: the decision was made on the card
 * that opened it, and everything here exists to answer one question — what leaves the balance, and
 * what is left afterwards. Anything more turns a two-second confirmation into a second shopping
 * screen.
 *
 * EVERY FIGURE COMES FROM THE SERVER, fetched when the dialog opens. An upgrade credits the unused
 * remainder of the current period, which depends on the real period bounds and the server's clock;
 * quoting a locally-computed number and then charging a different one is the one thing a
 * confirmation must never do.
 *
 * Shared by the pricing table and the account page so the two cannot drift into telling different
 * stories about the same purchase.
 */
@Component({
  selector: 'app-plan-confirm-dialog',
  imports: [DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plan-confirm-dialog.html',
})
export class PlanConfirmDialog {
  readonly tier = input.required<PaidPlanTier>();
  readonly period = input.required<BillingPeriod>();

  /** The user backed out, or is done reading a refusal. */
  readonly closed = output<void>();

  private readonly billing = inject(BillingStore);
  private readonly router = inject(Router);

  protected readonly quote = signal<PlanChangeQuote | null>(null);
  protected readonly loading = signal(true);
  protected readonly submitting = signal(false);
  protected readonly error = signal<string | null>(null);
  /** Set once the debit has actually landed; the panel then reports what changed. */
  protected readonly done = signal(false);

  protected readonly balanceCents = this.billing.balanceCents;
  protected readonly formatCredit = formatCredit;

  /** Plan names come from the catalog the server sent, so they cannot drift from what it charges. */
  protected readonly planName = computed(
    () => this.billing.plans().find((p) => p.tier === this.tier())?.name ?? this.tier(),
  );

  protected readonly termLabel = computed(() =>
    this.period() === 'yearly' ? 'Billed yearly' : 'Billed monthly',
  );

  /** True when the change is allowed and the balance covers it — the only state that can pay. */
  protected readonly payable = computed(() => {
    const quote = this.quote();
    return quote !== null && quote.allowed && quote.shortfallCents === 0;
  });

  constructor() {
    // Re-quoted whenever the package or the term changes, so reopening the dialog on a different
    // card can never show the previous card's figures. The fetch runs untracked: it reads store
    // signals of its own, and depending on those would re-quote whenever the account page reloaded
    // the overview underneath an open dialog.
    effect(() => {
      const tier = this.tier();
      const period = this.period();
      untracked(() => void this.loadQuote(tier, period));
    });
  }

  private async loadQuote(tier: PaidPlanTier, period: BillingPeriod): Promise<void> {
    this.loading.set(true);
    this.error.set(null);
    this.done.set(false);
    this.quote.set(null);
    try {
      // The catalog is what package NAMES are read from, and the pricing page can open this before
      // its own overview request has landed — without it the dialog would title itself after a
      // wire value ("Confirm pro") on the one screen that has to read like a receipt.
      if (!this.billing.loaded()) await this.billing.load();
      this.quote.set(await this.billing.quote(tier, period));
    } catch (err) {
      this.error.set(err instanceof Error ? err.message : 'could not price this package');
    } finally {
      this.loading.set(false);
    }
  }

  /** What this change is, in the words the user should see. */
  protected title(): string {
    const quote = this.quote();
    if (this.done()) return 'You are on ' + this.planName();
    switch (quote?.kind) {
      case 'upgrade':
        return `Upgrade to ${this.planName()}`;
      case 'extend':
        return `Switch ${this.planName()} to yearly`;
      case 'same':
        return `You are already on ${this.planName()}`;
      case 'downgrade':
      case 'shorten':
        return `${this.planName()} cannot start yet`;
      default:
        return `Confirm ${this.planName()}`;
    }
  }

  protected primaryLabel(): string {
    if (this.submitting()) return 'Paying…';
    return this.quote()?.kind === 'upgrade' ? 'Confirm & upgrade' : 'Confirm & pay';
  }

  /**
   * Why a refused change is refused, and what to do instead.
   *
   * Spelled out here rather than left to the server's error text, because the user has not pressed
   * anything yet — this is the state the dialog OPENS in for these three, so it has to read as an
   * explanation rather than as a failure.
   */
  protected refusal(): string {
    const quote = this.quote();
    if (!quote) return '';
    switch (quote.kind) {
      case 'same':
        return quote.currentPeriod === 'yearly'
          ? 'This is the package you are on, paid twelve months up front.'
          : 'This is the package you are on. It renews from your Credit balance on the date below.';
      case 'downgrade':
        return (
          `You have already paid for ${this.currentName()} to the date below, and it stays that ` +
          `way. To move to ${this.planName()}, turn auto-renew off and buy it once the current ` +
          `package ends — nothing else changes in the meantime.`
        );
      case 'shorten':
        return (
          `Your ${this.currentName()} package is paid twelve months up front, to the date below. ` +
          `Choosing the yearly term moves you across now; a monthly one has to wait until the ` +
          `year ends.`
        );
      default:
        return '';
    }
  }

  /** The name of the package in force, for a refusal that has to talk about both. */
  protected currentName(): string {
    const tier = this.quote()?.currentTier;
    if (!tier || tier === 'free') return 'your current package';
    return this.billing.plans().find((p) => p.tier === tier)?.name ?? tier;
  }

  /**
   * Pay for the package.
   *
   * The in-flight guard is the first line, not the only one: the button is disabled while
   * `submitting` and the server refuses a second attempt priced against a period the first one
   * already replaced. A disabled button alone would not survive a slow network and an impatient
   * double-tap.
   */
  protected async confirm(): Promise<void> {
    const quote = this.quote();
    if (!quote || !this.payable() || this.submitting()) return;

    this.submitting.set(true);
    this.error.set(null);
    try {
      await this.billing.purchase(quote.tier, quote.period);
      // The store reloaded the overview, so the balance and the package on screen are already the
      // new ones — the panel below reads them straight out of it.
      this.done.set(true);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'the purchase did not go through';
      // A refusal usually means the state moved underneath this dialog — the package changed in
      // another tab, or this one was submitted twice. Re-price before showing the message, so the
      // figures on screen are not ones the server has just disagreed with. The purchase's own
      // message is restored afterwards: it is the more useful of the two.
      await this.billing.load();
      await this.loadQuote(quote.tier, quote.period);
      this.error.set(message);
    } finally {
      this.submitting.set(false);
    }
  }

  /** Not enough Credit is a next step, not a dead end: go where Credit is added. */
  protected topUp(): void {
    this.closed.emit();
    void this.router.navigate(['/account/billing']);
  }

  protected close(): void {
    if (this.submitting()) return; // never abandon an in-flight charge
    this.closed.emit();
  }

  /** Backdrop clicks dismiss; clicks inside the panel must not. */
  protected onBackdrop(event: MouseEvent): void {
    if (event.target === event.currentTarget) this.close();
  }
}
