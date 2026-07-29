import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ShinyCta } from '../../../shared/ui/shiny-cta';
import { HeaderBackdropTint } from '../../../core/layout/header-theme';
import { HeroBackdrop } from '../hero-backdrop/hero-backdrop';

/**
 * Hero — full-bleed, with the animated scenic backdrop running up behind the transparent nav.
 *
 * The backdrop is a WebGL/WebGPU canvas over a still stand-in of the same palette, so if the shader
 * never initialises (no WebGL, reduced motion, still downloading) the section still looks
 * intentional rather than empty.
 *
 * It also owns the header's colour while it is under the bar — see {@link HeaderBackdropTint}.
 */
@Component({
  selector: 'app-hero-section',
  // Angular hosts default to display:inline, whose box does not reliably reflect the section's
  // geometry — which breaks both getBoundingClientRect() and IntersectionObserver against it.
  host: { class: 'block' },
  imports: [RouterLink, ShinyCta, HeroBackdrop],
  hostDirectives: [HeaderBackdropTint],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hero-section.html',
})
export class HeroSection {}
