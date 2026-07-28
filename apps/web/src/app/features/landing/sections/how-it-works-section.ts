import { ChangeDetectionStrategy, Component } from '@angular/core';
import { NgIcon, provideIcons } from '@ng-icons/core';
import {
  heroCommandLine,
  heroCpuChip,
  heroGlobeAlt,
  heroIdentification,
} from '@ng-icons/heroicons/outline';

@Component({
  selector: 'app-how-it-works-section',
  imports: [NgIcon],
  viewProviders: [provideIcons({ heroCommandLine, heroCpuChip, heroGlobeAlt, heroIdentification })],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './how-it-works-section.html',
})
export class HowItWorksSection {
  /** The four beats of the workflow, in order. */
  protected readonly steps = [
    {
      id: 'create',
      number: '01',
      icon: 'heroIdentification',
      title: 'Create a profile',
      body: 'Choose a device class, or let a seed derive one for you. Every attribute — GPU, screen, cores, RAM, fonts — is generated together, so the machine holds up as a whole.',
    },
    {
      id: 'proxy',
      number: '02',
      icon: 'heroGlobeAlt',
      title: 'Attach a proxy',
      body: 'Add an HTTP or SOCKS5 proxy and test the connection. The exit IP’s real geo derives timezone, locale and Accept-Language automatically, so the network agrees with the device.',
    },
    {
      id: 'launch',
      number: '03',
      icon: 'heroCpuChip',
      title: 'Launch Lobium',
      body: 'Our Chromium 152 fork applies the fingerprint natively in C++ at the Blink surface, before the first paint. There is no JavaScript overlay left behind for anti-bot systems to read.',
    },
    {
      id: 'automate',
      number: '04',
      icon: 'heroCommandLine',
      title: 'Automate (optional)',
      body: 'Drive the profile from the local automation API with the JS or Python SDK, or hand a plain-language task to Lobee, the agent built into the side panel.',
    },
  ] as const;
}
