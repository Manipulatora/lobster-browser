import { ChangeDetectionStrategy, Component } from '@angular/core';

/**
 * Landing page — intentionally empty.
 *
 * Compose it from section components under `./sections/`, adding each to `imports` and to the
 * template below.
 */
@Component({
  selector: 'app-landing-page',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: ``,
})
export class LandingPage {}
