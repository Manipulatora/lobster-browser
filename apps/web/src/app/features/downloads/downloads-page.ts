import { DOCUMENT, isPlatformServer } from '@angular/common';
import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';

import {
  DOWNLOADS,
  ENGINE_VERSION,
  RELEASE_VERSION,
  detectPlatform,
  orderedForPlatform,
  type DownloadArtifact,
  type PlatformId,
} from './downloads.catalog';

/**
 * /download — one box per shipping platform, and nothing else. Public: the installers are public
 * release assets, so nothing here waits on an account.
 *
 * The page renders the same before and after a release: an unpublished artifact keeps its box and
 * shows a disabled control instead of a link that 404s. That matters more than it sounds — the
 * download page is the one screen where a broken link reads as a broken product.
 */
@Component({
  selector: 'app-downloads-page',
  standalone: true,
  templateUrl: './downloads-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DownloadsPage {
  private readonly document = inject(DOCUMENT);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));

  readonly version = RELEASE_VERSION;
  readonly engineVersion = ENGINE_VERSION;

  /** Null during SSR: there is no user agent to read, and guessing would order the boxes one way on
   *  the server and another on the client, which Angular reports as a hydration mismatch. */
  private readonly platform = signal<PlatformId | null>(
    this.isServer ? null : detectPlatform(this.document.defaultView?.navigator.userAgent ?? ''),
  );

  /** The visitor's platform first — the only thing detection is used for. */
  readonly artifacts = computed<readonly DownloadArtifact[]>(() =>
    orderedForPlatform(this.platform(), DOWNLOADS),
  );
}
