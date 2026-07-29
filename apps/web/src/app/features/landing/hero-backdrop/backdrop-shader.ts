/**
 * Scenic backdrop — a full-screen TSL (Three.js Shading Language) fragment shader.
 *
 * Adapted from Frank Reitberger's "scenic-backdrop"
 * (https://github.com/prinzipiell/tsl/tree/main/scenic-backdrop). The original renders a night
 * scene: dark sky, stars, drifting cloud layers, a moon, and a reflective water plane.
 *
 * WHAT CHANGED HERE, AND WHY
 *
 * The motion is the valuable part, the palette is not: a night scene cannot sit on a light violet
 * page. Rather than re-tune a dozen hard-coded colours (which fights the original's carefully
 * balanced luminance), the scene is computed as before and then its **luminance is remapped through
 * our brand ramp** at the very end. Dark regions (the sky) become the near-white page colour and
 * bright regions (moon, stars, water highlights) become violet — so every bit of the original's
 * drift and shimmer survives, inverted into a light composition.
 *
 * Ported fixes over the original source:
 * - `mulAssign`/`addAssign`/`subAssign` are NOT exported by `three/tsl` — they only exist as methods
 *   on nodes. The original imports them anyway; webpack silently bound `undefined`, but esbuild
 *   (what Angular uses) fails the build outright. They are simply not imported here.
 * - Every `Fn` parameter list is type-annotated, otherwise TypeScript picks the `NodeBuilder`
 *   overload and the shader will not typecheck.
 * - The tweakpane/dat.gui debug wiring and the `WebGLAssets` global are gone; textures and tunables
 *   are passed in, and the uniforms are returned so the page can retheme without rebuilding.
 */
import {
  Fn,
  abs,
  clamp,
  cos,
  dot,
  exp,
  float,
  length,
  mat2,
  max,
  mix,
  mod,
  pow,
  screenSize,
  screenUV,
  sin,
  smoothstep,
  sqrt,
  texture,
  time,
  uniform,
  vec2,
  vec3,
  vec4,
} from 'three/tsl';
import type { MeshBasicNodeMaterial, Node, Texture } from 'three/webgpu';

/** Exactly what `material.colorNode` accepts — keeps the shader and the component in lockstep. */
type ColorNode = NonNullable<MeshBasicNodeMaterial['colorNode']>;

export interface BackdropOptions {
  /** Tiling noise, drives the cloud FBM and the water. */
  readonly noise: Texture;
  /** Sparse high-frequency texture, drives the stars. */
  readonly stars: Texture;
}

export interface BackdropUniforms {
  /** Overall gamma of the underlying scene. */
  readonly gamma: ReturnType<typeof uniform>;
  /** Strength of the horizon band. */
  readonly horizon: ReturnType<typeof uniform>;
  /** Brightness of the celestial highlight. */
  readonly moonlight: ReturnType<typeof uniform>;
  /** 0 = untouched original palette, 1 = fully remapped to the brand ramp. */
  readonly tint: ReturnType<typeof uniform>;
}

/** Page background — where the scene is darkest it resolves to this. */
const PAGE = vec3(1.0, 1.0, 1.0);
/** Lightest violet, for the low midtones. */
const VIOLET_SOFT = vec3(0.906, 0.875, 1.0); // ~brand-100/200
/** Mid violet, for the bright structure (cloud edges, water shimmer). */
const VIOLET_MID = vec3(0.706, 0.608, 1.0); // ~brand-300/400
/** Deepest accent, reserved for the very brightest points. */
const VIOLET_DEEP = vec3(0.486, 0.227, 0.929); // brand-600

/**
 * Build the colour node for a full-screen quad.
 *
 * Returns the node plus its live uniforms so the caller can animate or retheme them.
 */
export function createBackdrop(options: BackdropOptions): {
  colorNode: ColorNode;
  uniforms: BackdropUniforms;
} {
  const gamma = uniform(0.87);
  const horizon = uniform(0.36);
  const moonlight = uniform(5.0);
  const tint = uniform(1.0);

  const noiseTex = options.noise;
  const starTex = options.stars;

  // Fractal brownian motion over the noise texture — the cloud shapes.
  const fbm = Fn(([p]: [Node<'vec2'>]) =>
    float(1.5)
      .mul(texture(noiseTex, p.mul(1.0)).x)
      .add(float(1.25).mul(texture(noiseTex, p.mul(2.02)).x))
      .add(float(1.125).mul(texture(noiseTex, p.mul(4.02)).x))
      .add(float(1.0675).mul(texture(noiseTex, p.mul(8.02)).x)),
  );

  // Lower-amplitude variant, used for the surface detail of the celestial body.
  const fbm2 = Fn(([p]: [Node<'vec2'>]) =>
    float(0.5)
      .mul(texture(noiseTex, p.mul(1.0)).x)
      .add(float(0.25).mul(texture(noiseTex, p.mul(2.02)).x))
      .add(float(0.125).mul(texture(noiseTex, p.mul(4.02)).x))
      .add(float(0.0675).mul(texture(noiseTex, p.mul(8.02)).x)),
  );

  const scene = Fn(() => {
    const tick = mod(time.mul(0.4), 458.0).toVar();

    // Screen space to a centred, aspect-corrected, y-up coordinate.
    const p = screenUV
      .sub(0.5)
      .mul(vec2(screenSize.x.div(screenSize.y), float(-1.0)))
      .mul(2.0)
      .toVar();

    // Slow parallax drift, so nothing ever sits still.
    p.addAssign(
      vec2(1.0, 3.0)
        .mul(0.002)
        .mul(2.0)
        .mul(cos(tick).mul(float(2.0).add(vec2(0.0, 1.5)))),
    );
    p.addAssign(
      vec2(1.0, 3.0)
        .mul(0.001)
        .mul(cos(tick).mul(float(5.0).add(vec2(1.0, 4.5)))),
    );
    p.mulAssign(float(0.95).add(float(0.05).mul(length(p))));

    // Gentle rotation of the whole frame.
    const an = float(0.03)
      .mul(sin(float(0.1).mul(tick)))
      .toVar();
    const co = cos(an).toVar();
    const si = sin(an).toVar();
    p.assign(mat2(co, si.negate(), si, co).mul(p));

    // --- water: a reflected plane below the horizon ------------------------------------------
    const q = vec2(p.x, float(-1.0)).div(p.y.sub(0.1)).toVar();
    const off = texture(
      noiseTex,
      float(0.1)
        .mul(
          mod(tick.mul(0.001), 2.0)
            .mul(q)
            .mul(vec2(1.0, float(2.0).oneMinus())),
        )
        .sub(vec2(0.0, float(0.007).mul(tick))).xy,
    ).toVar();
    const col = vec3(
      texture(
        noiseTex,
        float(1.9)
          .mul(q)
          .mul(mod(tick.mul(0.0005), 12.0))
          .mul(vec2(0.5, 8.0))
          .add(vec2(0.0, float(0.01).mul(tick))),
      ).zyx,
    ).toVar();
    col.mulAssign(0.4);

    const re = float(1.0)
      .sub(smoothstep(0.0, 0.7, abs(p.x.sub(0.6)).sub(abs(p.y).mul(0.3).add(0.2))))
      .toVar();
    col.addAssign(
      float(0.1)
        .mul(vec3(1.0, 0.9, 0.73))
        .mul(re)
        .mul(0.2)
        .mul(off.y)
        .mul(5.0)
        .mul(col.x.oneMinus()),
    );
    col.addAssign(
      float(0.5)
        .mul(vec3(1.0, 0.9, 0.73))
        .mul(re)
        .mul(0.2)
        .mul(off.y)
        .mul(moonlight)
        .mul(col.x.oneMinus()),
    );

    // --- sky, stars, clouds -------------------------------------------------------------------
    const sky = vec3(0.01, 0.03, 0.1).toVar();
    sky.addAssign(
      float(2.8).mul(
        smoothstep(
          0.9,
          1.0,
          texture(starTex, float(3.5).mul(p.add(tick.mul(0.1)).mul(0.29))).x,
        ).mul(1.6),
      ),
    );
    sky.addAssign(
      float(2.1).mul(
        smoothstep(0.5, 1.0, texture(starTex, float(2.5).mul(p.div(0.01).add(tick).mul(0.02))).y),
      ),
    );
    sky.addAssign(float(2.3).mul(pow(abs(float(0.5).sub(max(0.0, p.y))), 5.0)));

    const f = fbm(float(0.002).mul(vec2(p.x, 1.0).div(p.y))).toVar();
    const cloud = vec3(
      vec3(0.3, 0.4, 0.5)
        .mul(0.7)
        .mul(float(1.0).sub(float(0.85).mul(sqrt(smoothstep(0.4, 1.0, f))))),
    ).toVar();
    sky.assign(mix(sky, cloud, float(0.95).mul(smoothstep(0.4, 0.6, f))));
    sky.assign(
      mix(
        sky,
        vec3(0.33, 0.34, 0.35),
        pow(float(1.0).sub(max(0.0, p.y)), float(5.0).add(sin(time).mul(2.0))),
      ),
    );
    col.assign(mix(col, sky, smoothstep(0.0, 0.1, p.y)));

    // --- celestial highlight ------------------------------------------------------------------
    const ddd = length(p.sub(vec2(0.58, 0.45))).toVar();
    const moontex = float(0.8)
      .add(0.2)
      .mul(
        smoothstep(
          0.25,
          0.7,
          fbm2(
            float(0.3)
              .add(sin(time).mul(float(0.01).add(sin(time).mul(0.018))))
              .mul(p.oneMinus()),
          ),
        ),
      )
      .toVar();
    const moon = vec3(1.0, 0.97, 0.9).toVar();
    col.addAssign(moon.mul(exp(float(5.0).oneMinus().mul(ddd).add(moontex.mul(0.15).add(col)))));

    // --- horizon band -------------------------------------------------------------------------
    col.addAssign(
      horizon
        .mul(cos(tick.div(120.0)))
        .mul(pow(clamp(float(1.0).sub(abs(p.y.add(0.96).oneMinus())), 0.0, 1.0), 9.0)),
    );

    // --- tone ---------------------------------------------------------------------------------
    col.mulAssign(1.4);
    col.assign(pow(col, vec3(1.5, 1.2, 1.0)));
    col.assign(pow(col, vec3(float(1.0).div(gamma))));

    // --- violet remap -------------------------------------------------------------------------
    // Collapse the scene to luminance and re-expand it through the brand ramp. This is what turns
    // a night scene into a light one without touching any of the motion above: darkness becomes the
    // page colour, and the bright structure becomes violet.
    const lum = clamp(dot(col, vec3(0.2126, 0.7152, 0.0722)), 0.0, 1.0).toVar();
    const ramp = mix(
      mix(PAGE, VIOLET_SOFT, smoothstep(0.0, 0.2, lum)),
      mix(VIOLET_MID, VIOLET_DEEP, smoothstep(0.55, 1.0, lum)),
      smoothstep(0.16, 0.54, lum),
    ).toVar();

    // Keep it airy: even the deepest accent stays well short of full saturation.
    const tinted = mix(col, ramp, tint).toVar();

    // Fade up from the page colour on first paint, so there is no hard pop-in.
    return vec4(mix(PAGE, tinted, smoothstep(0.0, 3.0, tick)), 1.0);
  });

  return {
    colorNode: scene() as unknown as ColorNode,
    uniforms: { gamma, horizon, moonlight, tint },
  };
}
