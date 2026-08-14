import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ViewportScroller } from '@angular/common';
import { RouterOutlet } from '@angular/router';

import { SeoService } from './core/seo/seo.service';
import { CustomScrollbar } from './core/layout/custom-scrollbar/custom-scrollbar';

/**
 * Root component. Intentionally thin: routing decides which shell renders, and the SEO service
 * keeps document metadata in sync with the active route. The scrollbar overlay lives here rather
 * than in the marketing shell so it also covers the shell-less auth pages.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet, CustomScrollbar],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <router-outlet />
    <app-custom-scrollbar />
  `,
})
export class App {
  constructor() {
    inject(SeoService).init();

    // The header is fixed and 64px tall, so an anchor landing at the viewport's top edge puts the
    // target's own heading underneath it. This is the half of the fix that covers router-driven
    // #fragment navigation: Angular's ViewportScroller scrolls with `window.scrollTo`, which
    // ignores CSS `scroll-margin-top` entirely — so the offset has to be given to it directly.
    // The `scroll-margin-top` rule in styles.css is the other half, for the scrolls the router
    // never sees (find-in-page, and anything that goes through `scrollIntoView`).
    inject(ViewportScroller).setOffset([0, 80]);
  }
}
