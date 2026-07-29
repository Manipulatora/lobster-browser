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

import type { DeviceScene } from '../device-mockup/device-scene';

/**
 * Section two: a MacBook and an iPhone, animated entirely by scroll position.
 *
 * The section is a tall scroll track wrapping a sticky, viewport-height stage. Progress through the
 * track drives the sequence — the laptop opens first, then the phone rises — and because the scene
 * is a pure function of that progress, scrolling back up plays it in reverse with no extra state.
 *
 * Nothing 3D loads until the section is near the viewport: three plus the model and screen textures
 * are ~2 MB, which has no business loading for someone who only reads the hero.
 */
@Component({
  selector: 'app-devices-section',
  // Angular hosts default to display:inline, whose box does not reliably reflect the section's
  // geometry — which breaks both getBoundingClientRect() and IntersectionObserver against it.
  host: { class: 'block' },
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './devices-section.html',
})
export class DevicesSection {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stageRef = viewChild.required<ElementRef<HTMLElement>>('stage');
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);

  protected readonly loaded = signal(false);

  private scene?: DeviceScene;
  private cleanup?: () => void;

  constructor() {
    afterNextRender(() => this.observe());
  }

  private observe(): void {
    const view = this.document.defaultView;
    if (!view) return;
    if (typeof IntersectionObserver === 'undefined') {
      void this.boot();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        void this.boot();
      },
      { rootMargin: '400px 0px' },
    );
    io.observe(this.host.nativeElement);
  }

  private async boot(): Promise<void> {
    const view = this.document.defaultView;
    const canvas = this.canvasRef().nativeElement;
    if (!view || !canvas.getContext('webgl2')) return;

    const { DeviceScene } = await import('../device-mockup/device-scene');
    const stage = this.stageRef().nativeElement;

    const scene = new DeviceScene({
      canvas,
      container: stage,
      desktopScreen: '/screens/desktop.png',
      phoneScreen: '/screens/mobile.png',
      isNarrow: () => view.matchMedia('(max-width: 768px)').matches,
    });
    this.scene = scene;

    scene.resize();
    try {
      await scene.load();
    } catch {
      scene.dispose();
      this.scene = undefined;
      return;
    }
    scene.resize();

    /** Map how far the sticky stage has travelled through its track onto 0..1. */
    const progress = (): number => {
      const rect = this.host.nativeElement.getBoundingClientRect();
      const travel = rect.height - view.innerHeight;
      if (travel <= 0) return 0;
      return Math.min(Math.max(-rect.top / travel, 0), 1);
    };

    // Scroll events fire far more often than frames, so the read is coalesced into the next one.
    let queued = false;
    const onScroll = (): void => {
      if (queued) return;
      queued = true;
      view.requestAnimationFrame(() => {
        queued = false;
        scene.setProgress(progress());
      });
    };

    scene.setProgress(progress());
    this.loaded.set(true);

    // Render only while on screen — otherwise this competed with the hero's shader for the GPU
    // even when scrolled far away.
    const vis = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && !this.document.hidden) scene.start();
        else scene.stop();
      },
      { threshold: 0 },
    );
    vis.observe(this.host.nativeElement);

    const onResize = (): void => {
      scene.resize();
      scene.setProgress(progress());
    };
    const onVisibility = (): void => {
      if (this.document.hidden) scene.stop();
    };

    view.addEventListener('scroll', onScroll, { passive: true });
    view.addEventListener('resize', onResize, { passive: true });
    this.document.addEventListener('visibilitychange', onVisibility);

    this.cleanup = () => {
      vis.disconnect();
      view.removeEventListener('scroll', onScroll);
      view.removeEventListener('resize', onResize);
      this.document.removeEventListener('visibilitychange', onVisibility);
    };
  }

  ngOnDestroy(): void {
    this.cleanup?.();
    this.scene?.dispose();
  }
}
