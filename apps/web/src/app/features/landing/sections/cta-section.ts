import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroArrowRight,
  heroCheck,
  heroShieldCheck,
  heroSparkles,
} from '@ng-icons/heroicons/outline';

@Component({
  selector: 'app-cta-section',
  imports: [RouterLink, NgIcon],
  viewProviders: [provideIcons({ heroArrowRight, heroCheck, heroShieldCheck, heroSparkles })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './cta-section.html',
})
export class CtaSection {
  /** Thin reassurance line under the buttons. */
  protected readonly reassurances = [
    'No credit card required',
    '5 profiles free',
    'Cancel anytime',
  ] as const;
}
