/**
 * The lobster silhouette that the fluid flows around.
 *
 * Geometry is authored in normalised 0..1 space with the origin at the TOP-LEFT and y pointing DOWN
 * (how the shape was drawn), then converted once into simulation space, which is y-UP. Keeping the
 * authored form untouched means the artwork can be re-exported without worrying about the physics
 * convention.
 */

/** A closed loop of points; the first point is not repeated at the end. */
export type Polygon = readonly (readonly [number, number])[];

/** A filled shape is the UNION of its polygons (they may overlap). */
export type Shape = readonly Polygon[];

export interface ShapeSource {
  readonly name: string;
  readonly notes: string;
  readonly polygons: Shape;
}

/**
 * Fit a normalised shape into simulation space.
 *
 * @param source   artwork in 0..1, y-down
 * @param size     the side length of the square the lobster should occupy, in simulation units
 * @param cx,cy    where to centre it, in simulation units (y-up)
 */
export function toSimulationSpace(
  source: ShapeSource,
  size: number,
  cx: number,
  cy: number,
): (readonly (readonly [number, number])[])[] {
  const half = size / 2;
  return source.polygons.map((poly) =>
    poly.map(([x, y]): readonly [number, number] => [
      cx + (x - 0.5) * size,
      // Flip Y: authored top-down, simulated bottom-up.
      cy + (0.5 - y) * size,
    ]),
  );
}

/**
 * Is a point inside the UNION of the polygons?
 *
 * Tested per polygon (not as one even-odd sweep) so overlapping polygons union instead of
 * cancelling — the lobster's claws and legs deliberately overlap the body.
 *
 * Used when seeding particles: spawning inside the obstacle would make the first frame explode as
 * the collision pass ejects them all at once.
 */
export function isInsideShape(
  polygons: readonly (readonly (readonly [number, number])[])[],
  px: number,
  py: number,
): boolean {
  for (const poly of polygons) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    if (inside) return true;
  }
  return false;
}

/** Axis-aligned bounds of a shape in its authored space — used for sanity checks and centring. */
export function bounds(shape: Shape): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const poly of shape) {
    for (const [x, y] of poly) {
      if (x < minX) minX = x;
      if (y < minY) minY = y;
      if (x > maxX) maxX = x;
      if (y > maxY) maxY = y;
    }
  }
  return { minX, minY, maxX, maxY };
}
