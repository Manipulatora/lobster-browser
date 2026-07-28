import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroArrowUpTray,
  heroCpuChip,
  heroFingerPrint,
  heroGlobeAlt,
  heroLockClosed,
  heroUsers,
} from '@ng-icons/heroicons/outline';

@Component({
  selector: 'app-features-section',
  imports: [NgIcon],
  viewProviders: [
    provideIcons({
      heroArrowUpTray,
      heroCpuChip,
      heroFingerPrint,
      heroGlobeAlt,
      heroLockClosed,
      heroUsers,
    }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './features-section.html',
})
export class FeaturesSection {
  /** The six pillars of the platform. Order is deliberate: engine first, then profile, then team. */
  protected readonly features = [
    {
      icon: 'heroFingerPrint',
      title: 'Native fingerprint engine',
      body: 'Lobium is our own Chromium 152 fork. Fingerprints are applied in C++ at the Blink surface, inside the engine — never by a JavaScript or CDP overlay that a detector can read back.',
    },
    {
      icon: 'heroCpuChip',
      title: 'Coherent device classes',
      body: 'Device classes come from whole real machines, with GPU, screen, cores and memory bundled together. A coherence gate cross-checks every signal so the profile agrees with itself.',
    },
    {
      icon: 'heroLockClosed',
      title: 'Complete profile isolation',
      body: 'Each profile keeps its own storage, cookies and cache. Nothing is shared between profiles, so one identity can never leak into another.',
    },
    {
      icon: 'heroGlobeAlt',
      title: 'Proxy control',
      body: 'Attach HTTP or SOCKS5 proxies and test the connection before launch. Exit-IP geo derivation makes timezone and locale follow where the proxy actually exits.',
    },
    {
      icon: 'heroArrowUpTray',
      title: 'Cookie import',
      body: 'Bring existing sessions in from Netscape or JSON cookie files. Every file is parsed and validated before it reaches a profile.',
    },
    {
      icon: 'heroUsers',
      title: 'Teams and encrypted sync',
      body: 'Share profiles across a team with encrypted profile sync. Data is encrypted at rest with AES-256-GCM, using Argon2id for key derivation.',
    },
  ] as const;
}
