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

import type { DeviceScene, Focus } from '../device-mockup/device-scene';

/**
 * Section two: an interactive 3D MacBook and iPhone showing the product.
 *
 * Nothing 3D is downloaded until the section is actually approaching the viewport — three plus the
 * model and screen textures are ~2 MB, which has no business loading for someone who only reads the
 * hero. The section renders complete, styled and legible without any of it.
 */
@Component({
  selector: 'app-devices-section',
  changeDetection: ChangeDetectionStrategy.OnPush,
  templateUrl: './devices-section.html',
})
export class DevicesSection {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly stageRef = viewChild.required<ElementRef<HTMLElement>>('stage');
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);

  protected readonly loaded = signal(false);
  protected readonly focus = signal<Focus>('');

  private scene?: DeviceScene;
  private cleanup?: () => void;

  constructor() {
    afterNextRender(() => this.observe());
  }

  /** Begin loading only once the section is near the viewport. */
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
      // A generous margin so the model is usually ready by the time it is scrolled to.
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
      onFocusChange: (f) => this.focus.set(f),
    });
    this.scene = scene;

    scene.resize();
    try {
      await scene.load();
    } catch {
      scene.dispose();
      this.scene = undefined;
      return; // leave the static fallback in place
    }
    scene.resize();
    scene.start();
    this.loaded.set(true);

    const onMove = (e: PointerEvent): void => scene.onPointerMove(e.clientX, e.clientY);
    const onLeave = (): void => scene.onPointerLeave();
    const onClick = (e: PointerEvent): void => scene.onClick(e.clientX, e.clientY);
    const onResize = (): void => scene.resize();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && scene.currentFocus) scene.setFocus('');
    };

    stage.addEventListener('pointermove', onMove);
    stage.addEventListener('pointerleave', onLeave);
    stage.addEventListener('click', onClick);
    view.addEventListener('resize', onResize, { passive: true });
    this.document.addEventListener('keydown', onKey);

    this.cleanup = () => {
      stage.removeEventListener('pointermove', onMove);
      stage.removeEventListener('pointerleave', onLeave);
      stage.removeEventListener('click', onClick);
      view.removeEventListener('resize', onResize);
      this.document.removeEventListener('keydown', onKey);
    };
  }

  /** Buttons give the same control as clicking the models — and make it reachable by keyboard. */
  protected select(target: Focus): void {
    this.scene?.setFocus(this.focus() === target ? '' : target);
  }

  ngOnDestroy(): void {
    this.cleanup?.();
    this.scene?.dispose();
  }
}
