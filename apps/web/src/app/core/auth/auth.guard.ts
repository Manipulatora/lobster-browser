import { inject } from '@angular/core';
import { PLATFORM_ID } from '@angular/core';
import { isPlatformServer } from '@angular/common';
import { Router, type CanActivateFn } from '@angular/router';

import { AuthStore } from './auth.store';
import { TokenStore } from './token.store';

/**
 * Gate for the signed-in area.
 *
 * ALLOWS THE SERVER THROUGH. There is no token on the server — it lives in the browser's
 * localStorage — so a guard that simply checked `isAuthenticated()` would redirect every
 * prerender of an account page to the login route, and the user would watch a correctly
 * authenticated page get bounced during hydration. The page renders its own loading state instead,
 * and the client re-runs this guard with the real answer.
 */
export const authGuard: CanActivateFn = async (_route, state) => {
  const platformId = inject(PLATFORM_ID);
  const tokens = inject(TokenStore);
  const auth = inject(AuthStore);
  const router = inject(Router);

  if (isPlatformServer(platformId)) return true;

  // No token at all: decide immediately rather than waiting on a request that cannot succeed.
  if (!tokens.read()) {
    return router.createUrlTree(['/login'], { queryParams: { next: state.url } });
  }

  // A token exists but the session may not be restored yet — a deep link or a hard reload lands
  // here before the shell's restore() has resolved.
  await auth.restore();

  return auth.isAuthenticated()
    ? true
    : router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};
