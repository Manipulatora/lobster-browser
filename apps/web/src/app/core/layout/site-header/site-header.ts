import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink, RouterLinkActive } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroBars3, heroXMark } from '@ng-icons/heroicons/outline';

import { Logo } from '../../../shared/ui/logo';
import { PRIMARY_NAV } from '../../../shared/data/site-nav';

/**
 * Sticky marketing header: translucent, hairline underline, violet accents.
 * The mobile panel is driven by a single signal — no directives, no zone.
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

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }
}
