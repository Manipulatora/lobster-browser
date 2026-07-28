import { Routes } from '@angular/router';

/**
 * Top-level routing.
 *
 * Every page is lazy-loaded with `loadComponent` / `loadChildren`, so each route ships its own
 * chunk. Two shells: the marketing shell (header + footer) and the auth shell (focused, chrome-free).
 * Add a new marketing page by dropping one entry into the `MARKETING_ROUTES` child list.
 */
export const routes: Routes = [
  {
    path: '',
    loadComponent: () => import('./core/layout/site-shell/site-shell').then((m) => m.SiteShell),
    children: [
      {
        path: '',
        pathMatch: 'full',
        loadComponent: () => import('./features/landing/landing-page').then((m) => m.LandingPage),
        title: 'Lobster Browser — the anti-detect browser with a native fingerprint engine',
        data: {
          description:
            'Every profile gets a coherent, real-looking device and network identity, applied natively inside our Chromium engine — never by a JavaScript overlay.',
        },
      },
      {
        path: 'pricing',
        loadComponent: () => import('./features/pricing/pricing-page').then((m) => m.PricingPage),
        title: 'Pricing — Lobster Browser',
        data: {
          description:
            'Simple plans metered on profile count. Start free with 5 profiles; scale to Pro, Team, or Enterprise.',
        },
      },
    ],
  },
  {
    path: 'auth',
    loadChildren: () => import('./features/auth/auth.routes').then((m) => m.authRoutes),
  },
  { path: '**', redirectTo: '' },
];
