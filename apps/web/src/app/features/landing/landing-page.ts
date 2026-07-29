import { ChangeDetectionStrategy, Component } from '@angular/core';

import { HeroSection } from './sections/hero-section';
import { DevicesSection } from './sections/devices-section';

/** Landing page. Sections live in ./sections/ and are composed here in page order. */
@Component({
  selector: 'app-landing-page',
  imports: [HeroSection, DevicesSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-hero-section />
    <app-devices-section />
  `,
})
export class LandingPage {}
