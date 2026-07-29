import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { SiteHeader } from '../site-header/site-header';
import { SiteFooter } from '../site-footer/site-footer';

/**
 * Marketing shell: header + routed page + footer. Auth pages deliberately bypass this so they
 * render without site chrome.
 */
@Component({
  selector: 'app-site-shell',
  imports: [RouterOutlet, SiteHeader, SiteFooter],
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
    </div>
  `,
})
export class SiteShell {}
