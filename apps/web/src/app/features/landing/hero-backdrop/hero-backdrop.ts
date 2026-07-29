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
import type { Texture } from 'three/webgpu';

/**
 * Animated scenic backdrop for the hero.
 *
 * Everything about how this loads is deliberate:
 *
 * - **Lazy.** `three/webgpu` is ~283 kB gzip. It is pulled in with a dynamic `import()` so it lands
 *   in its own chunk, off the critical path and outside Angular's initial-bundle budget.
 * - **SSR-safe.** The work happens in `afterNextRender`, which Angular never runs on the server, so
 *   prerendering the static routes never touches WebGL.
 * - **Degrades quietly.** The hero paints a CSS gradient underneath this component, and the canvas
 *   only fades in once the shader has actually compiled. No-WebGL, reduced-motion, slow network and
 *   prerendered HTML all land on that same fallback without extra branches.
 * - **Idle when unseen.** An IntersectionObserver drives the loop and hidden tabs pause it — a
 *   full-screen fragment shader is not cheap, and this is a marketing page.
 */
@Component({
  selector: 'app-hero-backdrop',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <canvas
      #canvas
      aria-hidden="true"
      class="h-full w-full transition-opacity duration-1000 ease-out"
      [class.opacity-0]="!ready()"
      [class.opacity-100]="ready()"
    ></canvas>
  `,
})
export class HeroBackdrop {
  private readonly canvasRef = viewChild.required<ElementRef<HTMLCanvasElement>>('canvas');
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);

  /** Flipped once the first frame is on screen; drives the fade-in. */
  protected readonly ready = signal(false);

  private dispose?: () => void;

  constructor() {
    afterNextRender(() => void this.start());
  }

  private async start(): Promise<void> {
    const view = this.document.defaultView;
    if (!view) return;

    // The motion is purely decorative — if it is unwelcome, never download the library at all.
    if (view.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const canvas = this.canvasRef().nativeElement;

    // Probe before importing. three's WebGPURenderer falls back to WebGL2 on its own, but with
    // NEITHER backend available `init()` rejects with an unhelpful TypeError — and this way we skip
    // a 283 kB download we could not have used.
    if (!canvas.getContext('webgl2')) return;

    const [THREE, { createBackdrop }] = await Promise.all([
      import('three/webgpu'),
      import('./backdrop-shader'),
    ]);

    const loader = new THREE.TextureLoader();
    const load = (url: string): Promise<Texture> =>
      new Promise((resolve, reject) => loader.load(url, resolve, undefined, reject));

    let noise: Texture;
    let stars: Texture;
    try {
      [noise, stars] = await Promise.all([
        load('/textures/bmp01.jpg'),
        load('/textures/tex12.png'),
      ]);
    } catch {
      return; // textures missing — keep the CSS gradient
    }
    for (const t of [noise, stars]) {
      t.wrapS = THREE.RepeatWrapping;
      t.wrapT = THREE.RepeatWrapping;
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
    }

    // A full-screen quad under an orthographic camera: the shader does all the work, the geometry is
    // just a carrier for the fragment stage.
    const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const scene = new THREE.Scene();
    const material = new THREE.MeshBasicNodeMaterial();
    const { colorNode } = createBackdrop({ noise, stars });
    material.colorNode = colorNode;
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), material));

    const renderer = new THREE.WebGPURenderer({ canvas, antialias: false, alpha: false });
    renderer.setPixelRatio(Math.min(view.devicePixelRatio, 1.75));

    const resize = (): void => {
      const { clientWidth: w, clientHeight: h } = this.host.nativeElement;
      if (w && h) renderer.setSize(w, h, false);
      // No camera update on purpose: the quad spans [-1,1] and aspect comes from the built-in
      // screenSize uniform inside the shader. (The reference assigns `.aspect` on an
      // OrthographicCamera, which has no such property and silently does nothing.)
    };
    resize();

    try {
      await renderer.init();
      await renderer.compileAsync(scene, camera);
    } catch {
      renderer.dispose();
      return; // no usable backend — the CSS gradient stands in
    }

    let running = false;
    const frame = (): void => {
      if (running) renderer.render(scene, camera);
    };
    const play = (): void => {
      if (running) return;
      running = true;
      renderer.setAnimationLoop(frame);
    };
    const pause = (): void => {
      running = false;
      renderer.setAnimationLoop(null);
    };

    const io = new IntersectionObserver(
      (entries) => (entries.some((e) => e.isIntersecting) ? play() : pause()),
      { threshold: 0.01 },
    );
    io.observe(this.host.nativeElement);

    const onVisibility = (): void => {
      if (this.document.hidden) pause();
      else play();
    };
    this.document.addEventListener('visibilitychange', onVisibility);
    view.addEventListener('resize', resize, { passive: true });

    // Draw one frame before revealing, so the fade never exposes an empty canvas.
    renderer.render(scene, camera);
    this.ready.set(true);

    this.dispose = () => {
      pause();
      io.disconnect();
      view.removeEventListener('resize', resize);
      this.document.removeEventListener('visibilitychange', onVisibility);
      material.dispose();
      noise.dispose();
      stars.dispose();
      renderer.dispose();
    };
  }

  ngOnDestroy(): void {
    this.dispose?.();
  }
}
