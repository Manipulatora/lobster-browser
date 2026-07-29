/**
 * Baked scene data extracted from tabletop_macbook_iphone.glb.
 *
 * The model was authored in the threepipe editor, which stores camera views in a
 * `WEBGI_viewer` scene extension and per-object poses in `node.extras`. Nothing in a vanilla
 * three.js runtime understands those, and the texture compressor strips unknown extensions anyway —
 * so the values are lifted out once, here, and the GLB is treated as pure geometry.
 *
 * Generated from the original model; see scripts/extract-glb.mjs in the scratchpad.
 */

export type Vec3 = readonly [number, number, number];
export type Quat = readonly [number, number, number, number];

export interface CameraView {
  readonly position: Vec3;
  readonly target: Vec3;
  readonly zoom: number;
}

export interface Pose {
  readonly position: Vec3;
  readonly quaternion: Quat;
  readonly scale: Vec3;
}

/** Framings authored in the editor. The `2` suffixed variants are the narrow-viewport framings. */
export const CAMERA_VIEWS = {
  start: {
    position: [7.859022, 2.543692, -9.430786],
    target: [2.055542, 1.384659, 0.640738],
    zoom: 1,
  },
  macbook: {
    position: [3.030505, 4.096014, -6.178642],
    target: [3.000799, 2.780082, 0.829057],
    zoom: 1.2,
  },
  iphone: {
    position: [-2.8, 2.375353, -4.44048],
    target: [-2.921108, 2.475353, -1.564275],
    zoom: 1,
  },
  front: {
    position: [2.052691, 3.712068, -11.445614],
    target: [1.869058, 1.087185, 0.518122],
    zoom: 1,
  },
  start2: {
    position: [7.859022, 2.543692, -9.430786],
    target: [2.055542, 1.384659, 0.640738],
    zoom: 0.45,
  },
  macbook2: {
    position: [3.030505, 4.096014, -6.178642],
    target: [3.000799, 2.780082, 0.829057],
    zoom: 0.45,
  },
  iphone2: {
    position: [-2.8, 2.375353, -4.44048],
    target: [-2.921108, 2.475353, -1.564275],
    zoom: 1,
  },
  front2: {
    position: [2.052691, 3.712068, -11.445614],
    target: [1.869058, 1.087185, 0.518122],
    zoom: 0.45,
  },
} as const satisfies Record<string, CameraView>;

export type CameraViewName = keyof typeof CAMERA_VIEWS;

/** The MacBook lid (node `Bevels_2`) — its hinge poses. */
export const LID_POSES = {
  closed: {
    position: [-0.00012, 0.008243, -0.104007],
    quaternion: [0.0, 0.0, 0.0, 1.0],
    scale: [0.274709, 0.274709, 0.274709],
  },
  hover: {
    position: [-0.00012, 0.008243, -0.104007],
    quaternion: [-0.034993, 0.0, 0.0, 0.999388],
    scale: [0.274709, 0.274709, 0.274709],
  },
  open: {
    position: [-0.00012, 0.008243, -0.104007],
    quaternion: [-0.783327, 0.0, 0.0, 0.62161],
    scale: [0.274709, 0.274709, 0.274709],
  },
} as const satisfies Record<string, Pose>;

/** The iPhone (node `iphone`) — its resting and raised poses. */
export const PHONE_POSES = {
  floating: {
    position: [-3.0, 2.5, -0.000001],
    quaternion: [0.0, 0.0, 0.0, 1.0],
    scale: [22.485963, 22.485963, 22.485963],
  },
  faceup: {
    position: [-3.0, 0.0, -0.000001],
    quaternion: [0.706825, 0.0, 0.0, 0.707388],
    scale: [22.485963, 22.485963, 22.485963],
  },
  facedown: {
    position: [-3.0, 0.0, -0.000001],
    quaternion: [0.000563, 0.707388, 0.706825, 0.000563],
    scale: [22.485963, 22.485963, 22.485963],
  },
  tilted: {
    position: [-3.0, 0.13, -0.000001],
    quaternion: [-0.053004, 0.704838, 0.7054, -0.052962],
    scale: [22.485963, 22.485963, 22.485963],
  },
} as const satisfies Record<string, Pose>;

/** Node names of the two screen meshes, and the materials they carry. */
export const SCREENS = {
  macbook: { node: 'Object_7', material: 'Material.002_0_1' },
  phone: { node: 'xXDHkMplTIDAXLN', material: 'pIJKfZsazmcpEiU_0_1' },
} as const;
