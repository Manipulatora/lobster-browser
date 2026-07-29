import { ChangeDetectionStrategy, Component } from '@angular/core';

import { HeroSection } from './sections/hero-section';

/**
 * Landing page. Sections live in ./sections/ and are composed here in page order.
 */
@Component({
  selector: 'app-landing-page',
  imports: [HeroSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `<app-hero-section />`,
})
export class LandingPage {}
