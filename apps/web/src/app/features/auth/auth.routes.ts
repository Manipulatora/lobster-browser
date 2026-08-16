import { Routes } from '@angular/router';

import { AuthLayout } from './auth-layout';

/**
 * Auth area routing.
 *
 * SIGN-IN AND SIGN-UP ARE NO LONGER PAGES. Authentication happens in a modal over whatever the
 * visitor was already reading (see AuthModal), reached at `/login` and `/signup`. The two routes
 * here are kept as redirects rather than deleted: they were the public URLs, so they are in
 * bookmarks, in old emails, and on any page not yet updated. Removing them would turn all of that
 * into a wildcard redirect to the landing page, silently dropping people who were trying to sign in.
 *
 * `forgot-password` stays a real page. It is a separate flow the modal does not cover, and it is
 * reached rarely enough that taking over the screen is the right treatment.
 */
export const authRoutes: Routes = [
  { path: 'sign-in', pathMatch: 'full', redirectTo: '/login' },
  { path: 'sign-up', pathMatch: 'full', redirectTo: '/signup' },
  {
    path: '',
    component: AuthLayout,
    children: [
      { path: '', pathMatch: 'full', redirectTo: '/login' },
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
