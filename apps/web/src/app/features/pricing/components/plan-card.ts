import { ChangeDetectionStrategy, Component, computed, input } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroArrowRight, heroCheck, heroCube } from '@ng-icons/heroicons/outline';

import type { Plan } from '../pricing.data';

/**
 * Presentational pricing card. It owns no state: the plan and the billing period are inputs,
 * and everything on screen derives from them.
 */
@Component({
  selector: 'app-plan-card',
  imports: [RouterLink, NgIcon],
  viewProviders: [provideIcons({ heroArrowRight, heroCheck, heroCube })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './plan-card.html',
})
export class PlanCard {
  readonly plan = input.required<Plan>();

  /** True when the page toggle is on yearly billing. */
  readonly billedYearly = input<boolean>(false);

  /** Headline amount — `$49`, `$0`, or `Custom` for a quoted tier. */
  protected readonly price = computed(() => {
    const pricing = this.plan().pricing;
    if (pricing === 'custom') {
      return 'Custom';
    }
    return `$${this.billedYearly() ? pricing.yearly : pricing.monthly}`;
  });

  /** Suffix rendered next to the amount; empty for quoted tiers. */
  protected readonly period = computed(() => (this.plan().pricing === 'custom' ? '' : '/mo'));

  /** The small print under the price. */
  protected readonly billingNote = computed(() => {
    const pricing = this.plan().pricing;
    if (pricing === 'custom') {
      return 'Scoped with you, then fixed for the term.';
    }
    if (pricing.monthly === 0) {
      return 'Free forever. No card required.';
    }
    return this.billedYearly()
      ? `Billed yearly at $${pricing.yearly * 12}. Save ~17%.`
      : 'Billed monthly. Cancel anytime.';
  });
}
