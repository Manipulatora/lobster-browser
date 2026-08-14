import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

interface FaqItem {
  readonly question: string;
  readonly answer: string;
}

const FAQS: readonly FaqItem[] = [
  {
    question: 'How is this different from incognito mode or a VPN?',
    answer:
      'Incognito clears cookies but leaves the same device fingerprint behind, and a VPN only changes where your traffic exits. A Lobster profile changes both: it gets its own storage, its own proxy, and its own coherent device identity — so two profiles on one machine look like two people on two computers.',
  },
  {
    question: 'Where are fingerprints applied?',
    answer:
      'Inside our Chromium engine, in C++, before the page ever runs. Most tools patch values from a JavaScript overlay, which leaves traces a determined site can look for — a property that reports the wrong type, or a function whose source no longer looks native. Applying it natively means there is no overlay to find.',
  },
  {
    question: 'Can I bring my own proxies?',
    answer:
      'Yes. Assign any HTTP or SOCKS5 proxy per profile, including residential and mobile providers. Nothing is bundled or resold to you, and no traffic is routed through us.',
  },
  {
    question: 'How many profiles can I run at once?',
    answer:
      'As many as your machine has memory for — each profile is a real browser process, so RAM is the practical ceiling rather than a licence limit. Profiles you are not using cost nothing while stopped.',
  },
  {
    question: 'Can I automate profiles?',
    answer:
      'Every profile exposes a local automation endpoint, so you can drive it from Playwright, Puppeteer, or our JS and Python SDKs. Each profile also has an optional built-in agent that can carry out plain-language tasks in the page.',
  },
  {
    question: 'Does my team share one account?',
    answer:
      'No — each member signs in separately, and profiles are shared with the people you choose. Handing over a profile hands over its session, so nobody has to trade passwords to cover a shift.',
  },
  {
    question: 'Which platforms does the desktop app support?',
    answer:
      'Windows, macOS, and Linux. Profiles sync through your account, so the same profile opens on whichever machine you sign in from.',
  },
  {
    question: 'What happens to my data?',
    answer:
      'Cookies, storage, and profile settings are encrypted before they leave your machine. We hold the sync copy so profiles follow you between devices; we do not inspect the sites you visit or the credentials inside a profile.',
  },
];

/**
 * Section four: FAQ. A single-open accordion — one answer at a time keeps the list short enough
 * to scan, which is the whole point of the section.
 *
 * Built from buttons wired to `aria-expanded`/`aria-controls` rather than `<details>`: the open
 * panel animates via a `grid-template-rows: 0fr -> 1fr` transition, and `<details>` cannot animate
 * its own open state (the content is unrendered until it opens, so there is no height to tween).
 */
@Component({
  selector: 'app-faq-section',
  imports: [RouterLink],
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './faq-section.html',
})
export class FaqSection {
  protected readonly faqs = FAQS;

  /** Index of the open question; -1 when every one is collapsed. */
  protected readonly openIndex = signal(0);

  protected toggle(index: number): void {
    this.openIndex.update((current) => (current === index ? -1 : index));
  }
}
