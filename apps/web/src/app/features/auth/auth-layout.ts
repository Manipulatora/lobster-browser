import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';
import { NgIcon, provideIcons } from '@ng-icons/core';
import { heroCheck, heroShieldCheck } from '@ng-icons/heroicons/outline';

import { Logo } from '../../shared/ui/logo';

/**
 * Shell for every auth page: a light brand panel on the left, the form column on the right.
 * The brand panel is hidden below `lg`, where the logo moves above the form instead.
 */
@Component({
  selector: 'app-auth-layout',
  imports: [RouterOutlet, NgIcon, Logo],
  viewProviders: [provideIcons({ heroCheck, heroShieldCheck })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auth-layout.html',
})
export class AuthLayout {
  protected readonly proofs = [
    {
      title: 'Native fingerprint engine',
      detail:
        'Lobium, our Chromium 152 fork, applies each identity in C++ at the Blink surface — not as a JavaScript overlay.',
    },
    {
      title: 'Complete profile isolation',
      detail: 'Separate storage, cookies and cache per profile. Nothing leaks between identities.',
    },
    {
      title: 'Encrypted profile sync',
      detail: 'Profiles sync across your team encrypted at rest with AES-256-GCM.',
    },
  ] as const;
}
