import { isPlatformServer } from '@angular/common';
import {
  ChangeDetectionStrategy,
  Component,
  PLATFORM_ID,
  computed,
  inject,
  signal,
} from '@angular/core';
import { Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { BillingStore } from '../billing/billing.store';
import { PlanConfirmDialog } from '../billing/plan-confirm-dialog';
import type { BillingPeriod, PaidPlanTier } from '../billing/billing.types';

/** `free` is the state every account starts in; the other four are sellable. */
type Tier = 'free' | 'light' | 'plus' | 'pro' | 'max';

/** Monthly and yearly are the only two ways to pay. */
type Period = 'monthly' | 'yearly';

interface Plan {
  readonly tier: Tier;
  readonly name: string;
  /** Monthly price in USD cents. Zero for the free tier, which has no yearly price either. */
  readonly monthlyCents: number;
  readonly features: readonly string[];
}

/**
 * Fraction knocked off when twelve months are paid up front.
 *
 * MUST equal `YEARLY_DISCOUNT` in @lobster/shared-types — see the note on {@link PLANS} for why
 * this page carries its own copy of the numbers.
 */
const YEARLY_DISCOUNT = 0.2;

/**
 * The public price list.
 *
 * MUST MATCH `PLAN_CATALOG` in @lobster/shared-types, which is what the API actually charges. This
 * is a duplicate, and a deliberate one: the marketing site is prerendered and statically served, so
 * fetching the catalog would mean an empty price table in the prerendered HTML and a layout shift
 * on hydration — on the page most likely to be someone's first impression. A wrong price here is
 * therefore a real defect, not a cosmetic one; change both together.
 */
const PLANS: readonly Plan[] = [
  {
    tier: 'free',
    name: 'Free',
    monthlyCents: 0,
    features: ['3 profiles', 'Full anti-detect engine', 'Own proxies', 'Local API'],
  },
  {
    tier: 'light',
    name: 'Light',
    monthlyCents: 1_000,
    features: [
      '10 profiles',
      'Full anti-detect engine',
      'Own proxies',
      'Local API',
      'Profile sync',
    ],
  },
  {
    tier: 'plus',
    name: 'Plus',
    monthlyCents: 6_000,
    features: [
      '100 profiles',
      'Full anti-detect engine',
      'Browser agent — Lobee',
      'Profile sync',
      'JS & Python SDK',
      'Email support',
    ],
  },
  {
    tier: 'pro',
    name: 'Pro',
    monthlyCents: 10_000,
    features: [
      '200 profiles',
      'Full anti-detect engine',
      'Browser agent — Lobee',
      'Team members',
      'Shared profiles',
      'Priority support',
    ],
  },
  {
    tier: 'max',
    name: 'Max',
    monthlyCents: 20_000,
    features: [
      '1,000 profiles',
      'Full anti-detect engine',
      'Browser agent — Lobee',
      'Team members',
      'Shared profiles',
      'Dedicated support',
    ],
  },
];

/** Pricing page — five tiers, no marketing copy around them. */
@Component({
  selector: 'app-pricing-page',
  imports: [PlanConfirmDialog],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pricing-page.html',
  styleUrl: './pricing-page.css',
})
export class PricingPage {
  private readonly auth = inject(AuthStore);
  private readonly billing = inject(BillingStore);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);

  protected readonly plans = PLANS;
  protected readonly period = signal<Period>('monthly');

  /**
   * The package the confirmation dialog is open on, or null when it is closed.
   *
   * Frozen at the moment the CTA was pressed — the term especially. Reading the live toggle from
   * inside the dialog would let a stray click on Monthly re-price an open confirmation, and the
   * user would be confirming one thing and paying for another.
   */
  protected readonly pending = signal<{ tier: PaidPlanTier; period: BillingPeriod } | null>(null);

  /** Percentage off, for the toggle's own label. */
  protected readonly discountPercent = Math.round(YEARLY_DISCOUNT * 100);

  /**
   * The tier this account is actually on.
   *
   * Null until the subscription is known — which on a prerendered page means "null in the HTML,
   * resolved after hydration". Deliberately NOT defaulted to `free`: an unresolved subscription and
   * a genuinely free account would then be indistinguishable, and a Pro subscriber would see
   * "Current plan" on the Free card for the moment before the answer arrived.
   */
  protected readonly currentTier = computed<Tier | null>(() => {
    if (!this.auth.isAuthenticated()) return null;
    const subscription = this.billing.subscription();
    if (!subscription) return this.billing.loaded() ? 'free' : null;
    // A lapsed or cancelled package is not the plan you are on.
    return subscription.status === 'active' ? (subscription.tier as Tier) : 'free';
  });

  constructor() {
    // Never on the server: there is no token there, so the request could only ever be an
    // unauthenticated one whose answer would be thrown away at hydration.
    if (!isPlatformServer(this.platformId)) void this.loadCurrentPlan();
  }

  private async loadCurrentPlan(): Promise<void> {
    await this.auth.restore();
    if (this.auth.isAuthenticated()) await this.billing.load();
  }

  protected isCurrent(plan: Plan): boolean {
    return this.currentTier() === plan.tier;
  }

  /** Price for one billing period, in cents. The free tier has no yearly figure. */
  protected priceCents(plan: Plan): number {
    if (plan.monthlyCents === 0) return 0;
    return this.period() === 'yearly'
      ? Math.round(plan.monthlyCents * 12 * (1 - YEARLY_DISCOUNT))
      : plan.monthlyCents;
  }

  /** What a yearly subscriber effectively pays each month. Display only. */
  protected perMonthCents(plan: Plan): number {
    return Math.round(this.priceCents(plan) / 12);
  }

  /** Cash saved over paying monthly for a year. */
  protected savingCents(plan: Plan): number {
    return plan.monthlyCents * 12 - this.priceCents(plan);
  }

  /** Whole dollars where the price is whole, cents only when they matter. */
  protected money(cents: number): string {
    const dollars = cents / 100;
    return `$${Number.isInteger(dollars) ? dollars.toLocaleString('en-US') : dollars.toFixed(2)}`;
  }

  protected periodSuffix(plan: Plan): string {
    if (plan.monthlyCents === 0) return '';
    return this.period() === 'yearly' ? '/yr' : '/mo';
  }

  /**
   * Whether this card is a step UP from the package the account is on.
   *
   * Ranked off the order of {@link PLANS}, which is ascending — the same order the API's own
   * catalog is in, so "bigger" means the same thing on both sides of the wire.
   */
  protected isUpgrade(plan: Plan): boolean {
    const current = this.currentTier();
    if (!current || current === 'free' || plan.tier === 'free') return false;
    return rank(plan.tier) > rank(current);
  }

  /**
   * Whether this card is unreachable from where the account already is.
   *
   * Disabling only the exact current tier left every LOWER package clickable, so a Pro account
   * could start a purchase for Light — a downgrade the purchase endpoint refuses anyway, after the
   * user has picked a period and opened a confirmation dialog. Anything at or below the current
   * rank is presented as unavailable instead.
   *
   * Signed-out visitors see nothing disabled: with no current tier there is no downgrade.
   */
  protected isUnavailable(plan: Plan): boolean {
    const current = this.currentTier();
    if (!current) return false;
    return rank(plan.tier) <= rank(current);
  }

  protected cta(plan: Plan): string {
    if (this.isCurrent(plan)) return 'Current plan';
    // A package below the one being paid for is not on offer; say so rather than inviting a click
    // the server will refuse.
    if (this.isUnavailable(plan)) return 'Included in your plan';
    if (plan.tier === 'free') return 'Start free';
    // "Upgrade" rather than "Get" when that is what it is: the card is offering to replace a
    // package the visitor is paying for, and the button is the only place that says so.
    return this.isUpgrade(plan) ? `Upgrade to ${plan.name}` : `Get ${plan.name}`;
  }

  protected setPeriod(period: Period): void {
    this.period.set(period);
  }

  /**
   * Act on a CTA, carrying the chosen package with it.
   *
   * SIGNED IN — the confirmation dialog opens here, over the table. Sending the user to the
   * account page to press a second button is a step that exists only because the purchase used to
   * live there; the decision was made on this card, and what follows it is a confirmation.
   *
   * SIGNED OUT — to `/signup`, a real URL, with the package in `next`. Authentication is still a
   * dialog, but at a URL rather than over the table, because the round trip has to survive an
   * email verification code that arrives in another tab. `next` is the same query the auth guard
   * already uses, and the auth dialog follows it once the account exists, so the visitor lands
   * back on the package they picked instead of on a page that has forgotten it.
   */
  protected choose(plan: Plan): void {
    if (this.isCurrent(plan)) return;
    const tier: Tier = plan.tier;

    if (!this.auth.isAuthenticated()) {
      const next =
        tier === 'free'
          ? '/account/billing'
          : `/account/billing?plan=${tier}&period=${this.period()}`;
      void this.router.navigate(['/signup'], { queryParams: { next } });
      return;
    }

    // The free tier is not sold, so there is nothing to confirm. It is reached by letting a package
    // lapse, which is what the account page's auto-renew switch does.
    if (tier === 'free') {
      void this.router.navigate(['/account/billing']);
      return;
    }

    this.pending.set({ tier, period: this.period() });
  }

  protected closeConfirm(): void {
    this.pending.set(null);
  }
}

/** Position in the ascending price list; -1 for the free tier, which is below all four. */
function rank(tier: Tier): number {
  return tier === 'free' ? -1 : PLANS.findIndex((p) => p.tier === tier);
}
