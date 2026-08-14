import { GaussianBlurPass } from 'postprocessing';
import {
  type BufferGeometry,
  CanvasTexture,
  ClampToEdgeWrapping,
  DoubleSide,
  Euler,
  Group,
  LinearFilter,
  MathUtils,
  Mesh,
  NoToneMapping,
  PerspectiveCamera,
  PlaneGeometry,
  Quaternion,
  Raycaster,
  Scene,
  ShaderMaterial,
  SRGBColorSpace,
  type Texture,
  UnsignedByteType,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

import { FboHelper } from './fbo-helper';
import { FluidSim } from './fluid-sim';
import { buildInstancedGeometry, writeHelixTransforms, type BuiltGeometry } from './helix';
import { createHitWorkspace, hitBarIndex, type InstanceAttributes } from './picking';
import { xylophoneBgFrag, xylophoneBgVert } from './shaders/xylophone-bg.glsl';
import { xylophoneFrag, xylophoneVert } from './shaders/xylophone.glsl';

/**
 * A frosted-glass instanced helix that reacts to hover — adapted from Sujen Phea's WebGL
 * Xylophone (MIT), https://github.com/Sujenphea/xylophone (article on Codrops). This engine
 * keeps the source's core visual identity (the instanced glass bars, the fresnel/iridescent
 * shader, the frosted backdrop transmission, the fluid hover-wake tint, and GPU-instance picking
 * for the strike swing) and re-scopes everything the source assumed about owning the whole page.
 * The source's Web Audio sampler is dropped entirely — this port is silent by design, so hovering
 * a bar plays only the visual "strike" swing, never a note.
 *
 * - **Container-scoped, not viewport-scoped.** The source's canvas is `position: fixed`,
 *   full-viewport, driven by `window.innerWidth/innerHeight`. This engine is sized to a single
 *   host element, so it can sit inside the hero's layout instead of behind the entire page.
 * - **Autoplay conveyor, not scroll-jacked.** The source advances the helix's vertical "conveyor"
 *   phase from the page's wheel/touch-drag input — appropriate for a full-page demo, wrong for a
 *   hero embedded beside ordinary scrolling content, since capturing wheel there would fight the
 *   visitor's scroll. The conveyor phase instead advances on a slow constant timer, gated by
 *   `prefers-reduced-motion` exactly like the idle spin and strike swing already were upstream.
 * - **No global singletons.** The source keeps renderer/clock/composer state in static classes
 *   (`Properties`, `RAFCollection`, `Input`) that assume exactly one instance for the whole page.
 *   Everything here is instance state, so the component can mount, unmount, and remount (Angular
 *   does this on route re-entry) without two copies fighting over one set of globals.
 * - **No SSAO / SMAA / EffectComposer.** The source's contact-shadow pass re-renders the bars into
 *   a view-space normal buffer for `SSAOEffect`, then composites through `EffectComposer` with an
 *   SMAA antialiasing pass. That is a lot of machinery for a subtle self-shadow between
 *   overlapping bars; this port renders directly (`renderer.render(scene, camera)`, MSAA from the
 *   renderer's own `antialias: true`) and keeps only the one compositing step that is load-bearing
 *   for the look: blurring the background into the backdrop the glass transmits.
 */

/* -------------------------------------------------------------------------- */
/*                                   config                                   */
/* -------------------------------------------------------------------------- */
const GLASS_LAYER = 1;
const BG_LAYER = 2;

export const XYLOPHONE_CONFIG = {
  count: 64,
  radius: 1,
  tiltFalloff: 2,
  thetaStep: 0.175,
  thetaOffset: Math.PI,
  spinSpeed: 0.3,
  tintWrap: 10,
  // offsetX biases the helix toward the right of the frame: the canvas is now the whole hero
  // section (full-bleed, see xylophone-hero.ts), which is much wider than the square card it used
  // to fill, and the copy sits at the section's left edge — without this the helix renders dead
  // center and drapes directly across the text.
  group: { scale: 0.62, rotXDeg: 22, rotZDeg: 28, offsetX: 2.3 },
  /** Bars advanced per second along the conveyor — slow enough to read as ambient, not scrolling. */
  autoAdvanceSpeed: 0.12,
} as const;

const FLUID_CONFIG = {
  simRes: 128,
  curlStrength: 0.2,
  splatRadius: 0.6,
  splatForce: 20,
  pressureIterations: 1,
  velocityDissipation: 0.93,
  pressureDissipation: 0.97,
} as const;

const FROST_MAX_BLUR_PX = 48;
const FROST_STRENGTH = 0.9; // 0..1, scaled to the gaussian kernel below

/** Clamp long frames (tab restore, dev-tools pause) so nothing integrates a huge step. */
const MAX_DELTA = 1 / 20;

export interface XylophoneAssetUrls {
  modelUrl: string;
}

/** 1px-tall spectrum ramp the bars sample for their hover tint. */
function buildGradientTexture(): Texture {
  const width = 256;
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = 1;

  const ctx = canvas.getContext('2d')!;
  const grad = ctx.createLinearGradient(0, 0, width, 0);
  grad.addColorStop(0.0, '#ff0033');
  grad.addColorStop(0.3, '#ff00d4');
  grad.addColorStop(0.5, '#6a00ff');
  grad.addColorStop(0.8, '#0090ff');
  grad.addColorStop(1.0, '#00ffe1');
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, width, 1);

  const tex = new CanvasTexture(canvas);
  tex.colorSpace = SRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.wrapS = ClampToEdgeWrapping;
  tex.wrapT = ClampToEdgeWrapping;

  return tex;
}

export class XylophoneEngine {
  private readonly renderer: WebGLRenderer;
  private readonly scene = new Scene();
  private readonly camera: PerspectiveCamera;
  private readonly group = new Group();

  private readonly fboHelper: FboHelper;
  private readonly fluid: FluidSim;

  // background quad (also the frosted transmission source). This violet wash IS the hero
  // section's own background now — the canvas spans the full section (see xylophone-hero.ts's
  // host sizing and hero-section.html), so there is no separate colored box to distinguish it
  // from: the theme and the section are the same surface.
  private readonly bgUniforms = { u_color: { value: new Vector3(0.639, 0.569, 0.827) } };
  private readonly bgMaterial: ShaderMaterial;
  private readonly bgMesh: Mesh;

  // backdrop blur (bg -> sharp target -> gaussian-blurred target, sampled by the glass shader)
  private readonly backdropTarget: WebGLRenderTarget;
  private readonly blurredBackdropTarget: WebGLRenderTarget;
  private readonly blurPass: GaussianBlurPass;
  private blurInitialized = false;

  // bars
  readonly uniforms = {
    u_time: { value: 0 },
    u_spinSpeed: { value: 0 }, // set for real once `reduceMotion` is known
    u_swingScale: { value: 0 },
    u_swingAxis: { value: new Vector3(0, 1, 0) },
    u_tFluid: { value: null as Texture | null },
    u_tGradient: { value: null as Texture | null },
    u_fluidStrength: { value: 1.0 },
    u_tintStrength: { value: 1.0 },
    u_tintGlow: { value: 0.15 },
    u_tintWrap: { value: XYLOPHONE_CONFIG.tintWrap },
    u_tBackdrop: { value: null as Texture | null },
    u_transmission: { value: 0.84 },
    u_refractStrength: { value: 0.2 },
    u_fresnelPower: { value: 3.0 },
    u_iridStrength: { value: 0.6 },
    u_iridCycles: { value: 3.0 },
    u_iridShift: { value: 0.0 },
    u_iridPower: { value: 2.5 },
    u_iridBody: { value: 0.12 },
  };

  private mesh?: Mesh;
  private material?: ShaderMaterial;
  private instances?: BuiltGeometry;
  private hitInstances?: InstanceAttributes;
  private geometryHeight = 1;

  private readonly reduceMotion: boolean;
  private time = 0;
  private phase = 0;
  private phaseWritten = 0;
  private lastHitIndex = -1;
  private readonly raycaster = new Raycaster();
  private readonly hitWorkspace = createHitWorkspace();
  private readonly scrollEuler = new Euler(0, 0, 0, 'YXZ');
  private readonly scrollQuat = new Quaternion();

  // pointer — NDC for raycasting, 0..1 (y-up from bottom) for the fluid sim
  private pointerNdc = new Vector2(0, 0);
  private pointerScreen01 = new Vector2(0.5, 0.5);
  private hasPointer = false;

  private width = 1;
  private height = 1;
  private disposed = false;
  private contextLost = false;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    width: number,
    height: number,
    reduceMotion: boolean,
  ) {
    this.reduceMotion = reduceMotion;
    this.width = Math.max(1, width);
    this.height = Math.max(1, height);

    this.renderer = new WebGLRenderer({
      canvas,
      alpha: false,
      antialias: true,
      powerPreference: 'high-performance',
      premultipliedAlpha: false,
    });
    this.renderer.outputColorSpace = SRGBColorSpace;
    this.renderer.toneMapping = NoToneMapping;
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    this.renderer.setSize(this.width, this.height, false);

    canvas.addEventListener('webglcontextlost', (event) => {
      event.preventDefault();
      this.contextLost = true;
    });
    canvas.addEventListener('webglcontextrestored', () => {
      this.contextLost = false;
    });

    this.camera = new PerspectiveCamera(45, this.width / this.height, 0.1, 200);
    this.camera.position.set(0, 0, 5);

    this.fboHelper = new FboHelper(this.renderer);
    this.fluid = new FluidSim(this.renderer, this.fboHelper, FLUID_CONFIG);

    // background
    this.bgMaterial = new ShaderMaterial({
      uniforms: this.bgUniforms,
      vertexShader: xylophoneBgVert,
      fragmentShader: xylophoneBgFrag,
      side: DoubleSide,
      depthTest: false,
      depthWrite: false,
    });
    this.bgMesh = new Mesh(new PlaneGeometry(2, 2), this.bgMaterial);
    this.bgMesh.renderOrder = -1;
    this.bgMesh.frustumCulled = false; // clip-space quad has no meaningful bounds
    this.bgMesh.layers.enable(BG_LAYER); // isolated for the backdrop blur render below
    this.scene.add(this.bgMesh);

    // backdrop blur targets
    const targetOptions = {
      minFilter: LinearFilter,
      magFilter: LinearFilter,
      depthBuffer: false,
      stencilBuffer: false,
      colorSpace: SRGBColorSpace,
    };
    this.backdropTarget = new WebGLRenderTarget(1, 1, targetOptions);
    this.blurredBackdropTarget = new WebGLRenderTarget(1, 1, targetOptions);
    this.uniforms.u_tBackdrop.value = this.blurredBackdropTarget.texture;
    this.blurPass = new GaussianBlurPass({ kernelSize: 35, iterations: 3, resolutionScale: 0.25 });
    (this.blurPass as unknown as { blurMaterial: { scale: number } }).blurMaterial.scale =
      (FROST_STRENGTH * FROST_MAX_BLUR_PX) / FROST_MAX_BLUR_PX;

    this.group.scale.setScalar(XYLOPHONE_CONFIG.group.scale);
    this.group.position.x = XYLOPHONE_CONFIG.group.offsetX;
    this.group.rotation.set(
      MathUtils.degToRad(XYLOPHONE_CONFIG.group.rotXDeg),
      0,
      MathUtils.degToRad(XYLOPHONE_CONFIG.group.rotZDeg),
    );
    this.group.updateMatrixWorld();
    this.group.layers.enable(GLASS_LAYER);
    this.scene.add(this.group);

    this.resize(this.width, this.height);
  }

  /* ---------------------------------- load ---------------------------------- */
  async load(assets: XylophoneAssetUrls): Promise<void> {
    let modelGeometry: BufferGeometry;
    try {
      const gltf = await new GLTFLoader().loadAsync(assets.modelUrl);
      modelGeometry = (gltf.scene.children[0] as Mesh).geometry;
    } catch (err) {
      console.error('[XylophoneEngine] bar model failed to load — showing the backdrop only', err);
      return;
    }

    this.instances = buildInstancedGeometry(modelGeometry, XYLOPHONE_CONFIG);
    this.geometryHeight = this.instances.localBox.max.y - this.instances.localBox.min.y;
    this.hitInstances = {
      aPos: this.instances.transforms.positions,
      aRot: this.instances.transforms.rotations,
    };

    this.uniforms.u_tGradient.value = buildGradientTexture();

    // prefers-reduced-motion suppresses the strike swing and the idle spin, not the interaction
    this.uniforms.u_swingScale.value = this.reduceMotion ? 0 : 1;
    this.uniforms.u_spinSpeed.value = this.reduceMotion ? 0 : XYLOPHONE_CONFIG.spinSpeed;

    this.material = new ShaderMaterial({
      uniforms: this.uniforms,
      vertexShader: xylophoneVert,
      fragmentShader: xylophoneFrag,
      side: DoubleSide,
    });

    this.mesh = new Mesh(this.instances.geometry, this.material);
    this.group.add(this.mesh);
  }

  /* --------------------------------- pointer --------------------------------- */
  /** `ndc` is -1..1 (three's raycasting convention); `screen01` is 0..1 with y-up from the bottom. */
  setPointer(ndcX: number, ndcY: number, screen01X: number, screen01Y: number): void {
    this.pointerNdc.set(ndcX, ndcY);
    this.pointerScreen01.set(screen01X, screen01Y);
    this.hasPointer = true;
  }

  clearPointer(): void {
    this.hasPointer = false;
    this.lastHitIndex = -1;
  }

  /* ---------------------------------- resize --------------------------------- */
  resize(width: number, height: number): void {
    this.width = Math.max(1, Math.round(width));
    this.height = Math.max(1, Math.round(height));

    this.renderer.setSize(this.width, this.height, false);
    this.camera.aspect = this.width / this.height;
    this.camera.updateProjectionMatrix();

    this.backdropTarget.setSize(this.width, this.height);
    this.blurredBackdropTarget.setSize(this.width, this.height);
    this.blurPass.setSize(this.width, this.height);
  }

  /* ---------------------------------- update --------------------------------- */
  /** Advance the conveyor. Autoplay, not scroll — see the class doc comment for why. */
  private updateConveyor(delta: number): void {
    if (!this.instances || this.reduceMotion) return;

    this.phase += XYLOPHONE_CONFIG.autoAdvanceSpeed * delta;
    if (Math.abs(this.phase - this.phaseWritten) <= 1e-5) return;

    const { positions, rotations } = this.instances.transforms;
    writeHelixTransforms(
      this.phase,
      this.geometryHeight,
      XYLOPHONE_CONFIG,
      positions,
      rotations,
      this.scrollEuler,
      this.scrollQuat,
    );

    this.instances.geometry.attributes['aPos']!.needsUpdate = true;
    this.instances.geometry.attributes['aRot']!.needsUpdate = true;
    this.phaseWritten = this.phase;
  }

  /** Hovering a new bar strikes it: stamp the strike time, which drives the visual swing. */
  private updateStrike(): void {
    if (!this.instances || !this.hitInstances || !this.hasPointer) return;

    this.raycaster.setFromCamera(this.pointerNdc, this.camera);
    const index = hitBarIndex(
      this.raycaster.ray,
      this.hitInstances,
      this.instances.localBox,
      this.group.matrixWorld,
      this.time,
      this.uniforms.u_spinSpeed.value,
      this.hitWorkspace,
    );

    if (index !== -1 && index !== this.lastHitIndex) {
      this.instances.aStrikeTime.setX(index, this.time);
      this.instances.aStrikeTime.needsUpdate = true;
    }

    this.lastHitIndex = index;
  }

  /** One bg render -> Gaussian blur -> the texture the glass shader transmits through. */
  private renderBackdrop(): void {
    const prevTarget = this.renderer.getRenderTarget();
    const prevMask = this.camera.layers.mask;

    this.camera.layers.set(BG_LAYER);
    this.renderer.setRenderTarget(this.backdropTarget);
    this.renderer.render(this.scene, this.camera);

    this.camera.layers.mask = prevMask;
    this.renderer.setRenderTarget(prevTarget);

    if (!this.blurInitialized) {
      this.blurPass.initialize(this.renderer, true, UnsignedByteType);
      this.blurInitialized = true;
    }
    this.blurPass.render(this.renderer, this.backdropTarget, this.blurredBackdropTarget);
  }

  /**
   * Renders one frame. `delta` is in seconds. Returns false (and draws nothing) once the WebGL
   * context has been lost — the caller should keep calling it, since the browser can restore the
   * context later and three re-uploads its own GPU resources automatically on restore.
   */
  render(delta: number): boolean {
    if (this.disposed || this.contextLost) return false;

    const clamped = Math.min(delta, MAX_DELTA);
    this.time += clamped;
    this.uniforms.u_time.value = this.time;

    this.updateConveyor(clamped);
    this.updateStrike();
    this.fluid.step(
      this.renderer,
      this.fboHelper,
      this.time,
      clamped,
      this.width / this.height,
      this.pointerScreen01,
    );
    this.uniforms.u_tFluid.value = this.fluid.velocityTexture;

    this.renderBackdrop();

    this.camera.layers.enableAll();
    this.renderer.setRenderTarget(null);
    this.renderer.render(this.scene, this.camera);

    return true;
  }

  dispose(): void {
    this.disposed = true;

    this.instances?.geometry.dispose();
    this.material?.dispose();
    this.uniforms.u_tGradient.value?.dispose();
    if (this.mesh) this.group.remove(this.mesh);

    this.fluid.dispose();
    this.fboHelper.dispose();

    this.bgMesh.geometry.dispose();
    this.bgMaterial.dispose();

    this.backdropTarget.dispose();
    this.blurredBackdropTarget.dispose();
    this.blurPass.dispose();

    this.renderer.dispose();
  }
}
