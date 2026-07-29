import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/**
 * The primary call to action: a violet pill with an animated shine travelling around its border.
 *
 * Styling lives in `styles.css` under `.shiny-cta`, because the effect depends on `@property`
 * declarations that must be registered globally (a registered custom property is what makes a
 * gradient *angle* animatable). The inner `<span>` is required — the label sits above the shimmer
 * layers and carries the breathing glow.
 */
@Component({
  selector: 'app-shiny-cta',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a class="shiny-cta" [routerLink]="link()">
      <span><ng-content /></span>
    </a>
  `,
})
export class ShinyCta {
  readonly link = input<string>('/auth/sign-up');
}
