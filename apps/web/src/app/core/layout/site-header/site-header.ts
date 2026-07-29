import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroBars3, heroXMark } from '@ng-icons/heroicons/outline';

import { Logo } from '../../../shared/ui/logo';
import { PRIMARY_NAV } from '../../../shared/data/site-nav';
import { HeaderTheme } from '../header-theme';

/**
 * Fully transparent marketing header: no background, no blur, no border.
 *
 * Because it is transparent, what sits behind it changes as the page scrolls — the landing hero is
 * a dark animated scene, the sections below are white. The link colour follows {@link HeaderTheme},
 * which dark sections claim while they are under the bar, so the switch happens mid-scroll rather
 * than only on navigation.
 */
@Component({
  selector: 'app-site-header',
  imports: [RouterLink, RouterLinkActive, NgIcon, Logo],
  viewProviders: [provideIcons({ heroBars3, heroXMark })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './site-header.html',
})
export class SiteHeader {
  protected readonly nav = PRIMARY_NAV;
  protected readonly menuOpen = signal(false);

  /** Light links while a dark section is behind the bar; ink otherwise. */
  protected readonly onDarkBackdrop = inject(HeaderTheme).overDark;

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }
}
