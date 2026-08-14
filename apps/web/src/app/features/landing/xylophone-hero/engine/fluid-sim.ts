import {
  FloatType,
  HalfFloatType,
  LinearFilter,
  NearestFilter,
  type RawShaderMaterial,
  type RenderTargetOptions,
  RGBAFormat,
  type Texture,
  Vector2,
  Vector3,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import {
  fluidAdvectionFrag,
  fluidBaseVert,
  fluidClearFrag,
  fluidCurlFrag,
  fluidDivergenceFrag,
  fluidGradientSubtractFrag,
  fluidPressureFrag,
  fluidSplatFrag,
  fluidVorticityFrag,
} from './shaders/fluid.glsl';
import { Fbo } from './fbo';
import { FboHelper } from './fbo-helper';

/**
 * Low-res GPU fluid solve driving the bars' hover-wake tint — adapted from Sujen Phea's WebGL
 * Xylophone (MIT), itself adapted from Pavel Dobryakov's WebGL-Fluid-Simulation (MIT). The bars
 * only sample the field's velocity MAGNITUDE, so resolution stays fixed regardless of viewport
 * size; nothing here needs to resize.
 *
 * Unlike the source, this is an instance scoped to one renderer rather than a page-wide
 * singleton driven by a global requestAnimationFrame collection: the owning engine calls
 * {@link step} directly once per rendered frame, with the current pointer position and clock
 * already resolved to the hero's own container instead of `window`.
 */
export interface FluidSimOptions {
  simRes: number;
  pressureIterations: number;
  pressureDissipation: number;
  velocityDissipation: number;
  curlStrength: number;
  splatRadius: number;
  splatForce: number;
}

/** Seconds of pointer stillness before the solve is skipped entirely. */
const IDLE_SLEEP_AFTER = 2.5;

/** Reused for the per-frame pointer delta, so `step` allocates nothing. */
const pointerDelta = new Vector2();

export class FluidSim {
  private readonly config: { simTexelSize: number } & FluidSimOptions;

  private readonly materials: {
    curl: RawShaderMaterial;
    vorticity: RawShaderMaterial;
    divergence: RawShaderMaterial;
    clear: RawShaderMaterial;
    pressure: RawShaderMaterial;
    gradientSubtract: RawShaderMaterial;
    advection: RawShaderMaterial;
    splat: RawShaderMaterial;
  };

  private readonly fbos: {
    velocity: Fbo;
    divergence: WebGLRenderTarget;
    curl: WebGLRenderTarget;
    pressure: Fbo;
  };

  private velocity: Texture | null = null;

  // pointer tracking — mirrors the source's TouchPoint, but fed by the caller each frame
  // instead of read from a global.
  private readonly pointerPosition = new Vector2(0.5, 0.5);
  private readonly pointerPrevPosition = new Vector2(0.5, 0.5);
  private pointerVelocity = 0;
  private lastPointerUpdate = 0;
  private lastSplat = 0;
  private lastUserInput = 0;

  get velocityTexture(): Texture | null {
    return this.velocity;
  }

  /* -------------------------------- materials ------------------------------- */
  private createPassMaterial(
    fboHelper: FboHelper,
    fragmentShader: string,
    precision: string,
    uniforms: Record<string, { value: unknown }>,
    defines?: Record<string, boolean>,
  ): RawShaderMaterial {
    return fboHelper.createRawShaderMaterial({
      uniforms,
      vertexShader: fluidBaseVert,
      fragmentShader,
      fragmentShaderPrefix: `precision ${precision} float;\nprecision ${precision} sampler2D;\n`,
      ...(defines ? { defines } : {}),
    });
  }

  /**
   * One material per step of the solve. The passes that integrate velocity need `highp` — at
   * mediump the field drifts and the wake visibly quantises. The ones that only take finite
   * differences of neighbours are fine at mediump, which is cheaper on mobile.
   */
  private createMaterials(renderer: WebGLRenderer, fboHelper: FboHelper) {
    const capabilities = renderer.capabilities;
    const high = capabilities.getMaxPrecision('highp');
    const medium = capabilities.getMaxPrecision('mediump');

    // `u_texelSize` is per-material because each RawShaderMaterial owns its own uniform objects
    const texelSize = (): { u_texelSize: { value: Vector2 } } => ({
      u_texelSize: { value: new Vector2() },
    });

    return {
      splat: this.createPassMaterial(fboHelper, fluidSplatFrag, high, {
        ...texelSize(),
        u_tTarget: { value: null },
        u_aspectRatio: { value: 1 },
        u_splatColor: { value: new Vector3() },
        u_splatPosition: { value: new Vector2() },
        u_prevPoint: { value: new Vector2() },
        u_splatRadius: { value: 1 },
      }),

      curl: this.createPassMaterial(fboHelper, fluidCurlFrag, medium, {
        ...texelSize(),
        u_tVelocity: { value: null },
      }),

      vorticity: this.createPassMaterial(fboHelper, fluidVorticityFrag, high, {
        ...texelSize(),
        u_tVelocity: { value: null },
        u_tCurl: { value: null },
        u_curl: { value: this.config.curlStrength },
        u_dt: { value: 1 / 60 },
      }),

      divergence: this.createPassMaterial(fboHelper, fluidDivergenceFrag, medium, {
        ...texelSize(),
        u_tVelocity: { value: null },
      }),

      clear: this.createPassMaterial(fboHelper, fluidClearFrag, medium, {
        ...texelSize(),
        u_tTexture: { value: null },
        u_value: { value: this.config.pressureDissipation },
        u_dt: { value: 1 / 60 },
      }),

      pressure: this.createPassMaterial(fboHelper, fluidPressureFrag, medium, {
        ...texelSize(),
        u_tPressure: { value: null },
        u_tDivergence: { value: null },
      }),

      gradientSubtract: this.createPassMaterial(fboHelper, fluidGradientSubtractFrag, medium, {
        ...texelSize(),
        u_tPressure: { value: null },
        u_tVelocity: { value: null },
      }),

      advection: this.createPassMaterial(
        fboHelper,
        fluidAdvectionFrag,
        high,
        {
          ...texelSize(),
          u_tVelocity: { value: null },
          u_tSource: { value: null },
          u_dt: { value: 1 / 60 },
          u_dissipation: { value: 1 },
        },
        // Bilinear-filter the backtraced sample in the shader. WebGL cannot linearly filter float
        // textures everywhere, and there is no reliable capability flag for it in three, so the
        // manual path is always on rather than probed.
        { MANUAL_FILTERING: true },
      ),
    };
  }

  private createFbos(fboHelper: FboHelper) {
    // Velocity drives the sim (advection) and is the field the bars sample for their tint.
    // HalfFloat + Linear is forced rather than chosen from a capability flag: smooth advection
    // needs linear sampling, and falling back to NearestFilter here visibly pixelates the wake.
    const velocity = new Fbo(fboHelper, this.config.simRes, this.config.simRes, {
      format: RGBAFormat,
      type: HalfFloatType,
      minFilter: LinearFilter,
      magFilter: LinearFilter,
    });
    const pressure = new Fbo(fboHelper, this.config.simRes, this.config.simRes, {
      minFilter: NearestFilter,
      magFilter: NearestFilter,
    });

    const renderTargetConfig: RenderTargetOptions = {
      type: FloatType,
      magFilter: NearestFilter,
      minFilter: NearestFilter,
      depthBuffer: false,
    };
    const divergence = fboHelper.createRenderTarget(
      this.config.simRes,
      this.config.simRes,
      renderTargetConfig,
    );
    const curl = fboHelper.createRenderTarget(
      this.config.simRes,
      this.config.simRes,
      renderTargetConfig,
    );

    return { velocity, pressure, divergence, curl };
  }

  /** Splat + decay the pointer's velocity magnitude, called once per {@link step}. */
  private updatePointer(
    time: number,
    screenXY: Vector2,
    aspect: number,
    fboHelper: FboHelper,
  ): void {
    // Skip if updated too recently (60fps throttle)
    if (time - this.lastPointerUpdate < 0.016) return;

    this.pointerPosition.copy(screenXY);
    pointerDelta.subVectors(this.pointerPosition, this.pointerPrevPosition);
    const distance = pointerDelta.length();

    this.pointerVelocity += distance * 2;

    if (distance > 0) {
      // genuine cursor movement: note it so the idle gate keeps solving
      if (distance > 0.001) this.lastUserInput = time;

      const shouldStartNewLine = time - this.lastSplat > 0.15;

      const splat = this.materials.splat;
      splat.uniforms['u_tTarget']!.value = this.fbos.velocity.read.texture;
      splat.uniforms['u_aspectRatio']!.value = aspect;
      (splat.uniforms['u_splatPosition']!.value as Vector2).copy(this.pointerPosition);
      (splat.uniforms['u_prevPoint']!.value as Vector2).copy(
        shouldStartNewLine ? this.pointerPosition : this.pointerPrevPosition,
      );
      (splat.uniforms['u_splatColor']!.value as Vector3)
        .set(pointerDelta.x * aspect, pointerDelta.y, 0)
        .multiplyScalar(this.config.splatForce)
        .multiplyScalar(shouldStartNewLine ? 0 : 1);
      splat.uniforms['u_splatRadius']!.value = this.config.splatRadius * this.pointerVelocity;

      fboHelper.render(splat, this.fbos.velocity.write);
      this.fbos.velocity.swap();

      this.lastSplat = time;
    }

    this.lastPointerUpdate = time;
    this.pointerPrevPosition.copy(this.pointerPosition);
    this.pointerVelocity *= 0.9;
    this.pointerVelocity = Math.min(1, this.pointerVelocity);
  }

  /** Runs the full stable-fluids pipeline for one frame, or skips it once the field has gone idle. */
  step(
    renderer: WebGLRenderer,
    fboHelper: FboHelper,
    time: number,
    deltaTime: number,
    aspect: number,
    pointerScreenXY: Vector2,
  ): void {
    const savedAutoClear = renderer.autoClear;
    const savedRenderTarget = renderer.getRenderTarget();
    renderer.autoClear = false;

    this.updatePointer(time, pointerScreenXY, aspect, fboHelper);

    // Idle gate: once input is stale and the field has dissipated, skip the solve to save GPU/battery.
    if (time - this.lastUserInput > IDLE_SLEEP_AFTER) {
      renderer.autoClear = savedAutoClear;
      renderer.setRenderTarget(savedRenderTarget);
      return;
    }

    const m = this.materials;
    const texel = this.config.simTexelSize;

    // Compute curl of velocity field
    (m.curl.uniforms['u_texelSize']!.value as Vector2).setScalar(texel);
    m.curl.uniforms['u_tVelocity']!.value = this.fbos.velocity.read.texture;
    fboHelper.render(m.curl, this.fbos.curl);

    // Apply vorticity confinement
    (m.vorticity.uniforms['u_texelSize']!.value as Vector2).setScalar(texel);
    m.vorticity.uniforms['u_tVelocity']!.value = this.fbos.velocity.read.texture;
    m.vorticity.uniforms['u_tCurl']!.value = this.fbos.curl.texture;
    m.vorticity.uniforms['u_curl']!.value = this.config.curlStrength;
    m.vorticity.uniforms['u_dt']!.value = deltaTime;
    fboHelper.render(m.vorticity, this.fbos.velocity.write);
    this.fbos.velocity.swap();

    // Compute divergence of velocity field
    (m.divergence.uniforms['u_texelSize']!.value as Vector2).setScalar(texel);
    m.divergence.uniforms['u_tVelocity']!.value = this.fbos.velocity.read.texture;
    fboHelper.render(m.divergence, this.fbos.divergence);

    // Clear pressure field with dissipation
    m.clear.uniforms['u_tTexture']!.value = this.fbos.pressure.read.texture;
    m.clear.uniforms['u_value']!.value = this.config.pressureDissipation;
    m.clear.uniforms['u_dt']!.value = deltaTime;
    fboHelper.render(m.clear, this.fbos.pressure.write);
    this.fbos.pressure.swap();

    // Solve for pressure using Jacobi iteration
    (m.pressure.uniforms['u_texelSize']!.value as Vector2).setScalar(texel);
    m.pressure.uniforms['u_tDivergence']!.value = this.fbos.divergence.texture;
    for (let i = 0; i < this.config.pressureIterations; i++) {
      m.pressure.uniforms['u_tPressure']!.value = this.fbos.pressure.read.texture;
      fboHelper.render(m.pressure, this.fbos.pressure.write);
      this.fbos.pressure.swap();
    }

    // Subtract pressure gradient from velocity to make it divergence-free
    (m.gradientSubtract.uniforms['u_texelSize']!.value as Vector2).setScalar(texel);
    m.gradientSubtract.uniforms['u_tPressure']!.value = this.fbos.pressure.read.texture;
    m.gradientSubtract.uniforms['u_tVelocity']!.value = this.fbos.velocity.read.texture;
    fboHelper.render(m.gradientSubtract, this.fbos.velocity.write);
    this.fbos.velocity.swap();

    // Advect velocity through itself
    (m.advection.uniforms['u_texelSize']!.value as Vector2).setScalar(texel);
    m.advection.uniforms['u_tVelocity']!.value = this.fbos.velocity.read.texture;
    m.advection.uniforms['u_tSource']!.value = this.fbos.velocity.read.texture;
    m.advection.uniforms['u_dt']!.value = deltaTime;
    m.advection.uniforms['u_dissipation']!.value = this.config.velocityDissipation;
    fboHelper.render(m.advection, this.fbos.velocity.write);
    this.fbos.velocity.swap();

    renderer.autoClear = savedAutoClear;
    renderer.setRenderTarget(savedRenderTarget);

    this.velocity = this.fbos.velocity.read.texture;
  }

  constructor(renderer: WebGLRenderer, fboHelper: FboHelper, options: FluidSimOptions) {
    this.config = { ...options, simTexelSize: 1 / options.simRes };
    this.fbos = this.createFbos(fboHelper);
    this.materials = this.createMaterials(renderer, fboHelper);
  }

  dispose(): void {
    this.materials.clear.dispose();
    this.materials.splat.dispose();
    this.materials.curl.dispose();
    this.materials.vorticity.dispose();
    this.materials.divergence.dispose();
    this.materials.pressure.dispose();
    this.materials.gradientSubtract.dispose();
    this.materials.advection.dispose();

    this.fbos.velocity.dispose();
    this.fbos.pressure.dispose();
    this.fbos.divergence.dispose();
    this.fbos.curl.dispose();
  }
}
