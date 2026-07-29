import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { ShinyCta } from '../../../shared/ui/shiny-cta';
import { HeroBackdrop } from '../hero-backdrop/hero-backdrop';

/**
 * Hero — full-bleed, with the animated scenic backdrop running up behind the transparent nav.
 *
 * The backdrop is a WebGL/WebGPU canvas that layers over a CSS gradient of the same palette, so if
 * the shader never initialises (no WebGL, reduced motion, still downloading) the section still
 * looks intentional rather than empty.
 */
@Component({
  selector: 'app-hero-section',
  imports: [RouterLink, ShinyCta, HeroBackdrop],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './hero-section.html',
})
export class HeroSection {}
