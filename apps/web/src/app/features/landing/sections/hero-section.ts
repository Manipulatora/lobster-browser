import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroArrowRight, heroCheck, heroFingerPrint } from '@ng-icons/heroicons/outline';

import { HeroFluidLobster } from '../hero-fluid/hero-fluid-lobster';

@Component({
  selector: 'app-hero-section',
  imports: [RouterLink, NgIcon, HeroFluidLobster],
  viewProviders: [provideIcons({ heroArrowRight, heroCheck, heroFingerPrint })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hero-section.html',
})
export class HeroSection {
  protected readonly stats = [
    { value: '100%', label: 'isolated storage per profile' },
    { value: 'C++', label: 'fingerprints applied natively' },
    { value: '18', label: 'coherence signals checked' },
  ] as const;
}
