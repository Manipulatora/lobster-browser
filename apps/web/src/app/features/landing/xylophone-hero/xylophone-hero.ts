import {
  ChangeDetectionStrategy,
  Component,
  DOCUMENT,
  ElementRef,
  afterNextRender,
  inject,
  signal,
  viewChild,
} from '@angular/core';

// Type-only: erased at compile time, so it adds nothing to the bundle and never runs on the server.
import type { XylophoneEngine } from './engine/xylophone-engine';

/**
 * Interactive centerpiece for the hero: a frosted-glass helix that swings when you hover over it.
 * Replaces the hero's lifestyle video. See `engine/xylophone-engine.ts` for the full port notes;
 * this component is only the Angular/DOM glue, following the same loading discipline as
 * `HeroBackdrop` next door:
 *
 * - **Lazy.** `three`, `postprocessing`, and the whole engine are behind a dynamic `import()`, so
 *   they land in their own chunk, off the critical path.
 * - **SSR-safe.** All of it runs inside `afterNextRender`, which Angular never calls on the
 *   server, so prerendering the static routes never touches WebGL.
 * - **Degrades quietly.** A CSS gradient plays underneath until the canvas actually has a frame to
 *   show; no WebGL2, a lost context, or a failed asset all land on that same fallback.
 * - **Idle when unseen.** An IntersectionObserver drives the render loop and a hidden tab pauses
 *   it — this is a marketing page, not a game.
 *
 * Unlike `HeroBackdrop`, this canvas is a real control, not ambient decoration: hovering a bar
 * strikes it. `prefers-reduced-motion` therefore does not skip loading the scene the way it does
 * for the backdrop — it only freezes the autoplaying parts (idle spin, conveyor, strike swing),
 * exactly as the engine already gates them. The hover-reactive tint stays live either way, since
 * it is a direct response to the visitor's own pointer, not ambient motion.
 */
@Component({
  selector: 'app-xylophone-hero',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div class="relative h-full w-full overflow-hidden bg-xylophone-fallback">
      <canvas
        #canvas
        aria-hidden="true"
        tabindex="-1"
        class="block h-full w-full touch-none transition-opacity duration-700 ease-out"
        [class.opacity-0]="!ready()"
        [class.opacity-100]="ready()"
        (pointermove)="onPointerMove($event)"
        (pointerleave)="onPointerLeave()"
      ></canvas>
      <span class="sr-only">
        An interactive frosted-glass xylophone: a slowly turning helix of glass bars that swing when
        you move the cursor over them.
      </span>
    </div>
  `,
})
export class XylophoneHero {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);

  /** Flipped once the first frame is on screen; drives the fade-in. */
  protected readonly ready = signal(false);

  private engine?: XylophoneEngine;
  private teardown?: () => void;

  constructor() {
    afterNextRender(() => void this.start());
  }

  protected onPointerMove(event: PointerEvent): void {
    if (!this.engine) return;
    const box = this.canvasRef().nativeElement.getBoundingClientRect();
    if (box.width === 0 || box.height === 0) return;

    const u = (event.clientX - box.left) / box.width;
    const v = (event.clientY - box.top) / box.height;

    // three's raycasting NDC: -1..1, y-up. The fluid sim's screen space: 0..1, y-up from bottom.
    this.engine.setPointer(u * 2 - 1, 1 - v * 2, u, 1 - v);
  }

  protected onPointerLeave(): void {
    this.engine?.clearPointer();
  }

  private async start(): Promise<void> {
    const view = this.document.defaultView;
    if (!view) return;

    // Capability probe on a THROWAWAY canvas — never the real one (see HeroBackdrop for why:
    // `getContext()` permanently binds a canvas to that context type).
    const probe = this.document.createElement('canvas');
    if (!probe.getContext('webgl2')) return;

    const reduceMotion = view.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const { XylophoneEngine } = await import('./engine/xylophone-engine');

    const canvas = this.canvasRef().nativeElement;
    const { clientWidth: startWidth, clientHeight: startHeight } = this.host.nativeElement;

    let engine: XylophoneEngine;
    try {
      engine = new XylophoneEngine(canvas, startWidth || 1, startHeight || 1, reduceMotion);
    } catch {
      return; // WebGL context creation failed despite the probe — keep the CSS gradient
    }
    this.engine = engine;

    const resize = (): void => {
      const { clientWidth: w, clientHeight: h } = this.host.nativeElement;
      if (w && h) engine.resize(w, h);
    };

    const ro = new ResizeObserver(resize);
    ro.observe(this.host.nativeElement);

    let running = false;
    let lastFrame = 0;
    const frame = (now: number): void => {
      if (!running) return;
      const delta = lastFrame ? (now - lastFrame) / 1000 : 0;
      lastFrame = now;
      engine.render(delta);
      view.requestAnimationFrame(frame);
    };
    const play = (): void => {
      if (running) return;
      running = true;
      lastFrame = 0;
      view.requestAnimationFrame(frame);
    };
    const pause = (): void => {
      running = false;
    };

    // On screen AND the tab in front: both have to hold, and each observer below knows only one of
    // them. Resuming straight from `visibilitychange` would restart the sim for someone who tabbed
    // away from a page they had already scrolled well past the hero on.
    let onScreen = false;
    const sync = (): void => {
      if (onScreen && !this.document.hidden) play();
      else pause();
    };

    const io = new IntersectionObserver(
      (entries) => {
        onScreen = entries.some((e) => e.isIntersecting);
        sync();
      },
      { threshold: 0.01 },
    );
    io.observe(this.host.nativeElement);

    this.document.addEventListener('visibilitychange', sync);

    // Draw one frame before revealing, so the fade never exposes an empty canvas. The bars
    // themselves load separately and appear into this already-visible scene once ready, rather
    // than gating the whole reveal on a network fetch. The loop itself starts from the observer's
    // first callback, which lands on the next frame.
    engine.render(0);
    this.ready.set(true);

    void engine.load({ modelUrl: '/xylophone/xylophone-bar.glb' });

    this.teardown = () => {
      pause();
      ro.disconnect();
      io.disconnect();
      this.document.removeEventListener('visibilitychange', sync);
      engine.dispose();
    };
  }

  ngOnDestroy(): void {
    this.teardown?.();
  }
}
