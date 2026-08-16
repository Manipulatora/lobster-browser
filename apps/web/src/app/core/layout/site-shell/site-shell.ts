import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { AuthStore } from '../../auth/auth.store';
import { AuthModal } from '../../../features/auth/auth-modal';
import { SiteHeader } from '../site-header/site-header';
import { SiteFooter } from '../site-footer/site-footer';

/**
 * Marketing shell: header + routed page + footer.
 *
 * Also the single mounting point for the auth modal, so every route can open it without each one
 * rendering its own copy — two live dialogs would fight over the focus trap and the body scroll
 * lock.
 */
@Component({
  selector: 'app-site-shell',
  imports: [RouterOutlet, SiteHeader, SiteFooter, AuthModal],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div class="flex min-h-dvh flex-col">
      <a
        href="#main"
        class="sr-only focus:not-sr-only focus:absolute focus:left-4 focus:top-4 focus:z-[60] focus:rounded-full focus:bg-brand-600 focus:px-4 focus:py-2 focus:text-sm focus:text-white"
      >
        Skip to content
      </a>
      <app-site-header />
      <!-- The header is fixed and transparent, so ordinary pages need to clear its height.
           A full-bleed section (the hero) opts out with a -mt-16 and supplies its own top
           padding, letting its backdrop run up behind the nav. -->
      <main id="main" class="flex-1 pt-16">
        <router-outlet />
      </main>
      <app-site-footer />
      <app-auth-modal />
    </div>
  `,
})
export class SiteShell {
  private readonly auth = inject(AuthStore);

  constructor() {
    // Turn a persisted token back into a session on first load. Deliberately fire-and-forget: the
    // shell must paint immediately, and `AuthStore.restore` is a no-op on the server and whenever
    // there is no token, so this costs nothing in the common case.
    void this.auth.restore();
  }
}
