import { DOCUMENT, DatePipe, isPlatformServer } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  PLATFORM_ID,
  computed,
  inject,
  signal,
} from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { AuthModalService } from '../auth/auth-modal.service';
import { BillingStore } from './billing.store';
import type { DepositInstruction, PaidPlanTier, PlanDefinition } from './billing.types';


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
  imports: [FormsModule, DatePipe],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './billing-page.html',
})
export class BillingPage {
  private readonly billing = inject(BillingStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly platformId = inject(PLATFORM_ID);
  private readonly authModal = inject(AuthModalService);

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
  protected readonly chainCode = signal('');
  protected readonly showAllChains = signal(false);
  protected readonly instruction = signal<DepositInstruction | null>(null);
  protected readonly depositError = signal<string | null>(null);
  protected readonly creatingDeposit = signal(false);
  protected readonly copied = signal<'address' | 'amount' | null>(null);

  /**
   * The pre-pay confirmation step. Holds the exact figures the user is about to commit to, frozen
   * at the moment they pressed Pay — not live signals. If the amount or chain moved underneath an
   * open dialog, the user would be confirming one thing and paying for another.
   */
  protected readonly pendingConfirm = signal<{
    amountCents: number;
    code: string;
    asset: string;
    chain: string;
    networkFeeUsd: number;
  } | null>(null);

  /** A deposit observed crossing into `confirmed` while the user was watching. */
  protected readonly settled = signal<{ amountCents: number; asset: string } | null>(null);

  /** Coin picker open state. A modal, not a dropdown: the list is long and wants grouping. */
  protected readonly pickerOpen = signal(false);

  /**
   * The picker's contents, split into the two questions a payer actually has: "the steady one" or
   * "the coin I hold". Each group stays in the backend's cheapest-first order.
   */
  protected readonly stableChains = computed(() => this.allChains().filter((c) => c.stable));
  protected readonly nativeChains = computed(() => this.allChains().filter((c) => !c.stable));

  /** Data-URI QR of the deposit address, rendered locally. Never a third-party image service: an
   *  external QR renderer would be handed the address, and a swapped image is a swapped payment. */
  protected readonly qr = signal<string | null>(null);

  /** The selected chain, resolved from the flat list. */
  protected readonly selectedChain = computed(() =>
    this.allChains().find((c) => c.code === this.chainCode()) ?? null,
  );

  /** Every chain in one list, cheapest first — the backend already sorts by send cost. */
  protected readonly allChains = computed(() => [
    ...this.recommendedChains(),
    ...this.otherChains(),
  ]);

  /**
   * Which of the three steps is current.
   *
   * Derived rather than stored: a stored step and the real state drift the moment anything fails,
   * and then the line says "confirmed" while the address is still waiting.
   */
  protected readonly step = computed<1 | 2 | 3>(() => {
    if (this.settled()) return 3;
    if (this.instruction()) return 2;
    return 1;
  });

  // --- Purchase ------------------------------------------------------------
  protected readonly purchasing = signal<PaidPlanTier | null>(null);
  protected readonly purchaseError = signal<string | null>(null);

  protected readonly depositsAvailable = this.billing.depositsAvailable;

  /**
   * Whether this account may open a deposit at all.
   *
   * The backend refuses an unverified account outright (`EmailVerifiedGuard`), so the button has to
   * say so before it is pressed rather than after — the whole point of the earlier fix.
   */
  protected readonly emailVerified = this.auth.emailVerified;

  /** Reopen the code dialog for the signed-in address, then reload once it is proven. */
  protected confirmEmail(): void {
    const email = this.user()?.email;
    if (!email) return;
    this.authModal.openVerification(email, () => void this.billing.load());
  }

  protected readonly currentTier = computed(() => this.subscription()?.tier ?? 'free');
  protected readonly isPastDue = computed(() => this.subscription()?.status === 'past_due');

  /**
   * EXACTLY WHAT THE USER TYPED, held as text.
   *
   * The field used to be bound to a formatted `toFixed(2)` of the cents signal, which rewrote the
   * box on every keystroke: typing "25" became "25.00" mid-entry, and a partial "1." or a cleared
   * field were both impossible to hold. Text in, text back — the numeric reading is derived from
   * it and never pushed into it.
   */
  protected readonly amountText = signal('10');

  /** The typed text as whole cents, or null while it is not yet a usable number. */
  protected readonly amountCents = computed<number | null>(() => {
    const dollars = Number.parseFloat(this.amountText().replace(/,/g, '.'));
    if (!Number.isFinite(dollars) || dollars <= 0) return null;
    // Rounded at the boundary so a fractional cent can never reach the API.
    return Math.round(dollars * 100);
  });

  private pollTimer?: ReturnType<typeof setInterval>;

  constructor() {
    void this.init();
    this.destroyRef.onDestroy(() => this.stopPolling());
  }

  private async init(): Promise<void> {
    // NOTHING RUNS ON THE SERVER. The token lives in localStorage, so a server render is always
    // "signed out" — and the redirect below would then be emitted as a real HTTP 302 to /login,
    // which the browser follows before Angular ever hydrates. That is the same trap `authGuard`
    // documents when it lets the server through; the page has to hold the same line, and render
    // its loading state until the client takes over.
    if (isPlatformServer(this.platformId)) return;

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

  /**
   * Balances are shown in Credit, never with a currency symbol.
   *
   * Credit is what the account actually holds — a prepaid balance that happens to be denominated
   * 1:1 in USD. Printing "$12.00" invites the reading that dollars are sitting there withdrawable;
   * "12.00 Credit" says what it is.
   */
  protected formatCredit(cents: number): string {
    return `${(cents / 100).toFixed(2)} Credit`;
  }

  /** Ledger amounts are signed; the statement renders the sign separately from the magnitude. */
  protected abs(value: number): number {
    return Math.abs(value);
  }

  /**
   * What the user's own wallet will pay the chain to send — spelled out, not abbreviated.
   *
   * The old rendering was a bare "<$0.01", which says nothing about whose cost it is or what it is
   * for. Fees here span three orders of magnitude, so the sub-cent case still needs its own
   * wording rather than rounding to "$0.00" and reading as free.
   */
  protected formatFee(usd: number): string {
    if (usd < 0.01) return 'under 0.01 USD network fee';
    return `about ${usd.toFixed(2)} USD network fee`;
  }

  /** The same figure, compact, for the dense rows of the picker. */
  protected formatFeeShort(usd: number): string {
    // "USD", not a "$" glyph: the balance on this page is Credit, and mixing the two symbols is
    // what made a bare "<$0.01" unreadable. This is a real network cost, though, and it is not
    // paid in Credit — so it cannot be relabelled as Credit either.
    return usd < 0.01 ? 'under 0.01 USD' : `~${usd.toFixed(2)} USD`;
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


  /**
   * Accepts digits and a single separator, and otherwise leaves the text alone.
   *
   * Filtering rather than parsing is the point: the box must keep showing what was typed, including
   * the half-finished states ("", "1.") that a parse would reject and overwrite.
   */
  protected onAmountInput(value: string): void {
    const cleaned = value.replace(/[^0-9.,]/g, '').replace(/[.,]/g, (m, i, whole) =>
      whole.indexOf(m) === i ? '.' : '',
    );
    this.amountText.set(cleaned);
  }

  /**
   * Step 1 of paying: show what is about to happen and stop.
   *
   * Deliberately does NOT contact the API. Creating the invoice here would mean a mis-tapped
   * amount has already reserved an address and a quoted rate before the user has read anything
   * back, and the only way out would be to abandon a live invoice.
   */
  protected requestPay(): void {
    const chain = [...this.recommendedChains(), ...this.otherChains()].find(
      (c) => c.code === this.chainCode(),
    );
    const amountCents = this.amountCents();
    if (!chain || amountCents === null) return;
    this.depositError.set(null);
    this.pendingConfirm.set({
      amountCents,
      code: chain.code,
      asset: chain.asset,
      chain: chain.chain,
      networkFeeUsd: chain.networkFeeUsd,
    });
  }

  protected cancelPay(): void {
    this.pendingConfirm.set(null);
  }

  /** Step 2: the user confirmed. Pay using the FROZEN figures, never the live signals. */
  protected async confirmPay(): Promise<void> {
    const confirmed = this.pendingConfirm();
    if (!confirmed || this.creatingDeposit()) return;
    this.pendingConfirm.set(null);
    await this.createDeposit(confirmed.amountCents, confirmed.code);
  }

  protected dismissSettled(): void {
    this.settled.set(null);
  }

  private async createDeposit(amountCents: number, code: string): Promise<void> {
    if (this.creatingDeposit()) return;
    this.depositError.set(null);
    this.creatingDeposit.set(true);
    try {
      const instruction = await this.billing.createDeposit(amountCents, code);
      this.instruction.set(instruction);
      void this.renderQr(instruction.address);
      this.startPolling();
    } catch (err) {
      this.depositError.set(err instanceof Error ? err.message : 'could not create a deposit');
    } finally {
      this.creatingDeposit.set(false);
    }
  }

  protected dismissInstruction(): void {
    this.instruction.set(null);
    this.qr.set(null);
    this.stopPolling();
  }

  protected chooseChain(code: string): void {
    this.chainCode.set(code);
    this.pickerOpen.set(false);
  }

  protected togglePicker(): void {
    this.pickerOpen.update((open) => !open);
  }

  /** Encode the address locally. A failure leaves the address text, which is the payable thing. */
  private async renderQr(address: string): Promise<void> {
    try {
      const { toDataURL } = await import('qrcode');
      this.qr.set(
        await toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: 'M' }),
      );
    } catch {
      this.qr.set(null);
    }
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
  /**
   * Watch the open deposit until the processor settles it.
   *
   * The settled dialog is raised from the DEPOSIT LIST rather than from a balance change: a
   * balance can move for reasons that have nothing to do with this payment (a renewal debit
   * landing in the same window), and telling someone their deposit arrived because an unrelated
   * number moved would be a lie at the one moment they are least able to check.
   */
  private startPolling(): void {
    this.stopPolling();
    const open = this.instruction();
    const watching = open?.depositId;
    this.pollTimer = setInterval(() => {
      void this.billing.refreshDeposits().then(() => {
        if (!watching) return;
        const mine = this.deposits().find((d) => d.id === watching);
        if (mine?.status !== 'confirmed') return;
        // Prefer what was actually credited over what was invoiced: an overpayment credits more,
        // and showing the invoice figure would understate what the user received.
        this.settled.set({
          amountCents: mine.creditedCents ?? open?.amountCents ?? 0,
          asset: mine.asset,
        });
        this.instruction.set(null);
        this.stopPolling();
      });
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
