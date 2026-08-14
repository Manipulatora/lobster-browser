import { ChangeDetectionStrategy, Component } from '@angular/core';

import { HeroSection } from './sections/hero-section';
import { DevicesSection } from './sections/devices-section';
import { PlatformsSection } from './sections/platforms-section';
import { FaqSection } from './sections/faq-section';

/** Landing page. Sections live in ./sections/ and are composed here in page order. */
@Component({
  selector: 'app-landing-page',
  imports: [HeroSection, DevicesSection, PlatformsSection, FaqSection],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-hero-section />
    <app-devices-section />
    <app-platforms-section />
    <app-faq-section />
  `,
})
export class LandingPage {}
