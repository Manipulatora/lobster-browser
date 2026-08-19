import { DOCUMENT, Injectable, inject } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter, map, mergeMap } from 'rxjs/operators';

/**
 * Public origin the site is served from, without a trailing slash.
 *
 * Hardcoded rather than read from `location`: every route is prerendered at build time, where the
 * only origin available is the build machine's. A canonical or og:url baked out as
 * `http://localhost:4200/pricing` is worse than none at all, and both tags must name the public
 * site even when the page is being viewed from a preview host.
 */
const SITE_ORIGIN = 'https://lobrowser.com';

/**
 * Description shown on routes that declare none of their own. Kept identical to the one in
 * `index.html` so a visitor arriving on `/signup` gets the site's description rather than whatever
 * the previous route left behind in the DOM.
 */
const DEFAULT_DESCRIPTION =
  'Lobster Browser gives every profile a coherent, real-looking device and network identity — applied natively inside our Chromium engine, never by a JavaScript overlay.';

/**
 * Keeps `<meta>` and the canonical link in sync with the active route.
 *
 * The router's own `title` resolver handles `<title>`; this fills in everything else from the
 * route's `data.description`, so adding a page means adding one `data` field — not wiring metadata
 * by hand in every component.
 */
@Injectable({ providedIn: 'root' })
export class SeoService {
  private readonly router = inject(Router);
  private readonly route = inject(ActivatedRoute);
  private readonly meta = inject(Meta);
  private readonly document = inject(DOCUMENT);

  init(): void {
    this.router.events
      .pipe(
        filter((event): event is NavigationEnd => event instanceof NavigationEnd),
        map(() => {
          let route = this.route;
          while (route.firstChild) route = route.firstChild;
          return route;
        }),
        mergeMap((route) => route.data),
      )
      .subscribe((data) => {
        const description =
          typeof data['description'] === 'string' ? data['description'] : DEFAULT_DESCRIPTION;
        this.meta.updateTag({ name: 'description', content: description });
        this.meta.updateTag({ property: 'og:description', content: description });
        this.setUrl();
      });
  }

  /** Point both the canonical link and og:url at this route on the public origin. */
  private setUrl(): void {
    const url = `${SITE_ORIGIN}${this.router.url.split('?')[0]}`;

    let link = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.document.head.appendChild(link);
    }
    link.setAttribute('href', url);

    this.meta.updateTag({ property: 'og:url', content: url });
  }
}
