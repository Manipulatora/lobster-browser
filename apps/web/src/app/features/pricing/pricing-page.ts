import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { Router } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import { AuthModalService } from '../auth/auth-modal.service';

interface Plan {
  readonly name: string;
  /** Rendered as-is. */
  readonly price: string;
  readonly period?: string;
  readonly features: readonly string[];
  readonly cta: string;
}

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
    name: 'Free',
    price: '$0',
    features: ['5 profiles', 'Full fingerprint engine', 'Own proxies', 'Local API'],
    cta: 'Start free',
  },
  {
    name: 'Light',
    price: '$10',
    period: '/mo',
    features: ['10 profiles', 'Own proxies', 'Local API', 'Profile sync'],
    cta: 'Get Light',
  },
  {
    name: 'Plus',
    price: '$60',
    period: '/mo',
    features: ['100 profiles', 'Profile sync', 'JS & Python SDK', 'Email support'],
    cta: 'Get Plus',
  },
  {
    name: 'Pro',
    price: '$100',
    period: '/mo',
    features: ['200 profiles', 'Team members', 'Shared profiles', 'Priority support'],
    cta: 'Get Pro',
  },
  {
    name: 'Max',
    price: '$200',
    period: '/mo',
    features: ['1,000 profiles', 'Team members', 'Shared profiles', 'Dedicated support'],
    cta: 'Get Max',
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
  private readonly router = inject(Router);

  protected readonly plans = PLANS;

  /**
   * Every CTA leads to the same place — the billing page, where Credit is topped up and a package
   * is actually bought. A signed-out visitor signs up first, in a modal, so the price table stays
   * on screen behind it rather than being replaced by a form.
   *
   * The plan is not carried through. Purchasing costs Credit the account does not have yet, so a
   * brand-new user cannot complete the chosen package regardless; pre-selecting it would promise
   * something the next screen has to withdraw.
   */
  protected choose(): void {
    if (this.auth.isAuthenticated()) {
      void this.router.navigate(['/account/billing']);
      return;
    }
    this.authModal.open('sign-up');
  }
}
