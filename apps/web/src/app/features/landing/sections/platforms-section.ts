import { ChangeDetectionStrategy, Component } from '@angular/core';

interface RingIcon {
  readonly name: string;
  readonly src: string;
  readonly x: number;
  readonly y: number;
}

interface Ring {
  readonly radius: number;
  readonly icons: RingIcon[];
}

// Hardcoded, not drawn from a shuffled pool — exactly the 24 marks asked for (as given, "Gmail"
// standing in for the "gail" typo), split into three groups of 8 in the order they were listed.
// No name appears twice across the whole set.
const NAMES = [
  'YouTube',
  'LinkedIn',
  'Instagram',
  'X',
  'Pinterest',
  'Upwork',
  'Discord',
  'Reddit',
  'Shopify',
  'Facebook',
  'Twitch',
  'WeChat',
  'eBay',
  'Slack',
  'Gmail',
  'MetaMask',
  'Ethereum',
  'Bitcoin',
  'Spotify',
  'TikTok',
  'Amazon',
  'Outlook',
  'ChatGPT',
  'Airbnb',
];

const RING_COUNT = 8;
const STEP_DEG = 360 / RING_COUNT;

// Three rings, equally spaced 15 apart (30/45/60) — the innermost radius is pinned at 30 and the
// other two pulled in closer to it, halving the old 30-unit gap while keeping every gap equal.
// The middle ring's `offsetDeg` is half a slot (22.5°) so its icons fall exactly between the
// inner ring's — not the same angles scattered outward — and the outer ring returns to offset 0,
// realigning with the inner ring so the whole thing reads as a deliberate brick pattern rather
// than the "sunburst" look this replaces.
const RINGS_CONFIG = [
  { radius: 30, offsetDeg: 0 },
  { radius: 45, offsetDeg: STEP_DEG / 2 },
  { radius: 60, offsetDeg: 0 },
];

function buildRing(radius: number, offsetDeg: number, names: string[]): Ring {
  const start = (-90 + offsetDeg) * (Math.PI / 180);
  const step = (2 * Math.PI) / RING_COUNT;
  const icons = names.map((name, i) => {
    const angle = start + i * step;
    return {
      name,
      src: `/brands/${name.toLowerCase()}.svg`,
      x: 50 + radius * Math.cos(angle),
      y: 50 + radius * Math.sin(angle),
    };
  });
  return { radius, icons };
}

/**
 * Section three: the brand mark at the centre of three static concentric icon rings, equally
 * spaced 15 apart. Each icon sits in its own small violet ring (a circular border, drawn), and
 * the big ring it's placed along is drawn too. Which 8 marks go on which ring, and at which
 * angle, is fixed (see `NAMES`/`RINGS_CONFIG` above) — not random, and not evenly fanned out
 * "sunburst"-style either: the middle ring is deliberately offset half a slot so its icons sit
 * between the inner ring's, brick-pattern style, and the outer ring realigns with the inner one.
 */
@Component({
  selector: 'app-platforms-section',
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './platforms-section.html',
})
export class PlatformsSection {
  protected readonly rings: Ring[] = RINGS_CONFIG.map(({ radius, offsetDeg }, i) =>
    buildRing(radius, offsetDeg, NAMES.slice(i * RING_COUNT, (i + 1) * RING_COUNT)),
  );
}
