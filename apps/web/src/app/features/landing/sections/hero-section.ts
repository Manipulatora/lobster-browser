import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ShinyCta } from '../../../shared/ui/shiny-cta';
import { HeaderBackdropTint } from '../../../core/layout/header-theme';
import { HeroBackdrop } from '../hero-backdrop/hero-backdrop';

/**
 * Hero section.
 *
 * ───────────────────────────────────────────────────────────────────────────────
 *  THE BACKDROP IS CURRENTLY SWITCHED OFF — flip `backdrop` to true to bring the
 *  animated scenic shader back. Nothing was deleted: hero-backdrop/ still holds
 *  the component, the TSL shader and its textures, and they still compile.
 * ───────────────────────────────────────────────────────────────────────────────
 *
 * One flag drives everything the backdrop touches, so the pieces cannot drift out
 * of sync: the shader canvas and its still stand-in, the copy colour (white over
 * the dark scene, ink on a blank section), and the header tint via
 * {@link HeaderBackdropTint} — leaving that claimed with no dark scene behind it
 * would paint the nav white on white.
 */
@Component({
  selector: 'app-hero-section',
  // Angular hosts default to display:inline, whose box does not reliably reflect the section's
  // geometry — which breaks both getBoundingClientRect() and IntersectionObserver against it.
  host: { class: 'block' },
  imports: [RouterLink, ShinyCta, HeroBackdrop, HeaderBackdropTint],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hero-section.html',
})
export class HeroSection {
  /** Master switch for the animated backdrop. See the note above. */
  protected readonly backdrop = false;
}
