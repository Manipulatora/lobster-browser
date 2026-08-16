import {
  afterNextRender,
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  inject,
  signal,
} from '@angular/core';
import { DOCUMENT } from '@angular/common';
import { RouterLink, RouterLinkActive } from '@angular/router';

import { AuthStore } from '../../auth/auth.store';
import { AuthModalService } from '../../../features/auth/auth-modal.service';
import { Logo } from '../../../shared/ui/logo';
import { PRIMARY_NAV } from '../../../shared/data/site-nav';
import { HeaderTheme } from '../header-theme';

/**
 * Transparent at the top of the page, then frosted once content scrolls beneath it.
 * Link colour still follows {@link HeaderTheme} so the glass works over light and dark sections.
 */
@Component({
  selector: 'app-site-header',
  imports: [RouterLink, RouterLinkActive, Logo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './site-header.html',
})
export class SiteHeader {
  protected readonly nav = PRIMARY_NAV;
  protected readonly menuOpen = signal(false);
  protected readonly scrolled = signal(false);

  /** Light links while a dark section is behind the bar; ink otherwise. */
  protected readonly onDarkBackdrop = inject(HeaderTheme).overDark;

  private readonly authModal = inject(AuthModalService);
  private readonly auth = inject(AuthStore);

  protected readonly isAuthenticated = this.auth.isAuthenticated;

  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);

  constructor() {
    afterNextRender(() => {
      const view = this.document.defaultView;
      if (!view) return;

      const updateScrollState = (): void => this.scrolled.set(view.scrollY > 12);
      updateScrollState();
      view.addEventListener('scroll', updateScrollState, { passive: true });
      this.destroyRef.onDestroy(() => view.removeEventListener('scroll', updateScrollState));
    });
  }

  protected toggleMenu(): void {
    this.menuOpen.update((open) => !open);
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  /** Opens the auth modal in place of navigating; closes the mobile menu behind it. */
  protected openAuth(mode: 'sign-in' | 'sign-up'): void {
    this.closeMenu();
    this.authModal.open(mode);
  }

  protected signOut(): void {
    this.closeMenu();
    this.auth.logout();
  }
}
