import { ChangeDetectionStrategy, Component, input } from '@angular/core';
import { RouterLink } from '@angular/router';

/** The primary call to action: a deliberately static violet pill. */
@Component({
  selector: 'app-shiny-cta',
  imports: [RouterLink],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <a
      class="inline-flex min-h-12 items-center justify-center rounded-full bg-brand-600 px-8 text-base font-medium text-white"
      [routerLink]="link()"
    >
      <ng-content />
    </a>
  `,
})
export class ShinyCta {
  readonly link = input<string>('/auth/sign-up');
}
