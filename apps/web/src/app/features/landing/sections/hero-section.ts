import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ShinyCta } from '../../../shared/ui/shiny-cta';
import { HeaderBackdropTint } from '../../../core/layout/header-theme';
import { HeroBackdrop } from '../hero-backdrop/hero-backdrop';
import { XylophoneHero } from '../xylophone-hero/xylophone-hero';

/**
 * Hero section.
 *
 * The xylophone is a full-bleed backdrop now — it fills the whole section behind the copy, not a
 * framed card beside it. That scene is a LIGHT violet wash, not a dark one, so the copy keeps the
 * ordinary light-section (dark ink) treatment; `backdrop` below switches to the actual `on-scene`
 * light-text treatment only for the older, genuinely dark night-sky shader.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 *  `backdrop` chooses WHICH full-bleed scene renders, and therefore which text
 *  treatment applies — the xylophone (false, the current default, light scene) or
 *  the older animated night-sky shader (true, dark scene). Nothing about the ocean
 *  shader was deleted: hero-backdrop/ still holds the component, the TSL shader
 *  and its textures, and they still compile if flipped back on.
 * ───────────────────────────────────────────────────────────────────────────────
 */
@Component({
  selector: 'app-hero-section',
  // Angular hosts default to display:inline, whose box does not reliably reflect the section's
  // geometry — which breaks both getBoundingClientRect() and IntersectionObserver against it.
  host: { class: 'block' },
  imports: [RouterLink, ShinyCta, HeroBackdrop, HeaderBackdropTint, XylophoneHero],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hero-section.html',
})
export class HeroSection {
  /** Which full-bleed backdrop renders, and which text treatment it needs. See the note above. */
  protected readonly backdrop = false;
}
