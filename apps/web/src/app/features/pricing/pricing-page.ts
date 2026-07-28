import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroArrowRight,
  heroCommandLine,
  heroCubeTransparent,
  heroFingerPrint,
  heroGlobeAlt,
  heroShieldCheck,
} from '@ng-icons/heroicons/outline';

import { PlanCard } from './components/plan-card';
import { PricingFaq } from './components/pricing-faq';
import { INCLUDED_IN_EVERY_PLAN, PLANS } from './pricing.data';

/**
 * Pricing page.
 *
 * The only state here is the billing period; it flows down to every {@link PlanCard} as an input,
 * so the cards stay presentational and the page keeps one source of truth.
 */
@Component({
  selector: 'app-pricing-page',
  imports: [RouterLink, NgIcon, PlanCard, PricingFaq],
  viewProviders: [
    provideIcons({
      heroArrowRight,
      heroCommandLine,
      heroCubeTransparent,
      heroFingerPrint,
      heroGlobeAlt,
      heroShieldCheck,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pricing-page.html',
})
export class PricingPage {
  /** False = monthly, true = yearly. Yearly is roughly 17 per cent cheaper per month. */
  protected readonly billedYearly = signal(false);

  protected readonly plans = PLANS;
  protected readonly included = INCLUDED_IN_EVERY_PLAN;

  protected setBillingPeriod(yearly: boolean): void {
    this.billedYearly.set(yearly);
  }
}
