import { Box3, Matrix4, Quaternion, Ray, Vector3 } from 'three';

/**
 * GPU-instance hit testing — adapted verbatim from Sujen Phea's WebGL Xylophone (MIT). Pure and
 * allocation-free by construction, so it needed no changes to embed here.
 */

/** The two instance buffers the picker needs — the live pose written by `writeHelixTransforms`. */
export interface InstanceAttributes {
  aPos: Float32Array;
  aRot: Float32Array;
}

export function createHitWorkspace() {
  return {
    spin: new Quaternion(),
    aRotQ: new Quaternion(),
    rotQ: new Quaternion(),
    pos: new Vector3(),
    scale: new Vector3(1, 1, 1),
    mat: new Matrix4(),
    inv: new Matrix4(),
    ray: new Ray(),
    hit: new Vector3(),
  };
}

export type HitWorkspace = ReturnType<typeof createHitWorkspace>;

/**
 * Nearest bar under `worldRay`, or -1.
 *
 * The bars only exist on the GPU (one instanced draw), so there is nothing for three's raycaster
 * to walk. Instead we rebuild each instance's world matrix on the CPU, push the ray into that
 * instance's local space, and test it against the shared bar bounding box — one box test per
 * bar, no per-triangle work.
 *
 * The idle spin is reconstructed here from `time`/`spinSpeed`; it must stay in step with
 * xylophoneVert.glsl, which derives the same half-angle from the same two uniforms. The strike
 * swing is deliberately *not* modelled — it decays in a few hundred ms, and picking a bar that
 * is still ringing should hit where it rests, not where it currently is.
 */
export function hitBarIndex(
  worldRay: Ray,
  instances: InstanceAttributes,
  localBox: Box3,
  groupMatrixWorld: Matrix4,
  time: number,
  spinSpeed: number,
  work: HitWorkspace,
): number {
  const { aPos, aRot } = instances;
  const count = aPos.length / 3;

  // mirrors the idle spin in xylophoneVert.glsl: half-angle = time * spinSpeed * 0.5
  const half = time * spinSpeed * 0.5;
  work.spin.set(0, Math.sin(half), 0, Math.cos(half));

  let hitIndex = -1;
  let hitDist = Infinity;

  for (let i = 0; i < count; i++) {
    work.aRotQ.set(aRot[i * 4]!, aRot[i * 4 + 1]!, aRot[i * 4 + 2]!, aRot[i * 4 + 3]!);
    work.rotQ.multiplyQuaternions(work.spin, work.aRotQ);
    work.pos.set(aPos[i * 3]!, aPos[i * 3 + 1]!, aPos[i * 3 + 2]!);

    work.mat.compose(work.pos, work.rotQ, work.scale);
    work.mat.premultiply(groupMatrixWorld);
    work.inv.copy(work.mat).invert();

    work.ray.copy(worldRay).applyMatrix4(work.inv);
    const pt = work.ray.intersectBox(localBox, work.hit);
    if (pt) {
      const dist = work.ray.origin.distanceTo(pt);
      if (dist < hitDist) {
        hitDist = dist;
        hitIndex = i;
      }
    }
  }

  return hitIndex;
}
