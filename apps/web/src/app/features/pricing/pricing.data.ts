/**
 * Pricing data.
 *
 * Lobster is metered on **profile count**, not seats — a profile is one coherent device and
 * network identity, so it is the only unit that maps to what the engine actually provisions.
 * Prices are illustrative and live here (not in a component) so the page stays presentational.
 */

/** Mirrors the plan enum used by the backend billing tables. */
export type PlanId = 'free' | 'pro' | 'team' | 'enterprise';

/** Monthly and effective-monthly-when-billed-yearly amounts, in USD. */
export interface PlanPricing {
  readonly monthly: number;
  readonly yearly: number;
}

export interface Plan {
  readonly id: PlanId;
  readonly name: string;
  /** One line on who the tier is for. */
  readonly positioning: string;
  /** `'custom'` for Enterprise, which is quoted rather than listed. */
  readonly pricing: PlanPricing | 'custom';
  /** Headline profile allowance, e.g. `50 profiles`. */
  readonly profiles: string;
  /** Short qualifier under the allowance. */
  readonly profilesNote: string;
  readonly ctaLabel: string;
  /** Pro is the recommended tier — highlighted with a hairline brand border. */
  readonly recommended: boolean;
  readonly features: readonly string[];
}

export const PLANS = [
  {
    id: 'free',
    name: 'Free',
    positioning: 'Evaluate the engine on real sites, at no cost.',
    pricing: { monthly: 0, yearly: 0 },
    profiles: '5 profiles',
    profilesNote: 'Included permanently, no card required.',
    ctaLabel: 'Start free',
    recommended: false,
    features: [
      'Native C++ fingerprint engine',
      'Coherence gate on every profile',
      'Full storage, cookie and cache isolation',
      'HTTP and SOCKS5 proxy support',
      'macOS, Windows and Linux',
    ],
  },
  {
    id: 'pro',
    name: 'Pro',
    positioning: 'For one operator running a serious profile estate.',
    pricing: { monthly: 59, yearly: 49 },
    profiles: '50 profiles',
    profilesNote: 'Create, archive and rotate them as you like.',
    ctaLabel: 'Choose Pro',
    recommended: true,
    features: [
      'Everything in Free',
      'Exit-IP geo derivation for timezone and locale',
      'Device classes built from whole real machines',
      'Netscape and JSON cookie import with validation',
      'Local automation API with JS and Python SDKs',
      'Lobee, the in-browser agent with humanised input',
    ],
  },
  {
    id: 'team',
    name: 'Team',
    positioning: 'For teams that share an estate across machines.',
    pricing: { monthly: 149, yearly: 129 },
    profiles: '200 profiles',
    profilesNote: 'Shared across every seat in the workspace.',
    ctaLabel: 'Choose Team',
    recommended: false,
    features: [
      'Everything in Pro',
      'Unlimited team seats',
      'Encrypted profile sync across devices',
      'AES-256-GCM at rest, Argon2id key derivation',
      'Role-based access to profiles and proxies',
      'Workspace-level billing and invoices',
    ],
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    positioning: 'For large estates with procurement and audit needs.',
    pricing: 'custom',
    profiles: 'Unlimited profiles',
    profilesNote: 'Sized with you, then fixed for the term.',
    ctaLabel: 'Talk to us',
    recommended: false,
    features: [
      'Everything in Team',
      'SSO and directory-based provisioning',
      'Dedicated support with a named contact',
      'Onboarding for automation and Lobee workflows',
      'Security review and custom agreements',
    ],
  },
] as const satisfies readonly Plan[];

/** Capabilities that are never gated behind a tier. */
export interface IncludedItem {
  readonly id: string;
  readonly icon: string;
  readonly title: string;
  readonly description: string;
}

export const INCLUDED_IN_EVERY_PLAN = [
  {
    id: 'engine',
    icon: 'heroFingerPrint',
    title: 'Native fingerprint engine',
    description:
      'Lobium, our Chromium 152 fork, applies each identity in C++ at the Blink surface — never as a JavaScript overlay.',
  },
  {
    id: 'isolation',
    icon: 'heroCubeTransparent',
    title: 'Full profile isolation',
    description:
      'Separate storage, cookies and cache per profile. Nothing is shared between identities.',
  },
  {
    id: 'proxy',
    icon: 'heroGlobeAlt',
    title: 'Proxy support',
    description:
      'HTTP and SOCKS5, with proxy testing and timezone and locale derived from the real exit IP.',
  },
  {
    id: 'automation',
    icon: 'heroCommandLine',
    title: 'Local automation API',
    description:
      'Drive profiles from JS or Python on your own machine, with no automation tells added.',
  },
] as const satisfies readonly IncludedItem[];

export interface FaqItem {
  readonly id: string;
  readonly question: string;
  readonly answer: string;
}

export const PRICING_FAQ = [
  {
    id: 'what-is-a-profile',
    question: 'What counts as a profile?',
    answer:
      'One profile is one coherent device and network identity — its device class, screen, GPU backend, fonts, timezone, locale and proxy, plus its own isolated storage. It counts against your plan for as long as it exists, whether or not it is running. Deleting a profile frees the slot immediately.',
  },
  {
    id: 'change-plans',
    question: 'Can I change plans later?',
    answer:
      'Yes. Upgrades apply straight away and the new allowance is available on your next launch. Downgrades take effect at the end of the current billing period, so you keep what you paid for. Switching between monthly and yearly billing is handled the same way.',
  },
  {
    id: 'free-trial',
    question: 'Do you offer a free trial?',
    answer:
      'The Free plan is the trial, and it does not expire. You get 5 profiles, the same native engine and the same coherence gate as every paid tier, without a card. Upgrade when you need more profiles or team features.',
  },
  {
    id: 'over-limit',
    question: 'What happens if I exceed my profile limit?',
    answer:
      'Nothing breaks. Existing profiles keep launching and syncing; you are simply blocked from creating new ones until you delete some or move up a tier. There is no surprise overage charge and no automatic upgrade.',
  },
  {
    id: 'own-proxies',
    question: 'Can I use proxies I already own?',
    answer:
      'Yes. Bring any HTTP or SOCKS5 endpoint, with or without authentication. Lobster tests the proxy, reads its real exit location and derives the profile timezone and locale from it, so the network and the device agree. We do not resell bandwidth.',
  },
  {
    id: 'encryption',
    question: 'Is my data encrypted?',
    answer:
      'Profiles stay on your machine unless you turn on cloud sync. When you do, profile data is encrypted at rest with AES-256-GCM and the key is derived with Argon2id. Cookies, credentials and proxy details are covered by the same envelope.',
  },
] as const satisfies readonly FaqItem[];
