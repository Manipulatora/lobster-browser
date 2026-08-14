import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

interface Plan {
  readonly name: string;
  /** Rendered as-is; "Custom" opts out of a numeric price. */
  readonly price: string;
  readonly period?: string;
  readonly features: readonly string[];
  readonly cta: string;
  readonly link: string;
}

/**
 * PLACEHOLDER PRICING. The amounts and per-tier limits below are invented and need replacing with
 * the real commercial numbers before this is treated as public.
 */
const PLANS: readonly Plan[] = [
  {
    name: 'Free',
    price: '$0',
    features: ['5 profiles', 'Own proxies', 'Local API'],
    cta: 'Start free',
    link: '/auth/sign-up',
  },
  {
    name: 'Light',
    price: '$19',
    period: '/mo',
    features: ['25 profiles', 'Own proxies', 'Local API', 'Profile sync'],
    cta: 'Start free',
    link: '/auth/sign-up',
  },
  {
    name: 'Plus',
    price: '$39',
    period: '/mo',
    features: ['75 profiles', 'Profile sync', 'JS & Python SDK', 'Email support'],
    cta: 'Start free',
    link: '/auth/sign-up',
  },
  {
    name: 'Pro',
    price: '$79',
    period: '/mo',
    features: ['200 profiles', '5 members', 'Shared profiles', 'Priority support'],
    cta: 'Start free',
    link: '/auth/sign-up',
  },
  {
    name: 'Max',
    price: '$149',
    period: '/mo',
    features: ['500 profiles', '20 members', 'SSO', 'Dedicated support'],
    cta: 'Contact sales',
    link: '/auth/sign-up',
  },
];

/** Pricing page — five tiers, no marketing copy around them. */
@Component({
  selector: 'app-pricing-page',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './pricing-page.html',
  styleUrl: './pricing-page.css',
})
export class PricingPage {
  protected readonly plans = PLANS;
}
