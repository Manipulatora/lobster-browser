import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterOutlet } from '@angular/router';

import { Logo } from '../../shared/ui/logo';

/**
 * Shell for every auth page: a light brand panel on the left, the form column on the right.
 * The brand panel is hidden below `lg`, where the logo moves above the form instead.
 */
@Component({
  selector: 'app-auth-layout',
  imports: [RouterOutlet, Logo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './auth-layout.html',
})
export class AuthLayout {}
