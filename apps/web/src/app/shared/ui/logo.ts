import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * Brand lockup. `compact` renders the shield mark only (mobile / tight spaces).
 */
@Component({
  selector: 'app-logo',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      routerLink="/"
      class="inline-flex items-center gap-2.5 rounded-lg transition-opacity hover:opacity-80"
      aria-label="Lobster Browser — home"
    >
      @if (compact()) {
        <img src="/brand/mark.png" alt="" width="28" height="28" class="h-7 w-7" />
      } @else {
        <img
          src="/brand/logo-lockup.png"
          alt="Lobster Browser"
          width="760"
          height="149"
          class="h-9 w-auto"
        />
      }
    </a>
  `,
})
export class Logo {
  readonly compact = input(false);
}
