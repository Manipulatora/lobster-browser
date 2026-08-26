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
import { ActivatedRoute, Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { AuthModalService } from '../auth/auth-modal.service';
import { BillingStore } from './billing.store';
import { formatCredit } from './credit';
import { PlanConfirmDialog } from './plan-confirm-dialog';
import type {
  BillingPeriod,
  DepositInstruction,
  PaidPlanTier,
  PlanDefinition,
} from './billing.types';

/** How often to re-check a pending deposit while the address is on screen. */
const POLL_MS = 15_000;

/** Neutral coin glyph substituted when a coin's own icon file is missing. */
const FALLBACK_COIN_ICON = '/coins/generic.svg';

/**
 * Fraction knocked off when twelve months are paid up front.
 *
 * MUST equal `YEARLY_DISCOUNT` in @lobster/shared-types, which is what the API actually charges.
 * The catalog arrives from the server with monthly prices only, so the yearly figure this page
 * shows is derived — and a wrong constant here is a wrong price on a confirmation, not a cosmetic
 * defect.
 */
const YEARLY_DISCOUNT = 0.2;

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
  imports: [FormsModule, DatePipe, PlanConfirmDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './billing-page.html',
})
export class BillingPage {
  private readonly billing = inject(BillingStore);
  private readonly auth = inject(AuthStore);
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
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
  protected readonly copied = signal<'address' | 'amount' | 'tag' | null>(null);

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
  protected readonly selectedChain = computed(
    () => this.allChains().find((c) => c.code === this.chainCode()) ?? null,
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

  // --- Buying a package ----------------------------------------------------

  /** Which term the package table is priced in. Yearly is the same packages, paid a year up front. */
  protected readonly planPeriod = signal<BillingPeriod>('monthly');

  /**
   * The package the confirmation dialog is open on, or null when it is closed.
   *
   * The term is frozen into it, not read live from {@link planPeriod}: a click on the toggle behind
   * an open dialog would otherwise re-price what the user is in the middle of confirming.
   */
  protected readonly pending = signal<{ tier: PaidPlanTier; period: BillingPeriod } | null>(null);

  /** Failures from the switch below — the only thing on this page that still charges nothing. */
  protected readonly packageError = signal<string | null>(null);

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

  // --- Package -------------------------------------------------------------

  /** The date the renewal job will charge on, as the server computed it. */
  protected readonly nextBillingAt = this.billing.nextBillingAt;

  /** The package worth rendering a panel for. The free tier has nothing to renew or cancel. */
  protected readonly paidPackage = computed(() => {
    const current = this.subscription();
    return current && current.tier !== 'free' ? current : null;
  });

  protected readonly togglingAutoRenew = signal(false);

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
      // Carrying `next` exactly as `authGuard` does. A package chosen on the pricing table arrives
      // in this URL, and dropping it here would land the visitor on an empty account page after
      // signing in — the round trip the pricing CTA exists to complete.
      void this.router.navigate(['/login'], { queryParams: { next: this.router.url } });
      return;
    }
    await this.billing.load();
    this.restoreOpenDeposit();
    // Preselect the first recommended (cheapest) rail.
    const first = this.recommendedChains()[0];
    if (first && !this.chainCode()) this.chainCode.set(first.code);

    this.openPackageFromQuery();
  }

  /**
   * Resume a purchase chosen somewhere else.
   *
   * The pricing CTAs put the package in the URL and send a signed-out visitor through sign-up, so
   * this is where the round trip lands. Read ONCE and then stripped from the URL: the query is a
   * handoff, not page state, and leaving it there would reopen the dialog on every reload — long
   * after the purchase it described was made.
   */
  private openPackageFromQuery(): void {
    const params = this.route.snapshot.queryParamMap;
    const plan = params.get('plan');
    const period = params.get('period');
    if (!plan) return;

    void this.router.navigate([], { relativeTo: this.route, queryParams: {}, replaceUrl: true });

    // Validated against the catalog the server sent, not trusted: the query is whatever was in the
    // link, and a tier nobody sells would open a dialog that could only fail.
    const known = this.plans().find((p) => p.tier === plan);
    if (!known) return;
    this.pending.set({
      tier: known.tier,
      period: period === 'yearly' ? 'yearly' : 'monthly',
    });
  }

  protected readonly formatCredit = formatCredit;

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
    return (
      this.currentTier() === plan.tier &&
      this.subscription()?.status === 'active' &&
      (this.subscription()?.billingPeriod ?? 'monthly') === this.planPeriod()
    );
  }

  /**
   * What one period of this package costs in the term currently on screen.
   *
   * MUST match `periodPriceCents` on the server — twelve months less the advertised discount,
   * rounded once. Rounding a second time here is how a table quotes a price the charge does not
   * match.
   */
  protected periodPrice(plan: PlanDefinition): number {
    return this.planPeriod() === 'yearly'
      ? Math.round(plan.priceCents * 12 * (1 - YEARLY_DISCOUNT))
      : plan.priceCents;
  }

  /**
   * Whether the balance covers the LIST price of this package.
   *
   * A first-glance answer for the card, deliberately ignoring any credit an upgrade would reclaim:
   * that credit depends on the server's clock and is quoted inside the dialog. So this can only
   * ever understate what the balance can buy, never overstate it — the card never promises a
   * purchase the next screen has to withdraw.
   */
  protected canAfford(plan: PlanDefinition): boolean {
    return this.balanceCents() >= this.periodPrice(plan);
  }

  protected shortfall(plan: PlanDefinition): number {
    return Math.max(0, this.periodPrice(plan) - this.balanceCents());
  }

  /**
   * The tier of a package that is still inside a period it was paid for, or null.
   *
   * A lapsed or elapsed package is not something a purchase moves away FROM — it is simply gone,
   * and the next purchase is a plain one. Mirrors the server's own condition so the button says
   * the same thing the quote behind it will.
   */
  private readonly livePaidTier = computed(() => {
    const current = this.subscription();
    if (!current || current.tier === 'free' || current.status !== 'active') return null;
    if (current.currentPeriodEnd && new Date(current.currentPeriodEnd) <= new Date()) return null;
    return current.tier;
  });

  /**
   * What pressing this row does, in one word.
   *
   * "Upgrade" rather than "Buy" when that is what it is — the button is the only place that says
   * the package is replacing one being paid for. The dialog behind it carries the full story,
   * including the two moves that have to wait for the current period to end.
   */
  protected planCta(plan: PlanDefinition): string {
    if (this.planIsCurrent(plan)) return 'Current';
    const live = this.livePaidTier();
    if (!live) return 'Buy';

    const order = this.plans();
    const delta =
      order.findIndex((p) => p.tier === plan.tier) - order.findIndex((p) => p.tier === live);
    if (delta > 0) return 'Upgrade';
    return delta < 0 ? 'Buy' : 'Switch';
  }

  protected setPlanPeriod(period: BillingPeriod): void {
    this.planPeriod.set(period);
  }

  /** Open the confirmation, freezing the term it was pressed under. */
  protected choosePlan(plan: PlanDefinition): void {
    if (this.planIsCurrent(plan)) return;
    this.pending.set({ tier: plan.tier, period: this.planPeriod() });
  }

  protected closeConfirm(): void {
    this.pending.set(null);
  }

  /**
   * Accepts digits and a single separator, and otherwise leaves the text alone.
   *
   * Filtering rather than parsing is the point: the box must keep showing what was typed, including
   * the half-finished states ("", "1.") that a parse would reject and overwrite.
   */
  protected onAmountInput(value: string): void {
    const cleaned = value
      .replace(/[^0-9.,]/g, '')
      .replace(/[.,]/g, (m, i, whole) => (whole.indexOf(m) === i ? '.' : ''));
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
      // CLEARED BEFORE THE NEW INSTRUCTION IS SHOWN, not after the new code is ready. `renderQr`
      // resolves a dynamic import first, so without this the previous deposit's code stays on
      // screen across that gap — and on a memo chain, where renderQr is deliberately never called,
      // it would stay forever: the template prefers the QR branch, so a stale code for a DIFFERENT
      // chain's address would render as the fastest path on the page and the "no QR on this
      // network" notice would never appear.
      this.qr.set(null);
      this.instruction.set(instruction);
      // NO QR ON A CHAIN THAT NEEDS A MEMO/TAG. The code encodes the address and nothing else, so
      // scanning it on a chain where the tag is what identifies the depositor produces precisely
      // the untagged transfer that credits nobody and cannot be recovered — and it would be the
      // fastest, most inviting path on the page. There is no address-and-tag encoding that every
      // wallet reads, so the pair is copied by hand instead of one half being made effortless.
      if (!instruction.paymentTag) void this.renderQr(instruction.address);
      this.startPolling();
    } catch (err) {
      this.depositError.set(err instanceof Error ? err.message : 'could not create a deposit');
    } finally {
      this.creatingDeposit.set(false);
    }
  }

  /**
   * Put a still-open deposit back on screen after a reload.
   *
   * The instruction only ever lived in memory, so closing the tab erased it — and on a memo chain
   * that is asymmetric in the worst possible way: the ADDRESS is already in the user's wallet or
   * clipboard, while the tag that has to travel with it is gone from every pixel in the product.
   * The obvious next action is to send to the address alone, which on a shared-address chain
   * credits nobody and cannot be reversed. The row already carries both halves, so the fix is to
   * render them again rather than to warn harder.
   *
   * Only a deposit still waiting on funds is restored; a confirmed or expired one is history, and
   * showing its address invites a second transfer to an address that is no longer being watched.
   */
  private restoreOpenDeposit(): void {
    if (this.instruction()) return;
    const open = this.deposits().find(
      (d) =>
        (d.status === 'pending' || d.status === 'confirming') &&
        !!d.address &&
        !!d.amountCrypto &&
        d.amountCents !== undefined,
    );
    if (!open) return;
    this.instruction.set({
      depositId: open.id,
      address: open.address!,
      paymentTag: open.paymentTag,
      amountCrypto: open.amountCrypto!,
      asset: open.asset,
      chain: open.chain,
      amountCents: open.amountCents!,
    });
    // Same rule as a fresh deposit: no scannable address-only code on a chain whose tag is half
    // the destination.
    if (!open.paymentTag) void this.renderQr(open.address!);
    this.startPolling();
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

  /**
   * A coin icon that fails to load degrades to a neutral glyph instead of nothing.
   *
   * A slug with no file behind it renders as a bare empty box, and on the network badge that is
   * worse than ugly: the badge is the only thing separating USDT-on-Tron from USDT-on-BNB, and a
   * blank one reads as "this asset has no network" rather than "this icon is missing". Sending on
   * the wrong chain loses the deposit, so the failure has to stay visible.
   *
   * The guard is what stops a loop: if the fallback itself is ever missing, its own error event
   * arrives with `src` already pointing at it and the handler leaves it alone.
   */
  protected onIconError(event: Event): void {
    const img = event.target as HTMLImageElement | null;
    if (!img || img.getAttribute('src') === FALLBACK_COIN_ICON) return;
    img.src = FALLBACK_COIN_ICON;
  }

  /**
   * Encode the address locally. A failure leaves the address text, which is the payable thing.
   *
   * Only reached for chains with no memo/tag — see `createDeposit` for why a bare-address QR is a
   * money-loss hazard on the others.
   */
  private async renderQr(address: string): Promise<void> {
    try {
      const { toDataURL } = await import('qrcode');
      this.qr.set(await toDataURL(address, { margin: 1, width: 320, errorCorrectionLevel: 'M' }));
    } catch {
      this.qr.set(null);
    }
  }

  protected async copy(text: string, what: 'address' | 'amount' | 'tag'): Promise<void> {
    try {
      await this.document.defaultView?.navigator.clipboard.writeText(text);
      this.copied.set(what);
      setTimeout(() => this.copied.set(null), 1_800);
    } catch {
      // Clipboard access can be denied; the value is visible and selectable either way.
    }
  }

  /** Plan names come from the catalog the server sent, so they cannot drift from what it charges. */
  protected planName(tier: string): string {
    return this.plans().find((p) => p.tier === tier)?.name ?? tier;
  }

  /** What each renewal costs and how often — the two halves of "what am I signed up for". */
  protected renewalTerms(priceCents: number, period?: string): string {
    return `${this.formatCredit(priceCents)} ${period === 'yearly' ? 'a year' : 'a month'}`;
  }

  protected async toggleAutoRenew(): Promise<void> {
    const current = this.subscription();
    if (!current || this.togglingAutoRenew()) return;
    this.packageError.set(null);
    this.togglingAutoRenew.set(true);
    try {
      await this.billing.setAutoRenew(!current.autoRenew);
    } catch (err) {
      this.packageError.set(err instanceof Error ? err.message : 'could not change auto-renew');
    } finally {
      this.togglingAutoRenew.set(false);
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
        // The instruction is gone, so its code must go with it: `dismissSettled` returns to step 1
        // with these signals intact, and a leftover code is what the next deposit would inherit.
        this.qr.set(null);
        this.stopPolling();
      });
    }, POLL_MS);
  }

  private stopPolling(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = undefined;
  }
}
