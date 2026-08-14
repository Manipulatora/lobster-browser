import {
  Box3,
  type BufferGeometry,
  Euler,
  InstancedBufferAttribute,
  InstancedBufferGeometry,
  Quaternion,
} from 'three';

/**
 * Helix layout math — adapted verbatim from Sujen Phea's WebGL Xylophone (MIT). Pure and
 * allocation-free by construction, so it needed no changes to embed here.
 */

export interface HelixConfig {
  count: number;
  radius: number;
  tiltFalloff: number;
  thetaStep: number;
  thetaOffset: number;
}

export interface InstanceTransforms {
  positions: Float32Array; // count * 3
  rotations: Float32Array; // count * 4
  tintOffsets: Float32Array; // count
}

export interface BuiltGeometry {
  geometry: InstancedBufferGeometry;
  localBox: Box3;
  aStrikeTime: InstancedBufferAttribute;
  transforms: InstanceTransforms;
}

function wrap(a: number, n: number): number {
  return ((a % n) + n) % n;
}

/**
 * Writes the helix pose for every bar at a given scroll `phase`.
 *
 * The bars ride a conveyor: advancing the phase slides each one along the helix and wraps it
 * back to the bottom, so a finite `count` reads as an endless column. Writes in place into the
 * instance buffers, and borrows the caller's Euler/Quaternion, so it allocates nothing and is
 * safe to call every frame.
 */
export function writeHelixTransforms(
  phase: number,
  geometryHeight: number,
  cfg: HelixConfig,
  positions: Float32Array,
  rotations: Float32Array,
  e: Euler,
  q: Quaternion,
): void {
  const tiltX = Math.atan2(geometryHeight, cfg.radius * cfg.tiltFalloff);
  const halfHeight = ((cfg.count - 1) * geometryHeight) / 2;

  for (let i = 0; i < cfg.count; i++) {
    const s = wrap(i + phase, cfg.count);
    const theta = s * cfg.thetaStep + cfg.thetaOffset;

    positions[i * 3] = cfg.radius * Math.cos(theta);
    positions[i * 3 + 1] = s * geometryHeight - halfHeight;
    positions[i * 3 + 2] = cfg.radius * Math.sin(theta);

    e.set(tiltX, -theta, 0);
    q.setFromEuler(e);
    rotations[i * 4] = q.x;
    rotations[i * 4 + 1] = q.y;
    rotations[i * 4 + 2] = q.z;
    rotations[i * 4 + 3] = q.w;
  }
}

export function buildInstanceTransforms(
  geometryHeight: number,
  cfg: HelixConfig,
): InstanceTransforms {
  const positions = new Float32Array(cfg.count * 3);
  const rotations = new Float32Array(cfg.count * 4);
  const tintOffsets = new Float32Array(cfg.count);

  // rest layout is just the conveyor at phase 0
  writeHelixTransforms(
    0,
    geometryHeight,
    cfg,
    positions,
    rotations,
    new Euler(0, 0, 0, 'YXZ'),
    new Quaternion(),
  );

  for (let i = 0; i < cfg.count; i++) {
    tintOffsets[i] = i / cfg.count;
  }

  return { positions, rotations, tintOffsets };
}

/** Wraps one loaded bar mesh into an instanced geometry, one instance per helix slot. */
export function buildInstancedGeometry(model: BufferGeometry, cfg: HelixConfig): BuiltGeometry {
  model.computeBoundingBox();
  const bbox = model.boundingBox!;
  const height = bbox.max.y - bbox.min.y;
  const transforms = buildInstanceTransforms(height, cfg);

  const geometry = new InstancedBufferGeometry();
  geometry.index = model.index;
  geometry.setAttribute('position', model.getAttribute('position'));
  geometry.setAttribute('normal', model.getAttribute('normal'));
  geometry.setAttribute('uv', model.getAttribute('uv'));
  geometry.setAttribute('aPos', new InstancedBufferAttribute(transforms.positions, 3));
  geometry.setAttribute('aRot', new InstancedBufferAttribute(transforms.rotations, 4));
  geometry.setAttribute('aTintOffset', new InstancedBufferAttribute(transforms.tintOffsets, 1));

  // -1e9 = never struck; the shader's decay envelope collapses to 0 at that age
  const aStrikeTime = new InstancedBufferAttribute(new Float32Array(cfg.count).fill(-1e9), 1);
  geometry.setAttribute('aStrikeTime', aStrikeTime);

  return { geometry, localBox: bbox.clone(), aStrikeTime, transforms };
}
