/**
 * Single source of truth for site navigation.
 * Header, mobile menu, and footer all render from these lists — add a link once, it appears
 * everywhere it belongs.
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
  { label: 'Features', path: '/', fragment: 'features' },
  { label: 'How it works', path: '/', fragment: 'how-it-works' },
  { label: 'Automation', path: '/', fragment: 'automation' },
  { label: 'Pricing', path: '/pricing' },
];

export const FOOTER_NAV: readonly NavGroup[] = [
  {
    title: 'Product',
    links: [
      { label: 'Features', path: '/', fragment: 'features' },
      { label: 'How it works', path: '/', fragment: 'how-it-works' },
      { label: 'Automation', path: '/', fragment: 'automation' },
      { label: 'Pricing', path: '/pricing' },
    ],
  },
  {
    title: 'Developers',
    links: [
      { label: 'Local API', path: '/', fragment: 'automation' },
      { label: 'JS & Python SDK', path: '/', fragment: 'automation' },
      { label: 'Documentation', path: '/', fragment: 'automation' },
    ],
  },
  {
    title: 'Company',
    links: [
      { label: 'Security', path: '/', fragment: 'security' },
      { label: 'Contact sales', path: '/auth/sign-up' },
    ],
  },
];
