import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { NavigationEnd, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { toSignal } from '@angular/core/rxjs-interop';
import { filter, map, startWith } from 'rxjs/operators';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroBars3, heroXMark } from '@ng-icons/heroicons/outline';

import { Logo } from '../../../shared/ui/logo';
import { PRIMARY_NAV } from '../../../shared/data/site-nav';

/**
 * Fully transparent marketing header: no background, no blur, no border.
 *
 * Because it is transparent, what sits behind it changes per route: the landing hero is a dark
 * animated scene, every other page is white. The link colour follows, or it would be invisible on
 * one of them.
 */
@Component({
  selector: 'app-site-header',
  imports: [RouterLink, RouterLinkActive, NgIcon, Logo],
  viewProviders: [provideIcons({ heroBars3, heroXMark })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './site-header.html',
})
export class SiteHeader {
  private readonly router = inject(Router);

  protected readonly nav = PRIMARY_NAV;
  protected readonly menuOpen = signal(false);

  private readonly url = toSignal(
    this.router.events.pipe(
      filter((e): e is NavigationEnd => e instanceof NavigationEnd),
      map((e) => e.urlAfterRedirects),
      startWith(this.router.url),
    ),
    { initialValue: this.router.url },
  );

  /** Only the landing page puts a dark scene behind the bar. */
  protected readonly onDarkBackdrop = computed(() => {
    const path = this.url().split('?')[0].split('#')[0];
    return path === '/' || path === '';
  });

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }
}
