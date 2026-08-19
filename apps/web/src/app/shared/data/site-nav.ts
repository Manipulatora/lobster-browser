/**
 * Single source of truth for site navigation.
 * Header, mobile menu, and footer all render from these lists — add a link once, it appears
 * everywhere it belongs.
 *
 * Every `fragment` below must match an `id` that actually exists on the landing page
 * (`#devices`, `#platforms`, `#faq`). An earlier version pointed at `#features`, `#automation`,
 * `#how-it-works` and `#security`, none of which were ever rendered, so nine links navigated to
 * `/` and then sat still — looking broken rather than going anywhere.
 */
export interface NavLink {
  readonly label: string;
  readonly path: string;
  /** In-page anchor on the target route. */
  readonly fragment?: string;
}

export interface NavGroup {
  readonly title: string;
  readonly links: readonly NavLink[];
}

export const PRIMARY_NAV: readonly NavLink[] = [
  { label: 'Product', path: '/', fragment: 'devices' },
  { label: 'Platforms', path: '/', fragment: 'platforms' },
  { label: 'Pricing', path: '/pricing' },
  { label: 'FAQ', path: '/', fragment: 'faq' },
];

export const FOOTER_NAV: readonly NavGroup[] = [
  {
    title: 'Product',
    links: [
      { label: 'Overview', path: '/', fragment: 'devices' },
      { label: 'Platforms', path: '/', fragment: 'platforms' },
      { label: 'Pricing', path: '/pricing' },
    ],
  },
  {
    title: 'Account',
    links: [
      { label: 'Sign in', path: '/login' },
      { label: 'Create account', path: '/signup' },
    ],
  },
  {
    title: 'Support',
    links: [{ label: 'FAQ', path: '/', fragment: 'faq' }],
  },
];
