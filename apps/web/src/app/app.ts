import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { SeoService } from './core/seo/seo.service';

/**
 * Root component. Intentionally thin: routing decides which shell renders, and the SEO service
 * keeps document metadata in sync with the active route.
 */
@Component({
  selector: 'app-root',
  imports: [RouterOutlet],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<router-outlet />`,
})
export class App {
  constructor() {
    inject(SeoService).init();
  }
}
