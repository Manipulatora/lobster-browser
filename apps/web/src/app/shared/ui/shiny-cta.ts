import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * The primary call to action: transparent, so the hero's own colour reads through it, with a
 * plain hairline ring at rest. Hovering swaps that ring for the same flowing rainbow used by the
 * nav underlines (`.btn-outline-rainbow` in styles.css) — the one moment of colour on an otherwise
 * monochrome control.
 */
@Component({
  selector: 'app-shiny-cta',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="btn-outline-rainbow" [routerLink]="link()">
      <ng-content />
    </a>
  `,
})
export class ShinyCta {
  readonly link = input<string>('/signup');
}
