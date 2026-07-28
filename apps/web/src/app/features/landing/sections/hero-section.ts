import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroArrowRight,
  heroCheck,
  heroFingerPrint,
  heroGlobeAlt,
  heroShieldCheck,
} from '@ng-icons/heroicons/outline';

@Component({
  selector: 'app-hero-section',
  imports: [RouterLink, NgIcon],
  viewProviders: [
    provideIcons({ heroArrowRight, heroCheck, heroFingerPrint, heroGlobeAlt, heroShieldCheck }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hero-section.html',
})
export class HeroSection {
  /** Sample rows for the product mock — illustrative, not live data. */
  protected readonly profiles = [
    { name: 'Aurora Retail', os: 'Windows 11', geo: 'Berlin, DE', status: 'running' },
    { name: 'Nordic Ads 04', os: 'macOS 15', geo: 'Stockholm, SE', status: 'idle' },
    { name: 'Kite Commerce', os: 'Windows 10', geo: 'Austin, US', status: 'idle' },
  ] as const;

  protected readonly stats = [
    { value: '100%', label: 'isolated storage per profile' },
    { value: 'C++', label: 'fingerprints applied natively' },
    { value: '18', label: 'coherence signals checked' },
  ] as const;
}
