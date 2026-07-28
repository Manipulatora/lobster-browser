import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroCheck,
  heroCpuChip,
  heroCube,
  heroLockClosed,
  heroShieldCheck,
} from '@ng-icons/heroicons/outline';

@Component({
  selector: 'app-proof-section',
  imports: [NgIcon],
  viewProviders: [
    provideIcons({ heroCheck, heroCpuChip, heroCube, heroLockClosed, heroShieldCheck }),
  ],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './proof-section.html',
})
export class ProofSection {
  /** The four structural reasons a Lobster profile survives inspection. */
  protected readonly proofs = [
    {
      icon: 'heroCpuChip',
      title: 'Applied in the engine, not over the wire',
      body: 'Every value is written in C++ inside Lobium, our Chromium 152 fork, at the Blink surface. There is no injected script and no CDP overlay left behind for a detector to read.',
    },
    {
      icon: 'heroShieldCheck',
      title: 'A coherence gate, not a checkbox',
      body: 'Before a profile launches, its signals are cross-checked so they agree: UA and OS token, GPU backend, screen, cores, memory, fonts, timezone and locale. An incoherent identity fails closed.',
    },
    {
      icon: 'heroCube',
      title: 'Whole device classes, never random noise',
      body: 'GPU, screen, core count and memory arrive bundled from one real machine. Randomised values produce hardware combinations that exist nowhere in the wild.',
    },
    {
      icon: 'heroLockClosed',
      title: 'Isolated, and encrypted at rest',
      body: 'Storage, cookies and cache are separate per profile, so nothing links two identities. Synced profiles are encrypted with AES-256-GCM, keys derived with Argon2id.',
    },
  ] as const;

  /** The signals the coherence gate reconciles before a profile is allowed to launch. */
  protected readonly signals = [
    'User-Agent',
    'Sec-CH-UA platform',
    'navigator.platform',
    'GPU / ANGLE backend',
    'WebGL vendor & renderer',
    'Screen geometry',
    'Colour depth',
    'Device pixel ratio',
    'Hardware concurrency',
    'Device memory',
    'Font set',
    'Timezone',
    'Locale',
    'Accept-Language',
    'Canvas',
    'Web Audio',
    'Media devices',
    'WebRTC policy',
  ] as const;
}
