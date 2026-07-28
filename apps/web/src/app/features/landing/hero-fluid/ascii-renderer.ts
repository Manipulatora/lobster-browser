/**
 * ASCII renderer for the hero fluid.
 *
 * Particles are binned into a character grid and each cell's density is mapped to a glyph from a
 * brightness ramp, so the fluid reads as text rather than pixels. Each column gets its own ramp,
 * spelling LOBSTER across the width — the same trick the original `fluid-triangle` uses to spell
 * FLUID (see https://github.com/javierbyte/fluid-triangle).
 *
 * The obstacle needs no drawing at all: particles cannot enter it, so those cells stay empty and the
 * lobster appears as negative space in a sea of characters.
 *
 * Output is written with `textContent` (never `innerHTML`) — it is the hot path once per frame, and
 * it keeps the component trivially XSS-safe.
 */

/** Dim glyphs shared by every column, brightest → faintest. */
const TAIL = ['~', ':', '-', '·', ' ', ' '] as const;

/** One ramp per column letter: solid → light → the shared dim tail. */
function ramp(letter: string): readonly string[] {
  return [letter, letter, letter.toLowerCase(), ...TAIL];
}

const WORD = 'LOBSTER';
const RAMPS: readonly (readonly string[])[] = [...WORD].map(ramp);

export interface AsciiRendererOptions {
  readonly cols: number;
  readonly rows: number;
  /** Particle count per cell that counts as fully "solid". Higher = sparser look. */
  readonly saturation?: number;
  /**
   * Particle count at or below which a cell renders blank.
   *
   * Without this the handful of stragglers left in the lobster's wake each paint a faint glyph and
   * the silhouette turns to mush. Clipping the bottom of the range keeps the void genuinely empty,
   * which is the whole reason the shape is readable.
   */
  readonly floor?: number;
}

export class AsciiRenderer {
  readonly cols: number;
  readonly rows: number;

  private readonly saturation: number;
  private readonly floor: number;
  private readonly density: Float32Array;
  /** Reused per frame so a 60fps render allocates nothing. */
  private readonly line: string[];

  constructor(options: AsciiRendererOptions) {
    this.cols = options.cols;
    this.rows = options.rows;
    this.saturation = options.saturation ?? 3.2;
    this.floor = options.floor ?? 0;
    this.density = new Float32Array(this.cols * this.rows);
    this.line = new Array<string>(this.cols);
  }

  /**
   * Bin `count` particles (interleaved x,y in simulation units) into the grid and return the frame
   * as a newline-separated string.
   *
   * Simulation space is y-up (physics convention); the character grid is y-down, so rows are flipped.
   */
  render(
    positions: Float32Array,
    count: number,
    simWidth: number,
    simHeight: number,
    /**
     * Optional per-cell obstacle mask (1 = inside the obstacle). Cells marked here always render
     * blank.
     *
     * The fluid alone cannot carve a clean silhouette: a leg two cells wide leaves cells that are
     * half solid and half fluid, so they still collect particles and paint a glyph — measured at
     * ~37% contamination inside the shape. The obstacle is a shape we already know exactly, so the
     * honest thing is to rasterise it rather than hope the particles imply it. The fluid still flows
     * around it for real; this only decides what gets drawn.
     */
    mask?: Uint8Array,
  ): string {
    const { cols, rows, density } = this;
    density.fill(0);

    const sx = cols / simWidth;
    const sy = rows / simHeight;

    for (let i = 0; i < count; i++) {
      const x = positions[2 * i] * sx;
      // Flip Y: simulation origin is bottom-left, text grid is top-left.
      const y = rows - positions[2 * i + 1] * sy;
      const cx = x | 0;
      const cy = y | 0;
      if (cx < 0 || cy < 0 || cx >= cols || cy >= rows) continue;
      density[cy * cols + cx] += 1;
    }

    const out: string[] = new Array<string>(rows);
    for (let r = 0; r < rows; r++) {
      const rowOffset = r * cols;
      for (let c = 0; c < cols; c++) {
        if (mask !== undefined && mask[rowOffset + c] === 1) {
          this.line[c] = ' ';
          continue;
        }
        const glyphs = RAMPS[c % RAMPS.length];
        // Normalise density between the blank floor and full saturation, then index the ramp
        // brightest-first. Clipping at the floor is what keeps the obstacle's void crisp.
        const d = density[rowOffset + c];
        const t = Math.min(1, Math.max(0, (d - this.floor) / (this.saturation - this.floor)));
        const idx = Math.min(glyphs.length - 1, Math.round((1 - t) * (glyphs.length - 1)));
        this.line[c] = glyphs[idx];
      }
      out[r] = this.line.join('');
    }
    return out.join('\n');
  }
}
