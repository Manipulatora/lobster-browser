import { ChangeDetectionStrategy, Component } from '@angular/core';
import { RouterLink } from '@angular/router';

import { Logo } from '../../../shared/ui/logo';
import { FOOTER_NAV } from '../../../shared/data/site-nav';

@Component({
  selector: 'app-site-footer',
  imports: [RouterLink, Logo],
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './site-footer.html',
})
export class SiteFooter {
  protected readonly groups = FOOTER_NAV;
  protected readonly year = new Date().getFullYear();
}
