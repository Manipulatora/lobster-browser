import { DOCUMENT, isPlatformServer } from '@angular/common';
import { ChangeDetectionStrategy, Component, PLATFORM_ID, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';

import { AuthStore } from '../../core/auth/auth.store';
import {
  DOWNLOADS,
  ENGINE_VERSION,
  RELEASE_VERSION,
  detectPlatform,
  noArtifactsPublished,
  orderedForPlatform,
  type DownloadArtifact,
  type PlatformId,
} from './downloads.catalog';

/**
 * Account → Downloads: the installers, and enough context to trust them.
 *
 * Reachable only through `authGuard`. The artifacts themselves are public release assets (see the
 * note in downloads.catalog.ts); this page is gated because it is account furniture, and because
 * someone who has just paid should land somewhere that hands them the product rather than a
 * marketing page.
 *
 * The page renders the same before and after a release: an unpublished artifact becomes a disabled
 * "coming soon" card instead of a button that 404s. That matters more than it sounds — the download
 * page is the one screen where a broken link reads as a broken product.
 */
@Component({
  selector: 'app-downloads-page',
  standalone: true,
  imports: [RouterLink],
  templateUrl: './downloads-page.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DownloadsPage {
  private readonly auth = inject(AuthStore);
  private readonly document = inject(DOCUMENT);
  private readonly isServer = isPlatformServer(inject(PLATFORM_ID));

  readonly version = RELEASE_VERSION;
  readonly engineVersion = ENGINE_VERSION;
  readonly user = this.auth.user;

  /** Null during SSR: there is no user agent to read, and guessing would render one card order on
   *  the server and another on the client, which Angular reports as a hydration mismatch. */
  private readonly platform = signal<PlatformId | null>(
    this.isServer ? null : detectPlatform(this.document.defaultView?.navigator.userAgent ?? ''),
  );

  readonly artifacts = computed<readonly DownloadArtifact[]>(() =>
    orderedForPlatform(this.platform(), DOWNLOADS),
  );

  readonly nothingPublished = computed(() => noArtifactsPublished(DOWNLOADS));

  /** Which card, if any, to mark as “for this computer”. */
  readonly detected = computed(() => this.platform());

  private readonly _copied = signal<string | null>(null);
  readonly copied = this._copied.asReadonly();

  async copyHash(artifact: DownloadArtifact): Promise<void> {
    if (!artifact.sha256) return;
    try {
      await this.document.defaultView?.navigator.clipboard.writeText(artifact.sha256);
      this._copied.set(artifact.platform);
      this.document.defaultView?.setTimeout(() => this._copied.set(null), 2_000);
    } catch {
      // Clipboard is permission-gated and absent over plain http. The hash is on screen and
      // selectable either way, so a failure here needs no error state.
    }
  }
}
