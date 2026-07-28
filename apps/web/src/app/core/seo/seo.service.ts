import { DOCUMENT, Injectable, inject } from '@angular/core';
import { Meta } from '@angular/platform-browser';
import { ActivatedRoute, NavigationEnd, Router } from '@angular/router';
import { filter, map, mergeMap } from 'rxjs/operators';

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
        const description = typeof data['description'] === 'string' ? data['description'] : null;
        if (description) {
          this.meta.updateTag({ name: 'description', content: description });
          this.meta.updateTag({ property: 'og:description', content: description });
        }
        this.setCanonical();
      });
  }

  private setCanonical(): void {
    const url = this.document.location?.origin
      ? `${this.document.location.origin}${this.router.url.split('?')[0]}`
      : this.router.url;

    let link = this.document.querySelector<HTMLLinkElement>('link[rel="canonical"]');
    if (!link) {
      link = this.document.createElement('link');
      link.setAttribute('rel', 'canonical');
      this.document.head.appendChild(link);
    }
    link.setAttribute('href', url);
  }
}
