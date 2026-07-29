/**
 * The 3D device scene: a MacBook and an iPhone showing the product, driven by vanilla three.js.
 *
 * The model and its interaction design come from repalash's threepipe device mockup (MIT,
 * github.com/repalash/threepipe-device-mockup-codrops). threepipe itself is not used: it pins
 * `three` to a patched fork hosted outside npm, which cannot coexist with the `three` the hero
 * shader needs, and it does not tree-shake (~500 kB gzip regardless of plugins). The camera views
 * and poses its editor baked into the GLB are extracted into `scene-data.ts`, so this runtime only
 * needs plain glTF.
 *
 * Kept deliberately free of Angular so it can be reasoned about (and disposed) as one unit.
 */
import {
  ACESFilmicToneMapping,
  Box3,
  Color,
  DoubleSide,
  EquirectangularReflectionMapping,
  Group,
  Mesh,
  MeshPhysicalMaterial,
  type Object3D,
  PMREMGenerator,
  PerspectiveCamera,
  Quaternion,
  Raycaster,
  SRGBColorSpace,
  Scene,
  type Texture,
  TextureLoader,
  Vector2,
  Vector3,
  WebGLRenderer,
} from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

import { CAMERA_VIEWS, LID_POSES, PHONE_POSES, SCREENS, type Pose, type Vec3 } from './scene-data';

export type Focus = '' | 'macbook' | 'phone';

const MODEL_URL = '/models/devices.glb';
const DRACO_PATH = '/draco/';

/** Cubic ease — matches the settled feel of the reference's spring animations closely enough. */
const ease = (t: number): number => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

/**
 * The editor's camera views were framed for a full browser window. This section is a 16:9 panel, so
 * every view is pulled back along its own view axis to keep the devices inside the frame.
 */
const FRAMING = 1.34;

/**
 * Pulling the camera back alone leaves the devices sitting low, because the editor's targets aim
 * above them. Dropping the aim point re-centres the pair in the panel.
 */
const AIM_DROP = 0.72;

/** Push a camera position away from its target, preserving direction. */
function framed(position: Vec3, target: Vec3): [number, number, number] {
  return [
    target[0] + (position[0] - target[0]) * FRAMING,
    target[1] - AIM_DROP + (position[1] - target[1]) * FRAMING,
    target[2] + (position[2] - target[2]) * FRAMING,
  ];
}

/** The aim point, lowered to match. */
function aimed(target: Vec3): [number, number, number] {
  return [target[0], target[1] - AIM_DROP, target[2]];
}

interface Tween {
  readonly object: Object3D;
  readonly fromPos: Vector3;
  readonly toPos: Vector3;
  readonly fromQuat: Quaternion;
  readonly toQuat: Quaternion;
  readonly duration: number;
  elapsed: number;
}

export interface DeviceSceneOptions {
  readonly canvas: HTMLCanvasElement;
  readonly container: HTMLElement;
  /** Image mapped onto the MacBook screen. */
  readonly desktopScreen: string;
  /** Image mapped onto the phone screen. */
  readonly phoneScreen: string;
  /** Narrow viewports use the editor's alternate framings. */
  readonly isNarrow: () => boolean;
  readonly onFocusChange?: (focus: Focus) => void;
}

export class DeviceScene {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly raycaster = new Raycaster();
  private readonly pointer = new Vector2();

  private macbook?: Object3D;
  private phone?: Object3D;
  private lid?: Object3D;

  private readonly tweens: Tween[] = [];
  private camFrom = new Vector3();
  private camTo = new Vector3();
  private targetFrom = new Vector3();
  private targetTo = new Vector3();
  private camElapsed = 1;
  private camDuration = 0.6;
  private readonly lookAt = new Vector3();

  private focus: Focus = '';
  private hover: Focus = '';
  private running = false;
  private disposed = false;
  private last = 0;

  private readonly textures: Texture[] = [];

  constructor(private readonly options: DeviceSceneOptions) {
    this.renderer = new WebGLRenderer({ canvas: options.canvas, antialias: true, alpha: true });
    this.renderer.setPixelRatio(Math.min(globalThis.devicePixelRatio ?? 1, 2));
    this.renderer.toneMapping = ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = SRGBColorSpace;

    this.camera = new PerspectiveCamera(35, 1, 0.1, 200);
    this.scene.background = null;
  }

  /** Load the model, apply our screens, and settle into the opening framing. */
  async load(): Promise<void> {
    // A generated room environment avoids the reference's fetch of an HDR from threejs.org — one
    // less third-party request, and it lights brushed aluminium and glass convincingly.
    const pmrem = new PMREMGenerator(this.renderer);
    const env = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    env.mapping = EquirectangularReflectionMapping;
    this.scene.environment = env;
    pmrem.dispose();

    const draco = new DRACOLoader().setDecoderPath(DRACO_PATH);
    const loader = new GLTFLoader().setDRACOLoader(draco);

    const gltf = await loader.loadAsync(MODEL_URL);
    const root = gltf.scene as Group;
    this.scene.add(root);
    draco.dispose();

    this.macbook = root.getObjectByName('macbook') ?? undefined;
    this.phone = root.getObjectByName('iphone') ?? undefined;
    this.lid = root.getObjectByName('Bevels_2') ?? undefined;

    await this.applyScreens(root);

    // Opening pose, applied instantly.
    if (this.lid) applyPose(this.lid, LID_POSES.closed);
    if (this.phone) applyPose(this.phone, PHONE_POSES.facedown);
    this.jumpToView(this.viewName('start'));
  }

  /**
   * Replace the two baked screen textures with our product UI.
   *
   * The materials differ and must be treated differently: the MacBook screen only has a base-colour
   * map and no emissive at all, so it needs the colour forced black and emission turned on, or the
   * screen renders as a dim reflection. The phone screen already ships an emissive setup, so
   * assigning the map is enough.
   */
  private async applyScreens(root: Object3D): Promise<void> {
    const loader = new TextureLoader();
    const load = async (url: string): Promise<Texture> => {
      const t = await loader.loadAsync(url);
      t.colorSpace = SRGBColorSpace;
      // The UVs overshoot [0,1] slightly and the file's sampler repeats, which would wrap a sliver
      // of the opposite edge into a visible seam.
      t.wrapS = t.wrapT = 1001; // ClampToEdgeWrapping
      t.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
      t.flipY = true; // correct here: the baked textures are stored pre-flipped
      t.needsUpdate = true;
      this.textures.push(t);
      return t;
    };

    const [desktop, phone] = await Promise.all([
      load(this.options.desktopScreen),
      load(this.options.phoneScreen),
    ]);

    const macScreen = root.getObjectByName(SCREENS.macbook.node);
    if (macScreen instanceof Mesh) {
      const m = macScreen.material as MeshPhysicalMaterial;
      m.color = new Color(0, 0, 0);
      m.emissive = new Color(1, 1, 1);
      m.emissiveIntensity = 1;
      m.map = null;
      m.emissiveMap = desktop;
      m.roughness = 0.22;
      m.metalness = 0.75;
      m.side = DoubleSide;
      m.needsUpdate = true;
    }

    const phoneScreen = root.getObjectByName(SCREENS.phone.node);
    if (phoneScreen instanceof Mesh) {
      const m = phoneScreen.material as MeshPhysicalMaterial;
      m.emissiveMap = phone;
      m.emissive = new Color(1, 1, 1);
      m.emissiveIntensity = 1;
      m.needsUpdate = true;
    }
  }

  // ---- framing ---------------------------------------------------------------------------------

  private viewName(base: 'start' | 'front' | 'macbook' | 'iphone'): keyof typeof CAMERA_VIEWS {
    const narrow = this.options.isNarrow();
    const key = (narrow ? `${base}2` : base) as keyof typeof CAMERA_VIEWS;
    return key in CAMERA_VIEWS ? key : base;
  }

  private jumpToView(name: keyof typeof CAMERA_VIEWS): void {
    const v = CAMERA_VIEWS[name];
    this.camera.position.set(...framed(v.position, v.target));
    this.lookAt.set(...aimed(v.target));
    this.camera.lookAt(this.lookAt);
    this.camElapsed = 1;
  }

  private animateToView(name: keyof typeof CAMERA_VIEWS, duration = 0.6): void {
    const v = CAMERA_VIEWS[name];
    this.camFrom.copy(this.camera.position);
    this.camTo.set(...framed(v.position, v.target));
    this.targetFrom.copy(this.lookAt);
    this.targetTo.set(...aimed(v.target));
    this.camElapsed = 0;
    this.camDuration = duration;
  }

  private tweenTo(object: Object3D | undefined, pose: Pose, duration: number): void {
    if (!object) return;
    // Drop any in-flight tween for this object so poses never fight each other.
    for (let i = this.tweens.length - 1; i >= 0; i--) {
      if (this.tweens[i].object === object) this.tweens.splice(i, 1);
    }
    this.tweens.push({
      object,
      fromPos: object.position.clone(),
      toPos: new Vector3(...(pose.position as unknown as [number, number, number])),
      fromQuat: object.quaternion.clone(),
      toQuat: new Quaternion(...(pose.quaternion as unknown as [number, number, number, number])),
      duration,
      elapsed: 0,
    });
  }

  // ---- interaction -----------------------------------------------------------------------------

  /** Which device (if any) an object belongs to. Checks self first — ancestors alone miss a direct hit. */
  private deviceOf(object: Object3D | null): Focus {
    let node: Object3D | null = object;
    while (node) {
      if (node === this.macbook) return 'macbook';
      if (node === this.phone) return 'phone';
      node = node.parent;
    }
    return '';
  }

  private pick(clientX: number, clientY: number): Focus {
    const rect = this.options.container.getBoundingClientRect();
    this.pointer.set(
      ((clientX - rect.left) / rect.width) * 2 - 1,
      -((clientY - rect.top) / rect.height) * 2 + 1,
    );
    this.raycaster.setFromCamera(this.pointer, this.camera);
    const hit = this.raycaster.intersectObjects(this.scene.children, true)[0];
    return this.deviceOf(hit?.object ?? null);
  }

  onPointerMove(clientX: number, clientY: number): void {
    if (this.focus) return; // while focused, hover is meaningless
    const device = this.pick(clientX, clientY);
    if (device === this.hover) return;
    this.hover = device;
    this.tweenTo(this.lid, device === 'macbook' ? LID_POSES.hover : LID_POSES.closed, 0.28);
    this.tweenTo(this.phone, device === 'phone' ? PHONE_POSES.tilted : PHONE_POSES.facedown, 0.28);
  }

  onPointerLeave(): void {
    if (this.focus) return;
    this.hover = '';
    this.tweenTo(this.lid, LID_POSES.closed, 0.28);
    this.tweenTo(this.phone, PHONE_POSES.facedown, 0.28);
  }

  onClick(clientX: number, clientY: number): void {
    const device = this.pick(clientX, clientY);
    this.setFocus(device === this.focus ? '' : device);
  }

  setFocus(next: Focus): void {
    this.focus = next;
    this.hover = '';
    if (next === 'macbook') {
      this.tweenTo(this.lid, LID_POSES.open, 0.55);
      this.tweenTo(this.phone, PHONE_POSES.facedown, 0.55);
      this.animateToView(this.viewName('macbook'), 0.7);
    } else if (next === 'phone') {
      this.tweenTo(this.lid, LID_POSES.closed, 0.55);
      this.tweenTo(this.phone, PHONE_POSES.floating, 0.55);
      this.animateToView(this.viewName('iphone'), 0.7);
    } else {
      this.tweenTo(this.lid, LID_POSES.closed, 0.45);
      this.tweenTo(this.phone, PHONE_POSES.facedown, 0.45);
      this.animateToView(this.viewName('front'), 0.6);
    }
    this.options.onFocusChange?.(next);
  }

  get currentFocus(): Focus {
    return this.focus;
  }

  // ---- loop ------------------------------------------------------------------------------------

  resize(): void {
    const { clientWidth: w, clientHeight: h } = this.options.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  start(): void {
    if (this.running || this.disposed) return;
    this.running = true;
    this.last = performance.now();
    this.renderer.setAnimationLoop((now) => this.frame(now));
  }

  stop(): void {
    this.running = false;
    this.renderer.setAnimationLoop(null);
  }

  private frame(now: number): void {
    const dt = Math.min((now - this.last) / 1000, 0.05);
    this.last = now;

    for (let i = this.tweens.length - 1; i >= 0; i--) {
      const t = this.tweens[i];
      t.elapsed += dt;
      const k = ease(Math.min(t.elapsed / t.duration, 1));
      t.object.position.lerpVectors(t.fromPos, t.toPos, k);
      t.object.quaternion.slerpQuaternions(t.fromQuat, t.toQuat, k);
      if (t.elapsed >= t.duration) this.tweens.splice(i, 1);
    }

    if (this.camElapsed < 1) {
      this.camElapsed = Math.min(this.camElapsed + dt / this.camDuration, 1);
      const k = ease(this.camElapsed);
      this.camera.position.lerpVectors(this.camFrom, this.camTo, k);
      this.lookAt.lerpVectors(this.targetFrom, this.targetTo, k);
      this.camera.lookAt(this.lookAt);
    }

    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    this.stop();
    this.disposed = true;
    for (const t of this.textures) t.dispose();
    this.scene.traverse((o) => {
      if (!(o instanceof Mesh)) return;
      o.geometry?.dispose();
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      for (const m of mats) m?.dispose();
    });
    this.scene.environment?.dispose();
    // dispose() alone leaves the WebGL context alive; repeated route changes would exhaust the
    // browser's context limit without this.
    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }
}

function applyPose(object: Object3D, pose: Pose): void {
  object.position.set(...(pose.position as unknown as [number, number, number]));
  object.quaternion.set(...(pose.quaternion as unknown as [number, number, number, number]));
  object.scale.set(...(pose.scale as unknown as Vec3 as [number, number, number]));
}

/** Bounding box helper, exported for debugging framing issues. */
export function boundsOf(object: Object3D): Box3 {
  return new Box3().setFromObject(object);
}
