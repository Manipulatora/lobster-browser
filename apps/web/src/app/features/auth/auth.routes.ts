import { Routes } from '@angular/router';

import { AuthLayout } from './auth-layout';

/**
 * Auth area routing.
 *
 * The whole area is one lazy chunk (loaded by `loadChildren` from the root routes), so the shared
 * layout is imported eagerly here while each page still gets its own `loadComponent` split.
 */
export const authRoutes: Routes = [
  {
    path: '',
    component: AuthLayout,
    children: [
      { path: '', pathMatch: 'full', redirectTo: 'sign-in' },
      {
        path: 'sign-in',
        loadComponent: () => import('./pages/sign-in-page').then((m) => m.SignInPage),
        title: 'Sign in — Lobster Browser',
        data: {
          description:
            'Sign in to Lobster Browser to manage your profiles, proxies and encrypted profile sync.',
        },
      },
      {
        path: 'sign-up',
        loadComponent: () => import('./pages/sign-up-page').then((m) => m.SignUpPage),
        title: 'Create your account — Lobster Browser',
        data: {
          description:
            'Create a Lobster Browser account. The free plan includes 5 profiles and needs no credit card.',
        },
      },
      {
        path: 'forgot-password',
        loadComponent: () =>
          import('./pages/forgot-password-page').then((m) => m.ForgotPasswordPage),
        title: 'Reset your password — Lobster Browser',
        data: {
          description: 'Request a password reset link for your Lobster Browser account.',
        },
      },
    ],
  },
];
