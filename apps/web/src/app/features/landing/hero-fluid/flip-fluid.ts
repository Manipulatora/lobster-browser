/**
 * FLIP (Fluid-Implicit-Particle) fluid solver — strict TypeScript port.
 *
 * Ported from Matthias Müller's "Ten Minute Physics", tutorial #18 (FLIP water):
 *   https://github.com/matthias-research/pages/blob/master/tenMinutePhysics/18-flip.html
 *   https://www.youtube.com/c/TenMinutePhysics
 *   https://www.matthiasMueller.info/tenMinutePhysics
 *
 * Copyright 2022 Matthias Müller - Ten Minute Physics
 *
 * MIT License
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies
 * of the Software, and to permit persons to whom the Software is furnished to do
 * so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 *
 * ---------------------------------------------------------------------------
 * Changes from the original:
 *  - The hard-coded triangle obstacle is replaced by an arbitrary multi-polygon
 *    obstacle (see {@link Obstacle}), with per-polygon bounding boxes so the
 *    per-particle inner loop early-rejects almost everything. Containment uses
 *    union semantics and particles are snapped to the union *boundary*, so
 *    overlapping polygons (a glyph built from several strokes) read as one
 *    solid instead of trapping fluid in the overlap.
 *  - No DOM, no canvas, no globals: gravity and every tunable arrive as
 *    parameters, so this module is safe to *import* during SSR (only
 *    *instantiate* it in the browser).
 *  - Per-particle RGB colours were dropped (the original never rendered them);
 *    the per-cell "sci colour" ramp survives as a single-channel
 *    {@link FlipFluid.cellIntensity} field, since the original wrote three
 *    identical channels.
 * ---------------------------------------------------------------------------
 */

/* ------------------------------------------------------------------ types */

/** A point in simulation space: `[x, y]`. Y grows *upwards*. */
export type Point = readonly [number, number];

/** A closed polygon; the final vertex is implicitly joined back to the first. */
export type Polygon = readonly Point[];

/**
 * An obstacle: a list of closed polygons in **simulation-space** coordinates
 * (not pixels). Fluid is kept out of the *union* of the polygons.
 */
export type Obstacle = readonly Polygon[];

export interface FlipFluidOptions {
  /** Rest density of the fluid, e.g. `1000`. Only scales the pressure field. */
  density: number;
  /** Tank width in simulation units. */
  width: number;
  /** Tank height in simulation units. */
  height: number;
  /** Target grid cell size; the real cell size is snapped to fit the tank. */
  spacing: number;
  /** Particle radius; ~0.3 * cell size gives a well-packed fluid. */
  particleRadius: number;
  /** Upper bound on particles — every buffer is sized from this. */
  maxParticles: number;
}

/**
 * One `simulate()` step. Grouped into an object because the original's
 * positional signature had eleven arguments and two of them were misspelled.
 */
export interface SimulateParams {
  /** Timestep in seconds (the original hero used ~1/180). */
  readonly dt: number;
  /** Vertical acceleration. Negative points *down* (y grows upwards). */
  readonly gravity: number;
  /** Optional horizontal acceleration, for tilt/pointer-driven gravity. */
  readonly gravityX?: number;
  /** 0 = pure PIC (viscous, stable), 1 = pure FLIP (energetic, noisy). ~0.9. */
  readonly flipRatio: number;
  /** Gauss-Seidel sweeps for the pressure solve. ~30. */
  readonly numPressureIters: number;
  /** Relaxation passes for particle separation. ~2. */
  readonly numParticleIters: number;
  /** Successive over-relaxation factor, in (1, 2). ~1.9. */
  readonly overRelaxation: number;
  /** Push back against local over-packing; kills FLIP volume drift. */
  readonly compensateDrift: boolean;
  /** Run the spatial-hash particle separation pass. */
  readonly separateParticles: boolean;
  /** Obstacle for this step, or `null` for an empty tank. */
  readonly obstacle: Obstacle | null;
  /** Substeps per call (default 1); each substep uses `dt / numSubSteps`. */
  readonly numSubSteps?: number;
}

/** Cell classification used by the pressure solve and the G2P transfer. */
export const CellType = {
  Fluid: 0,
  Air: 1,
  Solid: 2,
} as const;

export type CellTypeValue = (typeof CellType)[keyof typeof CellType];

// Hot-loop aliases: plain module constants inline better than property reads.
const FLUID_CELL = 0;
const AIR_CELL = 1;
const SOLID_CELL = 2;

const U_COMPONENT = 0;

/* -------------------------------------------------------------- utilities */

function clamp(x: number, min: number, max: number): number {
  if (x < min) return min;
  if (x > max) return max;
  return x;
}

/**
 * Hex-packed particle block layout, so callers can size `maxParticles`
 * *before* constructing the fluid and then seed the exact same grid.
 */
export function hexPackedBlock(
  blockWidth: number,
  blockHeight: number,
  particleRadius: number,
): { readonly numX: number; readonly numY: number; readonly count: number } {
  const dx = 2 * particleRadius;
  const dy = (Math.sqrt(3) / 2) * dx;
  const numX = Math.max(Math.floor(blockWidth / dx), 0);
  const numY = Math.max(Math.floor(blockHeight / dy), 0);
  return { numX, numY, count: numX * numY };
}

/* ------------------------------------------------- compiled obstacle form */

/**
 * A polygon flattened to `[x0, y0, x1, y1, …]` with its bounding box.
 * Flat Float64Arrays keep the per-particle edge walk cache-friendly and free
 * of the megamorphic `{x, y}` object reads the original did *per particle*.
 */
interface CompiledPolygon {
  readonly coords: Float64Array;
  readonly numVerts: number;
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

interface CompiledObstacle {
  /** Identity of the source array, used to skip recompilation. */
  readonly source: Obstacle;
  readonly polygons: readonly CompiledPolygon[];
  readonly minX: number;
  readonly minY: number;
  readonly maxX: number;
  readonly maxY: number;
}

function compileObstacle(source: Obstacle): CompiledObstacle {
  const polygons: CompiledPolygon[] = [];
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const polygon of source) {
    // Fewer than three vertices encloses no area — nothing to collide with.
    if (polygon.length < 3) continue;

    const numVerts = polygon.length;
    const coords = new Float64Array(numVerts * 2);
    let pMinX = Infinity;
    let pMinY = Infinity;
    let pMaxX = -Infinity;
    let pMaxY = -Infinity;

    let k = 0;
    for (const [x, y] of polygon) {
      coords[k++] = x;
      coords[k++] = y;
      if (x < pMinX) pMinX = x;
      if (x > pMaxX) pMaxX = x;
      if (y < pMinY) pMinY = y;
      if (y > pMaxY) pMaxY = y;
    }

    polygons.push({
      coords,
      numVerts,
      minX: pMinX,
      minY: pMinY,
      maxX: pMaxX,
      maxY: pMaxY,
    });

    if (pMinX < minX) minX = pMinX;
    if (pMinY < minY) minY = pMinY;
    if (pMaxX > maxX) maxX = pMaxX;
    if (pMaxY > maxY) maxY = pMaxY;
  }

  return { source, polygons, minX, minY, maxX, maxY };
}

/** Crossings of a `+x` ray from (px, py) against one polygon's edges. */
function rayCrossings(px: number, py: number, poly: CompiledPolygon): number {
  const c = poly.coords;
  const n2 = poly.numVerts * 2;
  let crossings = 0;

  let ax = c[n2 - 2];
  let ay = c[n2 - 1];
  for (let k = 0; k < n2; k += 2) {
    const bx = c[k];
    const by = c[k + 1];
    // Half-open vertical span test: a vertex exactly on the ray is counted
    // once, never twice, which is what keeps the parity test watertight.
    if (ay > py !== by > py) {
      const t = (py - ay) / (by - ay);
      if (px < ax + t * (bx - ax)) crossings++;
    }
    ax = bx;
    ay = by;
  }
  return crossings;
}

/** Squared distance from a point to a bounding box (0 when inside). */
function bboxDistanceSq(px: number, py: number, poly: CompiledPolygon): number {
  const dx = px < poly.minX ? poly.minX - px : px > poly.maxX ? px - poly.maxX : 0;
  const dy = py < poly.minY ? poly.minY - py : py > poly.maxY ? py - poly.maxY : 0;
  return dx * dx + dy * dy;
}

/* ------------------------------------------------------------------ solver */

export class FlipFluid {
  // --- grid (staggered / MAC) -----------------------------------------
  // u lives on vertical cell faces, v on horizontal ones. Storing velocity on
  // faces (rather than at cell centres) is what makes the divergence and the
  // pressure gradient exact inverses of each other, so the projection below
  // can actually drive divergence to zero instead of chasing a checkerboard.

  readonly density: number;
  /** Grid columns. Index a cell as `i * fNumY + j`. */
  readonly fNumX: number;
  /** Grid rows. */
  readonly fNumY: number;
  /** Actual cell size (>= the requested `spacing`). */
  readonly h: number;
  /** `1 / h`, precomputed because it is used per particle per pass. */
  readonly fInvSpacing: number;
  readonly fNumCells: number;

  /** Horizontal face velocities. */
  readonly u: Float32Array;
  /** Vertical face velocities. */
  readonly v: Float32Array;
  /** Velocity at the start of the projection — the FLIP delta baseline. */
  readonly prevU: Float32Array;
  readonly prevV: Float32Array;
  /** Accumulated P2G weights (scratch). */
  private readonly du: Float32Array;
  private readonly dv: Float32Array;
  /** Pressure, accumulated over the Gauss-Seidel sweeps. Diagnostic only. */
  readonly p: Float32Array;
  /** Solidity mask: `0` = solid wall, `1` = free. Set this before simulating. */
  readonly s: Float32Array;
  /** Per-cell {@link CellType}. */
  readonly cellType: Int32Array;
  /** Single-channel render ramp; see {@link updateCellIntensity}. */
  readonly cellIntensity: Float32Array;

  // --- particles -------------------------------------------------------
  readonly maxParticles: number;
  /** Interleaved `[x0, y0, x1, y1, …]`, valid up to `2 * numParticles`. */
  readonly particlePos: Float32Array;
  /** Interleaved `[vx0, vy0, …]`. */
  readonly particleVel: Float32Array;
  /** Particle count splatted onto the grid; drives drift compensation. */
  readonly particleDensity: Float32Array;
  readonly particleRadius: number;

  /** Tank extents in simulation units, handy for mapping sim → screen. */
  readonly width: number;
  readonly height: number;

  // --- particle spatial hash (separation pass) --------------------------
  private readonly pInvSpacing: number;
  private readonly pNumX: number;
  private readonly pNumY: number;
  private readonly pNumCells: number;
  private readonly numCellParticles: Int32Array;
  private readonly firstCellParticle: Int32Array;
  private readonly cellParticleIds: Int32Array;

  private particleCount = 0;
  private restDensity = 0;

  private compiledObstacle: CompiledObstacle | null = null;

  // Scratch for the nearest-surface-point query; avoids allocating a tuple
  // per colliding particle per frame.
  private nearestX = 0;
  private nearestY = 0;

  constructor(options: FlipFluidOptions) {
    const { density, width, height, spacing, particleRadius, maxParticles } = options;

    this.density = density;
    this.width = width;
    this.height = height;

    this.fNumX = Math.floor(width / spacing);
    this.fNumY = Math.floor(height / spacing);
    this.h = Math.max(width / this.fNumX, height / this.fNumY);
    this.fInvSpacing = 1.0 / this.h;
    this.fNumCells = this.fNumX * this.fNumY;

    this.u = new Float32Array(this.fNumCells);
    this.v = new Float32Array(this.fNumCells);
    this.du = new Float32Array(this.fNumCells);
    this.dv = new Float32Array(this.fNumCells);
    this.prevU = new Float32Array(this.fNumCells);
    this.prevV = new Float32Array(this.fNumCells);
    this.p = new Float32Array(this.fNumCells);
    this.s = new Float32Array(this.fNumCells);
    this.cellType = new Int32Array(this.fNumCells);
    this.cellIntensity = new Float32Array(this.fNumCells);

    this.maxParticles = maxParticles;
    this.particlePos = new Float32Array(2 * maxParticles);
    this.particleVel = new Float32Array(2 * maxParticles);
    this.particleDensity = new Float32Array(this.fNumCells);
    this.particleRadius = particleRadius;

    // The separation hash uses cells slightly wider than a particle diameter,
    // so a 3x3 neighbourhood is guaranteed to contain every possible overlap.
    this.pInvSpacing = 1.0 / (2.2 * particleRadius);
    this.pNumX = Math.floor(width * this.pInvSpacing) + 1;
    this.pNumY = Math.floor(height * this.pInvSpacing) + 1;
    this.pNumCells = this.pNumX * this.pNumY;

    this.numCellParticles = new Int32Array(this.pNumCells);
    this.firstCellParticle = new Int32Array(this.pNumCells + 1);
    this.cellParticleIds = new Int32Array(maxParticles);
  }

  /* ------------------------------------------------------------- setup */

  /** Number of live particles. */
  get numParticles(): number {
    return this.particleCount;
  }

  /**
   * Average particle count per fluid cell, measured on the first step and
   * then held fixed. `0` until the first {@link updateParticleDensity}.
   */
  get particleRestDensity(): number {
    return this.restDensity;
  }

  /** Drop every particle and forget the measured rest density. */
  clearParticles(): void {
    this.particleCount = 0;
    this.restDensity = 0;
  }

  /** Append one particle at rest. Returns `false` once `maxParticles` is hit. */
  addParticle(x: number, y: number): boolean {
    if (this.particleCount >= this.maxParticles) return false;
    const i = this.particleCount++;
    this.particlePos[2 * i] = x;
    this.particlePos[2 * i + 1] = y;
    this.particleVel[2 * i] = 0;
    this.particleVel[2 * i + 1] = 0;
    return true;
  }

  /**
   * Clear and refill with a hex-packed block whose lower-left corner sits at
   * `(originX, originY)`. Use {@link hexPackedBlock} with the same arguments
   * to size `maxParticles` before construction.
   */
  seedBlock(originX: number, originY: number, blockWidth: number, blockHeight: number): number {
    this.clearParticles();

    const r = this.particleRadius;
    const dx = 2 * r;
    const dy = (Math.sqrt(3) / 2) * dx;
    const { numX, numY } = hexPackedBlock(blockWidth, blockHeight, r);

    for (let i = 0; i < numX; i++) {
      for (let j = 0; j < numY; j++) {
        // Odd rows are offset by one radius — that is the hex packing.
        const x = originX + r + dx * i + (j % 2 === 0 ? 0 : r);
        const y = originY + r + dy * j;
        if (!this.addParticle(x, y)) return this.particleCount;
      }
    }
    return this.particleCount;
  }

  /**
   * Standard open-top tank: solid left/right/bottom border, free elsewhere.
   * Without this every cell reads as solid and nothing flows.
   */
  setSolidBorder(closedTop = false): void {
    const n = this.fNumY;
    for (let i = 0; i < this.fNumX; i++) {
      for (let j = 0; j < this.fNumY; j++) {
        const solid =
          i === 0 || i === this.fNumX - 1 || j === 0 || (closedTop && j === this.fNumY - 1);
        this.s[i * n + j] = solid ? 0.0 : 1.0;
      }
    }
  }

  /* ---------------------------------------------------------- obstacle */

  /**
   * Install the obstacle. Compilation (flattening + bounding boxes) is cached
   * on the *identity* of the array you pass, so handing in the same array every
   * frame costs nothing. Mutating a polygon in place without swapping the array
   * leaves the cache stale — call {@link invalidateObstacle} if you do that.
   */
  setObstacle(obstacle: Obstacle | null): void {
    if (obstacle === null) {
      this.compiledObstacle = null;
      return;
    }
    if (this.compiledObstacle !== null && this.compiledObstacle.source === obstacle) return;
    this.compiledObstacle = compileObstacle(obstacle);
  }

  /** Force the next {@link setObstacle} to recompile. */
  invalidateObstacle(): void {
    this.compiledObstacle = null;
  }

  /**
   * Even-odd (crossing-parity) test summed across **all** polygons.
   *
   * Note this makes overlapping polygons cancel out (XOR), which is why the
   * collision response uses {@link isInsideUnion} instead. Exposed because it
   * is the classic even-odd rule and is useful for even-odd fill rendering.
   */
  pointInPolygons(px: number, py: number): boolean {
    const ob = this.compiledObstacle;
    if (ob === null) return false;
    if (px < ob.minX || px > ob.maxX || py < ob.minY || py > ob.maxY) return false;

    let crossings = 0;
    for (const poly of ob.polygons) {
      // A point outside a polygon's box always yields an even (here: zero)
      // crossing count, so skipping it cannot change the parity.
      if (px < poly.minX || px > poly.maxX || py < poly.minY || py > poly.maxY) continue;
      crossings += rayCrossings(px, py, poly);
    }
    return (crossings & 1) === 1;
  }

  /**
   * True when the point is inside *any single* polygon — proper union
   * semantics, so overlapping shapes (a glyph built from several strokes)
   * behave as one solid instead of punching holes in each other.
   */
  isInsideUnion(px: number, py: number): boolean {
    const ob = this.compiledObstacle;
    if (ob === null) return false;
    return this.isInsideCompiledUnion(px, py, ob);
  }

  private isInsideCompiledUnion(px: number, py: number, ob: CompiledObstacle): boolean {
    for (const poly of ob.polygons) {
      if (px < poly.minX || px > poly.maxX || py < poly.minY || py > poly.maxY) continue;
      if ((rayCrossings(px, py, poly) & 1) === 1) return true;
    }
    return false;
  }

  /** True if `(qx, qy)` falls inside some polygon other than `skipIndex`. */
  private insideOtherPolygon(
    qx: number,
    qy: number,
    ob: CompiledObstacle,
    skipIndex: number,
  ): boolean {
    const polys = ob.polygons;
    for (let k = 0; k < polys.length; k++) {
      if (k === skipIndex) continue;
      const poly = polys[k];
      if (qx < poly.minX || qx > poly.maxX || qy < poly.minY || qy > poly.maxY) continue;
      if ((rayCrossings(qx, qy, poly) & 1) === 1) return true;
    }
    return false;
  }

  /**
   * Nearest point on the *union boundary*, written to `nearestX` / `nearestY`.
   *
   * Two details make this correct for overlapping polygons:
   *  - Candidate points that fall inside another polygon are rejected. They lie
   *    on an edge buried in the union's interior, and snapping a particle there
   *    strands it inside the obstacle forever.
   *  - Polygons whose bounding box is already further away than the best
   *    candidate so far are skipped. Exact prune: the distance to a box
   *    lower-bounds the distance to anything inside it.
   *
   * The interior test only runs when a candidate actually improves on the
   * current best, so it fires a handful of times per particle at most — and
   * never at all for a single-polygon obstacle.
   */
  private findNearestSurfacePoint(px: number, py: number, ob: CompiledObstacle): void {
    const polys = ob.polygons;
    const multiPolygon = polys.length > 1;

    let bestDistSq = Infinity;
    this.nearestX = px;
    this.nearestY = py;

    // Used only if every candidate turned out to be buried, which can happen
    // when the per-edge closest points all land in an overlap region.
    let fallbackDistSq = Infinity;
    let fallbackX = px;
    let fallbackY = py;

    for (let pi = 0; pi < polys.length; pi++) {
      const poly = polys[pi];
      if (bboxDistanceSq(px, py, poly) >= bestDistSq) continue;

      const c = poly.coords;
      const n2 = poly.numVerts * 2;
      let ax = c[n2 - 2];
      let ay = c[n2 - 1];

      for (let k = 0; k < n2; k += 2) {
        const bx = c[k];
        const by = c[k + 1];

        // Closest point on segment a→b: project, then clamp t to [0, 1].
        const ex = bx - ax;
        const ey = by - ay;
        const lenSq = ex * ex + ey * ey;
        const t = lenSq > 0 ? clamp(((px - ax) * ex + (py - ay) * ey) / lenSq, 0, 1) : 0;
        const qx = ax + t * ex;
        const qy = ay + t * ey;

        ax = bx;
        ay = by;

        const dx = px - qx;
        const dy = py - qy;
        const distSq = dx * dx + dy * dy;
        if (distSq >= bestDistSq) continue;

        if (distSq < fallbackDistSq) {
          fallbackDistSq = distSq;
          fallbackX = qx;
          fallbackY = qy;
        }

        if (multiPolygon && this.insideOtherPolygon(qx, qy, ob, pi)) continue;

        bestDistSq = distSq;
        this.nearestX = qx;
        this.nearestY = qy;
      }
    }

    if (bestDistSq === Infinity && fallbackDistSq < Infinity) {
      this.nearestX = fallbackX;
      this.nearestY = fallbackY;
    }
  }

  /* ------------------------------------------------------------- steps */

  /** Explicit Euler on the particles; the only place external forces enter. */
  integrateParticles(dt: number, gravityX: number, gravityY: number): void {
    for (let i = 0; i < this.particleCount; i++) {
      this.particleVel[2 * i] += dt * gravityX;
      this.particleVel[2 * i + 1] += dt * gravityY;
      this.particlePos[2 * i] += this.particleVel[2 * i] * dt;
      this.particlePos[2 * i + 1] += this.particleVel[2 * i + 1] * dt;
    }
  }

  /**
   * Relax particle overlaps via a uniform spatial hash.
   *
   * Incompressibility is enforced on the grid, which cannot see sub-cell
   * clumping; this positional pass is what keeps the particle distribution
   * even enough for the density estimate to mean anything.
   */
  pushParticlesApart(numIters: number): void {
    const n = this.pNumY;

    // Counting sort into hash cells: count, prefix-sum, scatter.
    this.numCellParticles.fill(0);

    for (let i = 0; i < this.particleCount; i++) {
      const x = this.particlePos[2 * i];
      const y = this.particlePos[2 * i + 1];
      const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
      const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
      this.numCellParticles[xi * n + yi]++;
    }

    let first = 0;
    for (let i = 0; i < this.pNumCells; i++) {
      first += this.numCellParticles[i];
      this.firstCellParticle[i] = first;
    }
    this.firstCellParticle[this.pNumCells] = first; // guard

    for (let i = 0; i < this.particleCount; i++) {
      const x = this.particlePos[2 * i];
      const y = this.particlePos[2 * i + 1];
      const xi = clamp(Math.floor(x * this.pInvSpacing), 0, this.pNumX - 1);
      const yi = clamp(Math.floor(y * this.pInvSpacing), 0, this.pNumY - 1);
      const cellNr = xi * n + yi;
      this.firstCellParticle[cellNr]--;
      this.cellParticleIds[this.firstCellParticle[cellNr]] = i;
    }

    const minDist = 2.0 * this.particleRadius;
    const minDistSq = minDist * minDist;

    for (let iter = 0; iter < numIters; iter++) {
      for (let i = 0; i < this.particleCount; i++) {
        const px = this.particlePos[2 * i];
        const py = this.particlePos[2 * i + 1];

        const pxi = Math.floor(px * this.pInvSpacing);
        const pyi = Math.floor(py * this.pInvSpacing);
        const x0 = Math.max(pxi - 1, 0);
        const y0 = Math.max(pyi - 1, 0);
        const x1 = Math.min(pxi + 1, this.pNumX - 1);
        const y1 = Math.min(pyi + 1, this.pNumY - 1);

        for (let xi = x0; xi <= x1; xi++) {
          for (let yi = y0; yi <= y1; yi++) {
            const cellNr = xi * n + yi;
            const cellFirst = this.firstCellParticle[cellNr];
            const cellLast = this.firstCellParticle[cellNr + 1];

            for (let j = cellFirst; j < cellLast; j++) {
              const id = this.cellParticleIds[j];
              if (id === i) continue;

              const qx = this.particlePos[2 * id];
              const qy = this.particlePos[2 * id + 1];

              let dx = qx - px;
              let dy = qy - py;
              const dSq = dx * dx + dy * dy;
              if (dSq > minDistSq || dSq === 0.0) continue;

              const d = Math.sqrt(dSq);
              const s = (0.5 * (minDist - d)) / d;
              dx *= s;
              dy *= s;

              // Symmetric push: momentum-neutral, so no net drift is added.
              this.particlePos[2 * i] -= dx;
              this.particlePos[2 * i + 1] -= dy;
              this.particlePos[2 * id] += dx;
              this.particlePos[2 * id + 1] += dy;
            }
          }
        }
      }
    }
  }

  /**
   * Keep particles out of the tank walls and out of the obstacle union.
   *
   * Obstacle response mirrors the original triangle code: snap the particle to
   * the nearest point on the boundary and zero its velocity (perfectly
   * inelastic), which is what stops the solver injecting energy at the surface.
   */
  handleParticleCollisions(): void {
    const h = 1.0 / this.fInvSpacing;
    const r = this.particleRadius;

    const minX = h + r;
    const maxX = (this.fNumX - 1) * h - r;
    const minY = h + r;
    const maxY = (this.fNumY - 1) * h - r;

    const ob = this.compiledObstacle;

    for (let i = 0; i < this.particleCount; i++) {
      let x = this.particlePos[2 * i];
      let y = this.particlePos[2 * i + 1];

      // Whole-obstacle box first: most particles fail here for the cost of
      // four compares, and never touch the polygon walk at all.
      if (
        ob !== null &&
        x >= ob.minX &&
        x <= ob.maxX &&
        y >= ob.minY &&
        y <= ob.maxY &&
        this.isInsideCompiledUnion(x, y, ob)
      ) {
        this.findNearestSurfacePoint(x, y, ob);
        x = this.nearestX;
        y = this.nearestY;
        this.particleVel[2 * i] = 0.0;
        this.particleVel[2 * i + 1] = 0.0;
      }

      if (x < minX) {
        x = minX;
        this.particleVel[2 * i] = 0.0;
      }
      if (x > maxX) {
        x = maxX;
        this.particleVel[2 * i] = 0.0;
      }
      if (y < minY) {
        y = minY;
        this.particleVel[2 * i + 1] = 0.0;
      }
      if (y > maxY) {
        y = maxY;
        this.particleVel[2 * i + 1] = 0.0;
      }

      this.particlePos[2 * i] = x;
      this.particlePos[2 * i + 1] = y;
    }
  }

  /**
   * Bilinearly splat particles onto cell centres to estimate local packing.
   *
   * The first call also latches the rest density (mean particles per fluid
   * cell), which is the reference the drift compensation pushes back towards.
   */
  updateParticleDensity(): void {
    const n = this.fNumY;
    const h = this.h;
    const h1 = this.fInvSpacing;
    const h2 = 0.5 * h;
    const d = this.particleDensity;

    d.fill(0.0);

    for (let i = 0; i < this.particleCount; i++) {
      let x = this.particlePos[2 * i];
      let y = this.particlePos[2 * i + 1];

      x = clamp(x, h, (this.fNumX - 1) * h);
      y = clamp(y, h, (this.fNumY - 1) * h);

      const x0 = Math.floor((x - h2) * h1);
      const tx = (x - h2 - x0 * h) * h1;
      const x1 = Math.min(x0 + 1, this.fNumX - 2);

      const y0 = Math.floor((y - h2) * h1);
      const ty = (y - h2 - y0 * h) * h1;
      const y1 = Math.min(y0 + 1, this.fNumY - 2);

      const sx = 1.0 - tx;
      const sy = 1.0 - ty;

      if (x0 < this.fNumX && y0 < this.fNumY) d[x0 * n + y0] += sx * sy;
      if (x1 < this.fNumX && y0 < this.fNumY) d[x1 * n + y0] += tx * sy;
      if (x1 < this.fNumX && y1 < this.fNumY) d[x1 * n + y1] += tx * ty;
      if (x0 < this.fNumX && y1 < this.fNumY) d[x0 * n + y1] += sx * ty;
    }

    if (this.restDensity === 0.0) {
      let sum = 0.0;
      let numFluidCells = 0;

      for (let i = 0; i < this.fNumCells; i++) {
        if (this.cellType[i] === FLUID_CELL) {
          sum += d[i];
          numFluidCells++;
        }
      }

      if (numFluidCells > 0) this.restDensity = sum / numFluidCells;
    }
  }

  /**
   * Particle ↔ grid velocity transfer on the staggered grid.
   *
   * `toGrid` (P2G): weighted-average particle velocities onto the u/v faces
   * and re-classify cells (solid where `s == 0`, fluid where a particle
   * landed, air otherwise). Face velocities adjacent to solids are restored
   * afterwards so walls keep their prescribed velocity.
   *
   * `!toGrid` (G2P): interpolate back, blending PIC and FLIP. PIC reads the
   * projected velocity directly — stable but heavily damped, because
   * interpolating twice per step is a low-pass filter. FLIP instead adds the
   * grid's *change* to the particle's existing velocity, preserving detail but
   * accumulating noise. `flipRatio` picks the trade-off (~0.9 keeps it lively).
   * Corner weights from cells with no fluid on either side of the face are
   * dropped, so particles never read stale air velocities.
   */
  transferVelocities(toGrid: boolean, flipRatio: number): void {
    const n = this.fNumY;
    const h = this.h;
    const h1 = this.fInvSpacing;
    const h2 = 0.5 * h;

    if (toGrid) {
      this.prevU.set(this.u);
      this.prevV.set(this.v);

      this.du.fill(0.0);
      this.dv.fill(0.0);
      this.u.fill(0.0);
      this.v.fill(0.0);

      for (let i = 0; i < this.fNumCells; i++) {
        this.cellType[i] = this.s[i] === 0.0 ? SOLID_CELL : AIR_CELL;
      }

      for (let i = 0; i < this.particleCount; i++) {
        const x = this.particlePos[2 * i];
        const y = this.particlePos[2 * i + 1];
        const xi = clamp(Math.floor(x * h1), 0, this.fNumX - 1);
        const yi = clamp(Math.floor(y * h1), 0, this.fNumY - 1);
        const cellNr = xi * n + yi;
        if (this.cellType[cellNr] === AIR_CELL) this.cellType[cellNr] = FLUID_CELL;
      }
    }

    for (let component = 0; component < 2; component++) {
      // u samples sit on vertical faces (offset half a cell in y), v on
      // horizontal faces (offset half a cell in x) — hence the swap.
      const dx = component === U_COMPONENT ? 0.0 : h2;
      const dy = component === U_COMPONENT ? h2 : 0.0;

      const fld = component === U_COMPONENT ? this.u : this.v;
      const prevFld = component === U_COMPONENT ? this.prevU : this.prevV;
      const weights = component === U_COMPONENT ? this.du : this.dv;

      for (let i = 0; i < this.particleCount; i++) {
        let x = this.particlePos[2 * i];
        let y = this.particlePos[2 * i + 1];

        x = clamp(x, h, (this.fNumX - 1) * h);
        y = clamp(y, h, (this.fNumY - 1) * h);

        const x0 = Math.min(Math.floor((x - dx) * h1), this.fNumX - 2);
        const tx = (x - dx - x0 * h) * h1;
        const x1 = Math.min(x0 + 1, this.fNumX - 2);

        const y0 = Math.min(Math.floor((y - dy) * h1), this.fNumY - 2);
        const ty = (y - dy - y0 * h) * h1;
        const y1 = Math.min(y0 + 1, this.fNumY - 2);

        const sx = 1.0 - tx;
        const sy = 1.0 - ty;

        const d0 = sx * sy;
        const d1 = tx * sy;
        const d2 = tx * ty;
        const d3 = sx * ty;

        const nr0 = x0 * n + y0;
        const nr1 = x1 * n + y0;
        const nr2 = x1 * n + y1;
        const nr3 = x0 * n + y1;

        if (toGrid) {
          const pv = this.particleVel[2 * i + component];
          fld[nr0] += pv * d0;
          weights[nr0] += d0;
          fld[nr1] += pv * d1;
          weights[nr1] += d1;
          fld[nr2] += pv * d2;
          weights[nr2] += d2;
          fld[nr3] += pv * d3;
          weights[nr3] += d3;
        } else {
          // A face is only meaningful if a cell on either side is non-air.
          const offset = component === U_COMPONENT ? n : 1;
          const valid0 =
            this.cellType[nr0] !== AIR_CELL || this.cellType[nr0 - offset] !== AIR_CELL ? 1.0 : 0.0;
          const valid1 =
            this.cellType[nr1] !== AIR_CELL || this.cellType[nr1 - offset] !== AIR_CELL ? 1.0 : 0.0;
          const valid2 =
            this.cellType[nr2] !== AIR_CELL || this.cellType[nr2 - offset] !== AIR_CELL ? 1.0 : 0.0;
          const valid3 =
            this.cellType[nr3] !== AIR_CELL || this.cellType[nr3 - offset] !== AIR_CELL ? 1.0 : 0.0;

          const vel = this.particleVel[2 * i + component];
          const weightSum = valid0 * d0 + valid1 * d1 + valid2 * d2 + valid3 * d3;

          if (weightSum > 0.0) {
            const picV =
              (valid0 * d0 * fld[nr0] +
                valid1 * d1 * fld[nr1] +
                valid2 * d2 * fld[nr2] +
                valid3 * d3 * fld[nr3]) /
              weightSum;
            const corr =
              (valid0 * d0 * (fld[nr0] - prevFld[nr0]) +
                valid1 * d1 * (fld[nr1] - prevFld[nr1]) +
                valid2 * d2 * (fld[nr2] - prevFld[nr2]) +
                valid3 * d3 * (fld[nr3] - prevFld[nr3])) /
              weightSum;
            const flipV = vel + corr;

            this.particleVel[2 * i + component] = (1.0 - flipRatio) * picV + flipRatio * flipV;
          }
        }
      }

      if (toGrid) {
        for (let i = 0; i < fld.length; i++) {
          if (weights[i] > 0.0) fld[i] /= weights[i];
        }

        // Restore solid faces: a wall's velocity is prescribed, not splatted.
        for (let i = 0; i < this.fNumX; i++) {
          for (let j = 0; j < this.fNumY; j++) {
            const solid = this.cellType[i * n + j] === SOLID_CELL;
            if (solid || (i > 0 && this.cellType[(i - 1) * n + j] === SOLID_CELL)) {
              this.u[i * n + j] = this.prevU[i * n + j];
            }
            if (solid || (j > 0 && this.cellType[i * n + j - 1] === SOLID_CELL)) {
              this.v[i * n + j] = this.prevV[i * n + j];
            }
          }
        }
      }
    }
  }

  /**
   * Pressure projection by Gauss-Seidel, in place.
   *
   * Each sweep redistributes a cell's divergence over its non-solid faces and
   * over-relaxes the correction (`overRelaxation` in (1, 2)) to converge in far
   * fewer sweeps than plain Jacobi.
   *
   * Drift compensation: FLIP conserves divergence, not volume, so particles
   * slowly bunch up. Subtracting the local over-packing
   * (`particleDensity - restDensity`) from the divergence makes the solve push
   * crowded cells apart. Only positive compression is corrected — pulling
   * sparse regions back together would collapse the free surface.
   */
  solveIncompressibility(
    numIters: number,
    dt: number,
    overRelaxation: number,
    compensateDrift = true,
  ): void {
    this.p.fill(0.0);
    // Snapshot for the FLIP delta computed in the following G2P transfer.
    this.prevU.set(this.u);
    this.prevV.set(this.v);

    const n = this.fNumY;
    const cp = (this.density * this.h) / dt;

    for (let iter = 0; iter < numIters; iter++) {
      for (let i = 1; i < this.fNumX - 1; i++) {
        for (let j = 1; j < this.fNumY - 1; j++) {
          if (this.cellType[i * n + j] !== FLUID_CELL) continue;

          const center = i * n + j;
          const left = (i - 1) * n + j;
          const right = (i + 1) * n + j;
          const bottom = i * n + j - 1;
          const top = i * n + j + 1;

          const sx0 = this.s[left];
          const sx1 = this.s[right];
          const sy0 = this.s[bottom];
          const sy1 = this.s[top];
          const sSum = sx0 + sx1 + sy0 + sy1;
          if (sSum === 0.0) continue;

          let div = this.u[right] - this.u[center] + this.v[top] - this.v[center];

          if (this.restDensity > 0.0 && compensateDrift) {
            const k = 1.0;
            const compression = this.particleDensity[center] - this.restDensity;
            if (compression > 0.0) div = div - k * compression;
          }

          let p = -div / sSum;
          p *= overRelaxation;
          this.p[center] += cp * p;

          this.u[center] -= sx0 * p;
          this.u[right] += sx1 * p;
          this.v[center] -= sy0 * p;
          this.v[top] += sy1 * p;
        }
      }
    }
  }

  /**
   * Per-cell greyscale ramp for renderers: solids read `0.5`, air `0`, and
   * fluid maps relative density through the original's four-band triangle
   * wave. Purely presentational — skip it if your renderer reads
   * {@link particleDensity} or {@link cellType} directly.
   */
  updateCellIntensity(): void {
    const out = this.cellIntensity;
    out.fill(0.0);

    for (let i = 0; i < this.fNumCells; i++) {
      if (this.cellType[i] === SOLID_CELL) {
        out[i] = 0.5;
      } else if (this.cellType[i] === FLUID_CELL) {
        let d = this.particleDensity[i];
        if (this.restDensity > 0.0) d /= this.restDensity;

        // Original setSciColor(val, 0, 2) with r == g == b in every branch:
        // normalise to [0, 1), split into 4 bands, alternate ramp direction.
        const val = clamp(d, 0.0, 2.0 - 0.0001) / 2.0;
        const band = Math.floor(val * 4);
        const frac = val * 4 - band;
        out[i] = band % 2 === 0 ? frac : 1.0 - frac;
      }
    }
  }

  /**
   * Advance the simulation one frame.
   *
   * Order matters: forces → separation → collisions → P2G → density → pressure
   * projection → G2P. Collisions run *before* the transfer so the grid never
   * sees a particle inside a wall, and the density estimate runs after cell
   * classification so drift compensation has fluid cells to measure.
   */
  simulate(params: SimulateParams): void {
    const numSubSteps = params.numSubSteps ?? 1;
    const sdt = params.dt / numSubSteps;
    const gravityX = params.gravityX ?? 0;

    this.setObstacle(params.obstacle);

    for (let step = 0; step < numSubSteps; step++) {
      this.integrateParticles(sdt, gravityX, params.gravity);
      if (params.separateParticles) this.pushParticlesApart(params.numParticleIters);
      this.handleParticleCollisions();
      this.transferVelocities(true, params.flipRatio);
      this.updateParticleDensity();
      this.solveIncompressibility(
        params.numPressureIters,
        sdt,
        params.overRelaxation,
        params.compensateDrift,
      );
      this.transferVelocities(false, params.flipRatio);
    }

    this.updateCellIntensity();
  }
}
