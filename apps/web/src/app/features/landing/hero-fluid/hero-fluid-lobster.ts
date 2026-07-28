import {
  ChangeDetectionStrategy,
  Component,
  ElementRef,
  DOCUMENT,
  afterNextRender,
  inject,
  viewChild,
} from '@angular/core';

import { FlipFluid, type Obstacle } from './flip-fluid';
import { AsciiRenderer } from './ascii-renderer';
import { LOBSTER } from './lobster-geometry';
import { isInsideShape, toSimulationSpace } from './lobster-shape';

/**
 * The hero visual: a FLIP fluid of ASCII characters flowing around a lobster.
 *
 * The lobster is never drawn. It is the simulation's obstacle, so particles cannot enter it and the
 * silhouette emerges as negative space in a field of glyphs — the same idea as
 * https://github.com/javierbyte/fluid-triangle, which spells FLUID around a triangle. Here the
 * columns spell LOBSTER and the palette is the site's violet on light.
 *
 * Runtime behaviour:
 * - **SSR-safe.** Everything starts inside `afterNextRender`, so the server emits only the static
 *   fallback frame and no browser API is touched during prerendering.
 * - **Paused when off-screen** via `IntersectionObserver`, and when the tab is hidden.
 * - **Respects `prefers-reduced-motion`:** renders one settled frame and stops.
 */
@Component({
  selector: 'app-hero-fluid-lobster',
  changeDetection: ChangeDetectionStrategy.OnPush,
  host: { class: 'block' },
  template: `
    <div
      class="relative aspect-square w-full select-none overflow-hidden rounded-panel border-[0.5px] border-hairline bg-surface-soft"
    >
      <pre
        #out
        aria-hidden="true"
        class="pointer-events-none absolute inset-0 m-0 flex items-center justify-center whitespace-pre text-center font-mono leading-[1] tracking-[0.4em] text-brand-500/90"
      ></pre>
      <span class="sr-only">An animated fluid simulation flowing around a lobster silhouette.</span>
    </div>
  `,
})
export class HeroFluidLobster {
  private readonly out = viewChild.required<ElementRef<HTMLPreElement>>('out');
  private readonly host = inject(ElementRef<HTMLElement>);
  private readonly document = inject(DOCUMENT);

  /** Square character grid. 64 keeps the lobster readable while staying cheap. */
  private static readonly COLS = 64;
  private static readonly ROWS = 64;

  /** Simulation tank, in simulation units. Square to match the grid. */
  private static readonly TANK = 2.0;

  private fluid?: FlipFluid;
  private renderer?: AsciiRenderer;
  private obstacle: Obstacle = [];
  /** Per-cell obstacle rasterisation, reused each frame. */
  private mask?: Uint8Array;
  private frame = 0;
  private running = false;
  private disposed = false;

  /** Elapsed seconds, driving the lobster's sway. */
  private angle = 0;

  constructor() {
    afterNextRender(() => this.start());
  }

  private start(): void {
    const reduceMotion =
      this.document.defaultView?.matchMedia('(prefers-reduced-motion: reduce)').matches ?? false;

    const { COLS, ROWS, TANK } = HeroFluidLobster;

    // The pressure grid is a little finer than the character grid; going much finer costs a lot for
    // detail the glyphs cannot show anyway. Particles are sized so a near-full tank lands around two
    // per character cell — enough for a dense field with visible density variation.
    const spacing = TANK / (COLS * 1.1);
    const particleRadius = 0.34 * spacing;

    this.obstacle = toSimulationSpace(LOBSTER, TANK * 0.72, TANK / 2, TANK * 0.5);

    const fluid = new FlipFluid({
      density: 1000,
      width: TANK,
      height: TANK,
      spacing,
      particleRadius,
      maxParticles: 12000,
    });

    // Fill the tank almost completely, skipping the lobster: seeding inside the obstacle would make
    // frame one explode as the collision pass ejects every trapped particle at once.
    //
    // A nearly-full tank is deliberate. The fluid is incompressible, so with nowhere to drain it
    // stays spread across the whole frame instead of pooling on the floor — which is the only way
    // the lobster stays surrounded, and therefore legible, at every moment. The thin sliver of
    // headroom left at the top gives a free surface that ripples, keeping the field alive.
    const dx = 2 * particleRadius;
    const dy = (Math.sqrt(3) / 2) * dx;
    const margin = particleRadius * 1.5;
    const fillTop = TANK * 0.93;
    for (let y = margin, row = 0; y < fillTop; y += dy, row++) {
      // Offset alternate rows for hexagonal packing (denser and far more stable than a square grid).
      const offset = row % 2 === 0 ? 0 : particleRadius;
      for (let x = margin + offset; x < TANK - margin; x += dx) {
        if (isInsideShape(this.obstacle, x, y)) continue;
        if (!fluid.addParticle(x, y)) break;
      }
    }

    fluid.setObstacle(this.obstacle);

    this.fluid = fluid;
    this.renderer = new AsciiRenderer({ cols: COLS, rows: ROWS, saturation: 3.1, floor: 1.45 });

    this.fitType();
    this.document.defaultView?.addEventListener('resize', this.onResize, { passive: true });

    if (reduceMotion) {
      // Settle to a plausible resting frame, then stop: no animation loop at all.
      for (let i = 0; i < 90; i++) this.step(1 / 90);
      this.paint();
      return;
    }

    this.observeVisibility();
  }

  /** Scale the monospace type so exactly COLS characters span the square. */
  private readonly onResize = (): void => this.fitType();

  private fitType(): void {
    const el = this.out().nativeElement;
    const width = this.host.nativeElement.clientWidth;
    if (!width) return;
    // A monospace glyph advances 0.6em; the 0.4em of tracking in the template brings the advance to
    // exactly 1em, which — paired with line-height 1 — makes every character cell SQUARE. Without
    // that the 64x64 grid would render as a tall rectangle and the lobster would look stretched.
    const CELL_EM = 1;
    el.style.fontSize = `${width / (HeroFluidLobster.COLS * CELL_EM)}px`;
  }

  private observeVisibility(): void {
    const view = this.document.defaultView;
    if (!view || typeof IntersectionObserver === 'undefined') {
      this.resume();
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible) this.resume();
        else this.pause();
      },
      { threshold: 0.05 },
    );
    io.observe(this.host.nativeElement);

    view.addEventListener('pagehide', () => this.dispose(), { once: true });
    this.document.addEventListener('visibilitychange', () => {
      if (this.document.hidden) this.pause();
      else this.resume();
    });
  }

  /**
   * Simulate at 30Hz rather than at the display rate.
   *
   * A pressure solve over ~10k particles is the expensive part of the frame, and the motion here is
   * deliberately slow, so stepping every other frame is imperceptible and halves the CPU cost. The
   * step size stays fixed: a variable dt makes an incompressible solver visibly unstable.
   */
  private static readonly STEP_HZ = 30;

  private resume(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    const view = this.document.defaultView;
    const period = 1000 / HeroFluidLobster.STEP_HZ;
    let last = view?.performance.now() ?? 0;

    const loop = (): void => {
      if (!this.running) return;
      const now = view?.performance.now() ?? 0;
      if (now - last >= period) {
        // Never chase a backlog after a long pause (background tab, slow device): one step per tick.
        last = now;
        this.step(1 / HeroFluidLobster.STEP_HZ);
        this.paint();
      }
      this.frame = view?.requestAnimationFrame(loop) ?? 0;
    };
    this.frame = view?.requestAnimationFrame(loop) ?? 0;
  }

  private pause(): void {
    this.running = false;
    if (this.frame) this.document.defaultView?.cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private dispose(): void {
    this.pause();
    this.disposed = true;
    this.document.defaultView?.removeEventListener('resize', this.onResize);
  }

  private step(dt: number): void {
    const fluid = this.fluid;
    if (!fluid) return;

    // ZERO GRAVITY — deliberately.
    //
    // The lobster displaces about a fifth of the tank, so under gravity the fluid can never cover
    // the whole frame: roughly that much empty headroom always exists, it collects wherever "down"
    // points, and it drifts across the silhouette. Rotating gravity only moves the problem around.
    // With no gravity at all, an incompressible fluid seeded uniformly simply *stays* uniform, so
    // coverage is even and the lobster stays legible indefinitely.
    //
    // Motion instead comes from the lobster itself: it sways on two out-of-phase sine waves, and the
    // obstacle pushing through the fluid is what generates the currents. It also means the movement
    // is concentrated exactly where the eye already is.
    this.angle += dt;
    const t = this.angle;
    const { TANK } = HeroFluidLobster;
    const sway = 0.022 * TANK;
    this.obstacle = toSimulationSpace(
      LOBSTER,
      TANK * 0.72,
      TANK / 2 + sway * Math.sin(t * 0.62),
      TANK * 0.5 + sway * Math.sin(t * 0.41 + 1.1),
    );

    this.updateMask();

    fluid.simulate({
      dt,
      gravity: 0,
      gravityX: 0,
      flipRatio: 0.92,
      numPressureIters: 12,
      numParticleIters: 2,
      overRelaxation: 1.9,
      compensateDrift: true,
      separateParticles: true,
      obstacle: this.obstacle,
      numSubSteps: 1,
    });
  }

  /**
   * Rasterise the obstacle into a per-cell mask.
   *
   * Only cells inside the shape's bounding box are tested, and each polygon is bbox-rejected before
   * its edges are walked, so this is a few thousand operations per frame rather than a quarter of a
   * million.
   */
  private updateMask(): void {
    const { COLS, ROWS, TANK } = HeroFluidLobster;
    const mask = (this.mask ??= new Uint8Array(COLS * ROWS));
    mask.fill(0);

    let minX = Infinity,
      minY = Infinity,
      maxX = -Infinity,
      maxY = -Infinity;
    for (const poly of this.obstacle) {
      for (const [x, y] of poly) {
        if (x < minX) minX = x;
        if (y < minY) minY = y;
        if (x > maxX) maxX = x;
        if (y > maxY) maxY = y;
      }
    }
    if (minX > maxX) return;

    // Simulation space is y-up, the grid is y-down.
    const c0 = Math.max(0, Math.floor((minX / TANK) * COLS));
    const c1 = Math.min(COLS - 1, Math.ceil((maxX / TANK) * COLS));
    const r0 = Math.max(0, Math.floor(((TANK - maxY) / TANK) * ROWS));
    const r1 = Math.min(ROWS - 1, Math.ceil(((TANK - minY) / TANK) * ROWS));

    for (let r = r0; r <= r1; r++) {
      const y = TANK - ((r + 0.5) * TANK) / ROWS;
      for (let c = c0; c <= c1; c++) {
        const x = ((c + 0.5) * TANK) / COLS;
        if (isInsideShape(this.obstacle, x, y)) mask[r * COLS + c] = 1;
      }
    }
  }

  private paint(): void {
    const fluid = this.fluid;
    const renderer = this.renderer;
    if (!fluid || !renderer) return;
    this.out().nativeElement.textContent = renderer.render(
      fluid.particlePos,
      fluid.numParticles,
      HeroFluidLobster.TANK,
      HeroFluidLobster.TANK,
      this.mask,
    );
  }
}
