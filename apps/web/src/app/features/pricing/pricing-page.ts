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
import { AuthModalService } from '../auth/auth-modal.service';

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
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pricing-page.html',
  styleUrl: './pricing-page.css',
})
export class PricingPage {
  private readonly authModal = inject(AuthModalService);
  private readonly auth = inject(AuthStore);
  private readonly billing = inject(BillingStore);
  private readonly router = inject(Router);
  private readonly platformId = inject(PLATFORM_ID);

  protected readonly plans = PLANS;
  protected readonly period = signal<Period>('monthly');

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

  protected cta(plan: Plan): string {
    if (this.isCurrent(plan)) return 'Current plan';
    return plan.tier === 'free' ? 'Start free' : `Get ${plan.name}`;
  }

  protected setPeriod(period: Period): void {
    this.period.set(period);
  }

  /**
   * Every CTA leads to the same place — the billing page, where Credit is topped up and a package
   * is actually bought. A signed-out visitor signs up first, in a modal, so the price table stays
   * on screen behind it rather than being replaced by a form.
   *
   * The plan is not carried through. Purchasing costs Credit the account does not have yet, so a
   * brand-new user cannot complete the chosen package regardless; pre-selecting it would promise
   * something the next screen has to withdraw.
   */
  protected choose(plan: Plan): void {
    if (this.isCurrent(plan)) return;
    if (this.auth.isAuthenticated()) {
      void this.router.navigate(['/account/billing']);
      return;
    }
    this.authModal.open('sign-up');
  }
}
