import { Routes } from '@angular/router';

import { authGuard } from './core/auth/auth.guard';

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
            'Four packages, priced per profile and paid in crypto from your Credit balance. Start free with 3 profiles.',
        },
      },

      // Authentication is a MODAL, not a page — but /signup and /login must still be real URLs:
      // the desktop launcher opens them directly, and they are what people paste and bookmark.
      // Both resolve to a backdrop that opens the modal over it. See AuthRoutePage.
      {
        path: 'signup',
        loadComponent: () => import('./features/auth/auth-route-page').then((m) => m.AuthRoutePage),
        data: { mode: 'sign-up' },
        title: 'Create your account — Lobster Browser',
      },
      {
        path: 'login',
        loadComponent: () => import('./features/auth/auth-route-page').then((m) => m.AuthRoutePage),
        data: { mode: 'sign-in' },
        title: 'Sign in — Lobster Browser',
      },

      // Where the launcher's browser lands when its loopback listener could not be reached.
      {
        path: 'auth/desktop',
        loadComponent: () =>
          import('./features/auth/pages/desktop-authorized-page').then(
            (m) => m.DesktopAuthorizedPage,
          ),
        title: 'Signed in — Lobster Browser',
      },

      // PUBLIC, and deliberately so. The installers are public release assets, the landing nav
      // points here, and someone evaluating the product should not have to create an account to
      // see that it exists for their platform. Account context still reaches this page — the
      // signed-in header links to the same route.
      {
        path: 'download',
        loadComponent: () =>
          import('./features/downloads/downloads-page').then((m) => m.DownloadsPage),
        title: 'Download — Lobster Browser',
        data: {
          description:
            'Download Lobster Browser for Windows or Linux. Every profile gets a coherent device identity applied natively inside our Chromium engine.',
        },
      },
      // The page used to live here and the signed-in header linked to it; keep the old path working
      // rather than 404ing anyone who bookmarked it.
      { path: 'account/downloads', redirectTo: 'download', pathMatch: 'full' },

      {
        path: 'account/billing',
        canActivate: [authGuard],
        loadComponent: () => import('./features/billing/billing-page').then((m) => m.BillingPage),
        title: 'Credit and packages — Lobster Browser',
      },
    ],
  },
  {
    path: 'auth',
    loadChildren: () => import('./features/auth/auth.routes').then((m) => m.authRoutes),
  },
  { path: '**', redirectTo: '' },
];
