import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroChevronDown } from '@ng-icons/heroicons/outline';

import { PRICING_FAQ } from '../pricing.data';

/**
 * Pricing FAQ.
 *
 * Built on native `<details>` / `<summary>` so it is keyboard operable, screen-reader
 * announced and findable with in-page search without a line of accordion JavaScript.
 */
@Component({
  selector: 'app-pricing-faq',
  imports: [NgIcon],
  viewProviders: [provideIcons({ heroChevronDown })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pricing-faq.html',
})
export class PricingFaq {
  protected readonly faqs = PRICING_FAQ;
}
