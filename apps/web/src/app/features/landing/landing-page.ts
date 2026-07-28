import { ChangeDetectionStrategy, Component } from '@angular/core';

import { HeroSection } from './sections/hero-section';
import { ProofSection } from './sections/proof-section';
import { FeaturesSection } from './sections/features-section';
import { HowItWorksSection } from './sections/how-it-works-section';
import { AutomationSection } from './sections/automation-section';
import { CtaSection } from './sections/cta-section';

/**
 * Landing page — six independent sections.
 *
 * Each section owns its own markup and sample data, so they can be reordered, replaced, or
 * A/B-tested without touching the others. Order below is the order on the page.
 */
@Component({
  selector: 'app-landing-page',
  imports: [
    HeroSection,
    ProofSection,
    FeaturesSection,
    HowItWorksSection,
    AutomationSection,
    CtaSection,
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <app-hero-section />
    <app-proof-section />
    <app-features-section />
    <app-how-it-works-section />
    <app-automation-section />
    <app-cta-section />
  `,
})
export class LandingPage {}
