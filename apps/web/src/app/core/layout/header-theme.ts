import {
  DOCUMENT,
  Directive,
  ElementRef,
  Injectable,
  afterNextRender,
  inject,
  input,
  signal,
} from '@angular/core';

/** Height of the fixed header, in px. The colour switches as a section's edge passes under it. */
const HEADER_HEIGHT = 64;

/**
 * Tracks whether a dark section is currently behind the fixed header.
 *
 * The header is transparent, so its colour cannot be decided by route alone — scrolling out of the
 * dark hero into the white sections below has to flip it mid-page.
 */
@Injectable({ providedIn: 'root' })
export class HeaderTheme {
  /** True when the area behind the header is dark and its links should render light. */
  readonly overDark = signal(false);

  /** Number of dark sections currently under the bar, so overlapping claims cannot fight. */
  private claims = 0;

  claim(): void {
    this.claims += 1;
    this.overDark.set(true);
  }

  release(): void {
    this.claims = Math.max(0, this.claims - 1);
    if (this.claims === 0) this.overDark.set(false);
  }
}

/**
 * Applied to a section with a dark backdrop: while that section sits under the header, the header
 * renders its links light.
 *
 * Takes a boolean so a section whose backdrop can be switched off toggles the header tint with the
 * same flag, instead of the two drifting apart:
 *
 *     <section [appHeaderBackdropTint]="backdrop">
 */
@Directive({ selector: '[appHeaderBackdropTint]' })
export class HeaderBackdropTint {
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly theme = inject(HeaderTheme);
  private readonly document = inject(DOCUMENT);

  /** Defaults to on, so a bare attribute still means "this section is dark". */
  readonly enabled = input(true, { alias: 'appHeaderBackdropTint' });

  private claimed = false;
  private teardown?: () => void;

  constructor() {
    afterNextRender(() => {
      if (this.enabled()) this.watch();
    });
  }

  /**
   * Measured on scroll rather than with an IntersectionObserver.
   *
   * The observer approach needed a rootMargin derived from viewport height to represent "behind the
   * 64px bar", which had to be rebuilt on resize and proved unreliable about firing the release as
   * the section left the top. Reading the rect directly is deterministic: the section is behind the
   * header exactly while its bottom edge is still below the header's lower edge.
   */
  private watch(): void {
    const view = this.document.defaultView;
    if (!view) return;

    let queued = false;
    const measure = (): void => {
      const under = this.host.nativeElement.getBoundingClientRect().bottom > HEADER_HEIGHT;
      if (under === this.claimed) return;
      this.claimed = under;
      if (under) this.theme.claim();
      else this.theme.release();
    };
    const onScroll = (): void => {
      if (queued) return;
      queued = true;
      view.requestAnimationFrame(() => {
        queued = false;
        measure();
      });
    };

    measure();
    view.addEventListener('scroll', onScroll, { passive: true });
    view.addEventListener('resize', onScroll, { passive: true });
    this.teardown = () => {
      view.removeEventListener('scroll', onScroll);
      view.removeEventListener('resize', onScroll);
    };
  }

  ngOnDestroy(): void {
    this.teardown?.();
    if (this.claimed) {
      this.claimed = false;
      this.theme.release();
    }
  }
}
