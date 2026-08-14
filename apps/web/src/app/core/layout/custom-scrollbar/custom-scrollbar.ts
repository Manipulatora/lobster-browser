import {
  ChangeDetectionStrategy,
  Component,
  DestroyRef,
  DOCUMENT,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';

const MIN_THUMB_PX = 32;

/**
 * A from-scratch scrollbar overlay for the document's own scroll, replacing the native one
 * entirely (hidden globally in styles.css). Native scrollbars are simple and transparent enough
 * everywhere EXCEPT the up/down arrow buttons some end — Firefox in particular has no CSS knob
 * that removes those while keeping the thumb, since `scrollbar-width`/`scrollbar-color` don't
 * cover buttons at all. Drawing the thumb ourselves is the only way to guarantee "thin, transparent,
 * no buttons" holds in every browser rather than most of them.
 */
@Component({
  selector: 'app-custom-scrollbar',
  changeDetection: ChangeDetectionStrategy.OnPush,
  template: `
    <div
      #thumb
      class="pointer-events-auto fixed right-0 top-0 z-[70] w-[6px] cursor-pointer rounded-full bg-black/[0.08] transition-colors duration-200 hover:bg-black/20"
      [class.opacity-0]="!scrollable()"
      [style.height.px]="thumbHeight()"
      [style.transform]="'translateY(' + thumbTop() + 'px)'"
      (pointerdown)="onPointerDown($event)"
    ></div>
  `,
  host: { class: 'pointer-events-none fixed inset-0 z-[70]' },
})
export class CustomScrollbar {
  private readonly document = inject(DOCUMENT);
  private readonly destroyRef = inject(DestroyRef);
  private readonly thumbRef = viewChild.required<ElementRef<HTMLElement>>('thumb');

  protected readonly scrollable = signal(false);
  protected readonly thumbHeight = signal(MIN_THUMB_PX);
  protected readonly thumbTop = signal(0);

  private trackHeight = 0;
  private dragStartY = 0;
  private dragStartScroll = 0;

  constructor() {
    afterNextRender(() => this.boot());
  }

  private boot(): void {
    const view = this.document.defaultView;
    const root = this.document.documentElement;
    if (!view) return;

    const update = (): void => {
      this.trackHeight = view.innerHeight;
      const { scrollHeight, clientHeight } = root;
      const canScroll = scrollHeight > clientHeight + 1;
      this.scrollable.set(canScroll);
      if (!canScroll) return;

      const thumbHeight = Math.max(MIN_THUMB_PX, (clientHeight / scrollHeight) * this.trackHeight);
      const maxScroll = scrollHeight - clientHeight;
      const maxThumbTravel = this.trackHeight - thumbHeight;
      const top = maxScroll > 0 ? (root.scrollTop / maxScroll) * maxThumbTravel : 0;
      this.thumbHeight.set(thumbHeight);
      this.thumbTop.set(top);
    };

    let queued = false;
    const onScroll = (): void => {
      if (queued) return;
      queued = true;
      view.requestAnimationFrame(() => {
        queued = false;
        update();
      });
    };

    update();
    view.addEventListener('scroll', onScroll, { passive: true });
    view.addEventListener('resize', update, { passive: true });

    // Content height changes on route navigation, image loads, WebGL canvases resizing, etc. —
    // a resize observer on the document catches all of that without hooking the router directly.
    const ro = new ResizeObserver(update);
    ro.observe(root);

    // This component is mounted once at the app root and in practice never torn down, but leaving
    // the listeners unbound made it the one place in the codebase that could outlive itself — every
    // other scroll listener here (site-header, HeaderBackdropTint) already unbinds.
    this.destroyRef.onDestroy(() => {
      view.removeEventListener('scroll', onScroll);
      view.removeEventListener('resize', update);
      ro.disconnect();
    });
  }

  protected onPointerDown(event: PointerEvent): void {
    const view = this.document.defaultView;
    const root = this.document.documentElement;
    if (!view) return;

    event.preventDefault();
    const thumb = this.thumbRef().nativeElement;
    thumb.setPointerCapture(event.pointerId);

    this.dragStartY = event.clientY;
    this.dragStartScroll = root.scrollTop;

    const onMove = (moveEvent: PointerEvent): void => {
      const { scrollHeight, clientHeight } = root;
      const maxScroll = scrollHeight - clientHeight;
      const maxThumbTravel = this.trackHeight - this.thumbHeight();
      if (maxThumbTravel <= 0) return;

      const deltaY = moveEvent.clientY - this.dragStartY;
      const deltaScroll = (deltaY / maxThumbTravel) * maxScroll;
      root.scrollTop = Math.min(maxScroll, Math.max(0, this.dragStartScroll + deltaScroll));
    };
    const onUp = (): void => {
      view.removeEventListener('pointermove', onMove);
      view.removeEventListener('pointerup', onUp);
    };

    view.addEventListener('pointermove', onMove);
    view.addEventListener('pointerup', onUp);
  }
}
