/**
 * Scenic backdrop — a full-screen TSL (Three.js Shading Language) fragment shader.
 *
 * A faithful port of Frank Reitberger's "scenic-backdrop"
 * (github.com/prinzipiell/tsl/tree/main/scenic-backdrop, live at
 * https://dasprinzip.com/tinker/day25/): night sky and stars, drifting cloud layers, a sun low over
 * the horizon, and a lit sea below it.
 *
 * The maths and the palette are the original's, unchanged. The only edits are the ones required to
 * compile under esbuild + TypeScript:
 *
 * - `mulAssign`/`addAssign`/`subAssign` are NOT exported by `three/tsl`; they exist only as methods
 *   on nodes. The original imports them anyway — webpack silently bound `undefined`, but esbuild
 *   fails the build outright — so they are simply not imported.
 * - Every `Fn` parameter list is type-annotated, otherwise TypeScript resolves the `NodeBuilder`
 *   overload and the shader will not typecheck.
 * - Two statements in the original are no-ops (`q.y.sub(...)` and `q.add(0.4).div(...)` discard
 *   their results) and are omitted rather than reproduced.
 * - The tweakpane debug wiring and the `WebGLAssets` global are replaced by arguments; the uniforms
 *   are returned so they stay tunable. Defaults match the live demo's panel exactly:
 *   gamma 0.87, horizon 0.36, moonlight 5.0.
 */
import {
  Fn,
  abs,
  clamp,
  cos,
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
  /** Tiling noise; drives the cloud FBM and the sea. */
  readonly noise: Texture;
  /** Sparse high-frequency texture; drives the stars. */
  readonly stars: Texture;
}

export interface BackdropUniforms {
  readonly gamma: ReturnType<typeof uniform>;
  readonly horizon: ReturnType<typeof uniform>;
  readonly moonlight: ReturnType<typeof uniform>;
}

export function createBackdrop(options: BackdropOptions): {
  colorNode: ColorNode;
  uniforms: BackdropUniforms;
} {
  // Defaults taken from the demo's own control panel.
  const gamma = uniform(0.87);
  const horizon = uniform(0.36);
  const moonlight = uniform(5.0);

  const noiseTex = options.noise;
  const starTex = options.stars;

  const fbm = Fn(([p]: [Node<'vec2'>]) =>
    float(1.5)
      .mul(texture(noiseTex, p.mul(1.0)).x)
      .add(float(1.25).mul(texture(noiseTex, p.mul(2.02)).x))
      .add(float(1.125).mul(texture(noiseTex, p.mul(4.02)).x))
      .add(float(1.0675).mul(texture(noiseTex, p.mul(8.02)).x)),
  );

  const fbm2 = Fn(([p]: [Node<'vec2'>]) =>
    float(0.5)
      .mul(texture(noiseTex, p.mul(1.0)).x)
      .add(float(0.25).mul(texture(noiseTex, p.mul(2.02)).x))
      .add(float(0.125).mul(texture(noiseTex, p.mul(4.02)).x))
      .add(float(0.0675).mul(texture(noiseTex, p.mul(8.02)).x)),
  );

  const scene = Fn(() => {
    const tick = mod(time.mul(0.4), 458.0).toVar();

    const p = screenUV
      .sub(0.5)
      .mul(vec2(screenSize.x.div(screenSize.y), float(1.0).negate()))
      .mul(2.0)
      .toVar();

    // camera drift
    p.addAssign(
      vec2(1.0, 3.0)
        .mul(float(0.002))
        .mul(float(2.0))
        .mul(cos(tick).mul(float(2.0).add(vec2(0.0, 1.5)))),
    );
    p.addAssign(
      vec2(1.0, 3.0)
        .mul(float(0.001))
        .mul(float(1.0))
        .mul(cos(tick).mul(float(5.0).add(vec2(1.0, 4.5)))),
    );
    p.mulAssign(float(0.95).add(float(0.05).mul(length(p))));

    const an = float(0.03)
      .mul(sin(float(0.1).mul(tick)))
      .toVar();
    const co = float(cos(an)).toVar();
    const si = float(sin(an)).toVar();
    p.assign(mat2(co, si.negate(), si, co).mul(p));

    // ---- water -------------------------------------------------------------------------------
    const q = vec2(p.x, float(1.0).negate()).div(p.y.sub(0.1)).toVar();

    const off = texture(
      noiseTex,
      float(0.1).mul(
        mod(tick.mul(0.001), 2.0)
          .mul(q)
          .mul(vec2(1.0, float(2.0).oneMinus()))
          .sub(vec2(float(0.0), float(0.007).mul(tick))).xy,
      ),
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

    const re = float(
      float(1.0).sub(smoothstep(0.0, 0.7, abs(p.x.sub(0.6)).sub(abs(p.y).mul(0.3).add(0.2)))),
    ).toVar();
    col.addAssign(
      float(0.1)
        .mul(vec3(1.0, 0.9, 0.73))
        .mul(re)
        .mul(0.2)
        .mul(off.y)
        .mul(5.0)
        .mul(float(1.0).sub(col.x)),
    );
    col.addAssign(
      float(0.5)
        .mul(vec3(1.0, 0.9, 0.73))
        .mul(re)
        .mul(0.2)
        .mul(off.y)
        .mul(moonlight)
        .mul(float(1.0).sub(col.x)),
    );

    // ---- sky, stars, clouds ------------------------------------------------------------------
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
        .mul(
          float(1.0)
            .sub(0.85)
            .mul(sqrt(smoothstep(0.4, 1.0, f))),
        ),
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

    // ---- sun ---------------------------------------------------------------------------------
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
    col.addAssign(
      moon.mul(exp(float(5.0).oneMinus().mul(ddd).add(float(moontex).mul(0.15).add(col)))),
    );

    // ---- horizon -----------------------------------------------------------------------------
    col.addAssign(
      float(horizon)
        .mul(cos(tick.div(120.0)))
        .mul(pow(clamp(float(1.0).sub(abs(p.y.add(0.96).oneMinus())), 0.0, 1.0), 9.0)),
    );

    // ---- tone --------------------------------------------------------------------------------
    col.mulAssign(1.4);
    col.assign(pow(col, vec3(1.5, 1.2, 1.0)));
    col.assign(pow(col, vec3(float(1.0).div(gamma))));

    // blend-in
    col.mulAssign(smoothstep(0.0, 4.0, tick));

    return vec4(col, 1.0);
  });

  return {
    colorNode: scene() as unknown as ColorNode,
    uniforms: { gamma, horizon, moonlight },
  };
}
