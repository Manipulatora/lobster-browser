/**
 * Stable-fluids GPGPU solver — adapted from Sujen Phea's WebGL Xylophone (MIT), itself adapted
 * from Pavel Dobryakov's WebGL-Fluid-Simulation (MIT),
 * https://github.com/PavelDoGreat/WebGL-Fluid-Simulation. Unchanged from the xylophone source.
 *
 * Drives only the hover-wake velocity field the bars sample for their tint reveal — see
 * fluid-sim.ts for the pass order.
 */

export const fluidBaseVert = `
// Shared vertex shader for every fluid pass.
//
// Beyond the uv, it precomputes the four neighbour coordinates (left/right/top/bottom) that the
// finite-difference passes need. Doing it here rather than in each fragment shader means the
// interpolator hands them over for free instead of every fragment recomputing four offsets.

attribute vec2 position;

uniform vec2 u_texelSize;

varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;

void main() {
  vUv = position.xy * 0.5 + 0.5;
  vL = vUv - vec2(u_texelSize.x, 0.0);
  vR = vUv + vec2(u_texelSize.x, 0.0);
  vT = vUv + vec2(0.0, u_texelSize.y);
  vB = vUv - vec2(0.0, u_texelSize.y);
  gl_Position = vec4(position, 0.0, 1.0);
}
`;

export const fluidSplatFrag = `
// Pipeline step 0 (input): injects the pointer's motion into the velocity field.
//
// Runs only when the cursor moved, before the solve. Everything downstream just redistributes
// what this writes, so with no pointer movement the field decays to nothing.

uniform sampler2D u_tTarget;
uniform float u_aspectRatio;
uniform vec3 u_splatColor;
uniform vec2 u_splatPosition;
uniform vec2 u_prevPoint;
uniform float u_splatRadius;

varying vec2 vUv;

void main() {
  // Splat along the swipe segment (u_prevPoint -> u_splatPosition) instead of a single point, so
  // fast strokes read as a continuous brush rather than a dotted trail of gaussian blobs. A
  // zero-length segment (new stroke) collapses to a point gaussian via the length guard below.
  vec2 uv = vUv;
  vec2 a = u_prevPoint;
  vec2 b = u_splatPosition;

  // aspect-correct x so the brush stays round rather than stretched
  uv.x *= u_aspectRatio;
  a.x *= u_aspectRatio;
  b.x *= u_aspectRatio;

  // closest point on segment [a, b] to this fragment, then gaussian falloff from that distance
  vec2 ab = b - a;
  float t = clamp(dot(uv - a, ab) / max(dot(ab, ab), 1e-6), 0.0, 1.0);
  vec2 p = uv - (a + t * ab);

  vec3 splat = exp(-dot(p, p) / (u_splatRadius / 50.0)) * u_splatColor;

  vec3 base = texture2D(u_tTarget, vUv).xyz;
  vec3 result = base + splat;

  gl_FragColor = vec4(result, 1.0);
}
`;

export const fluidCurlFrag = `
// Pipeline step 1: curl (vorticity) of the velocity field — how much each texel is rotating.
//
// A plain finite-difference of the cross terms. Stored in R for the vorticity pass to read; on
// its own it changes nothing about the flow.

uniform sampler2D u_tVelocity;

varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;

void main() {
  float L = texture2D(u_tVelocity, vL).y;
  float R = texture2D(u_tVelocity, vR).y;
  float T = texture2D(u_tVelocity, vT).x;
  float B = texture2D(u_tVelocity, vB).x;
  float vorticity = R - L - T + B;
  gl_FragColor = vec4(0.5 * vorticity, 0.0, 0.0, 1.0);
}
`;

export const fluidVorticityFrag = `
// Pipeline step 2: vorticity confinement — pushes velocity back along the curl gradient.
//
// A coarse grid bleeds angular momentum, so eddies flatten out within a frame or two. This adds
// the lost swirl back, which is what keeps the cursor wake curling instead of just smearing.
// Purely an aesthetic term: physically the solve is complete without it.

varying vec2 vUv;
varying vec2 vL;
varying vec2 vR;
varying vec2 vT;
varying vec2 vB;

uniform sampler2D u_tVelocity;
uniform sampler2D u_tCurl;
uniform float u_curl;
uniform float u_dt;

void main() {
  float L = texture2D(u_tCurl, vL).x;
  float R = texture2D(u_tCurl, vR).x;
  float T = texture2D(u_tCurl, vT).x;
  float B = texture2D(u_tCurl, vB).x;
  float C = texture2D(u_tCurl, vUv).x;

  vec2 force = 0.5 * vec2(abs(T) - abs(B), abs(R) - abs(L));
  force /= length(force) + 0.0001;
  force *= u_curl * C;
  force.y *= -1.0;

  vec2 vel = texture2D(u_tVelocity, vUv).xy;
  vel += force * u_dt;

  // Clamp so a frame hitch (large u_dt) can't spike the field into a value that overflows the
  // half-float velocity target to Inf/NaN, which would poison the sim permanently.
  vel = clamp(vel, -1000.0, 1000.0);

  gl_FragColor = vec4(vel, 0.0, 1.0);
}
`;

export const fluidDivergenceFrag = `
// Pipeline step 3: divergence — net flow in or out of each texel.
//
// Incompressible fluid must have zero divergence everywhere; advection and the splat both break
// that. This measures the error so the pressure solve can correct it.

varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;
uniform sampler2D u_tVelocity;

void main() {
  float L = texture2D(u_tVelocity, vL).x;
  float R = texture2D(u_tVelocity, vR).x;
  float T = texture2D(u_tVelocity, vT).y;
  float B = texture2D(u_tVelocity, vB).y;

  float div = 0.5 * (R - L + T - B);
  gl_FragColor = vec4(div, 0.0, 0.0, 1.0);
}
`;

export const fluidClearFrag = `
// Fades a field toward zero by a per-second factor. Used on pressure between frames so stale
// pressure does not accumulate across the Jacobi iterations of the next solve.

varying vec2 vUv;
uniform sampler2D u_tTexture;
uniform float u_value;
uniform float u_dt;
void main() {
  // u_value is a per-second dissipation factor; normalize by dt (×60 baseline) so the decay is
  // refresh-rate independent (exponent is 1 at 60fps, matching the previously tuned value).
  gl_FragColor.rgb = pow(u_value, u_dt * 60.0) * texture2D(u_tTexture, vUv).rgb;
  gl_FragColor.a = 1.0;
}
`;

export const fluidPressureFrag = `
// Pipeline step 4: one Jacobi iteration of the pressure solve.
//
// Finds the pressure field whose gradient cancels the divergence measured in step 3. Each pass
// averages the four neighbours minus the local divergence, so pressure spreads outward one texel
// per iteration — the sim runs this repeatedly (pressureIterations) to let it propagate.

uniform sampler2D u_tPressure;
uniform sampler2D u_tDivergence;

varying highp vec2 vUv;
varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;

void main() {
  // Neighbour taps need no clamping: the targets are ClampToEdge, so sampling past an edge
  // repeats the edge texel, which is the free-slip boundary this solve wants anyway.
  float L = texture2D(u_tPressure, vL).x;
  float R = texture2D(u_tPressure, vR).x;
  float T = texture2D(u_tPressure, vT).x;
  float B = texture2D(u_tPressure, vB).x;
  float divergence = texture2D(u_tDivergence, vUv).x;
  float pressure = (L + R + B + T - divergence) * 0.25;
  gl_FragColor = vec4(pressure, 0.0, 0.0, 1.0);
}
`;

export const fluidGradientSubtractFrag = `
// Pipeline step 5: subtract the pressure gradient from velocity.
//
// This is the step that actually enforces incompressibility: it removes exactly the component of
// the flow that was pushing texels apart, leaving the field divergence-free.

uniform sampler2D u_tPressure;
uniform sampler2D u_tVelocity;

varying highp vec2 vUv;
varying highp vec2 vL;
varying highp vec2 vR;
varying highp vec2 vT;
varying highp vec2 vB;

void main() {
  // see fluidPressureFrag: ClampToEdge targets give the free-slip boundary for free
  float L = texture2D(u_tPressure, vL).x;
  float R = texture2D(u_tPressure, vR).x;
  float T = texture2D(u_tPressure, vT).x;
  float B = texture2D(u_tPressure, vB).x;
  vec2 velocity = texture2D(u_tVelocity, vUv).xy;
  velocity.xy -= vec2(R - L, T - B);
  gl_FragColor = vec4(velocity, 0.0, 1.0);
}
`;

export const fluidAdvectionFrag = `
// Pipeline step 6: advection — the field carries itself downstream.
//
// Semi-Lagrangian: instead of pushing each texel forward (which leaves gaps), trace backwards
// along the velocity to find where this texel's contents came from, and sample there.
//
// MANUAL_FILTERING does that sample with an explicit bilinear fetch rather than relying on the
// hardware's, for platforms that cannot linearly filter float textures.

varying vec2 vUv;
uniform sampler2D u_tVelocity;
uniform sampler2D u_tSource;
uniform vec2 u_texelSize;
uniform float u_dt;
uniform float u_dissipation;

vec4 bilerp(sampler2D sam, vec2 uv, vec2 tsize) {
  vec2 st = uv / tsize - 0.5;
  vec2 iuv = floor(st);
  vec2 fuv = fract(st);
  vec4 a = texture2D(sam, (iuv + vec2(0.5, 0.5)) * tsize);
  vec4 b = texture2D(sam, (iuv + vec2(1.5, 0.5)) * tsize);
  vec4 c = texture2D(sam, (iuv + vec2(0.5, 1.5)) * tsize);
  vec4 d = texture2D(sam, (iuv + vec2(1.5, 1.5)) * tsize);
  return mix(mix(a, b, fuv.x), mix(c, d, fuv.x), fuv.y);
}

void main() {
  vec4 result;

  #ifdef MANUAL_FILTERING
    vec2 coord = vUv - u_dt * bilerp(u_tVelocity, vUv, u_texelSize).xy * u_texelSize;
    result = bilerp(u_tSource, coord, u_texelSize);
  #else
    vec2 coord = vUv - u_dt * texture2D(u_tVelocity, vUv).xy * u_texelSize;
    result = texture2D(u_tSource, coord);
  #endif

  // dissipation is a per-second factor; raise it to (dt*60) so the trail fades at the same rate
  // regardless of refresh rate (at 60fps the exponent is 1, preserving the tuned look).
  gl_FragColor.rgb = result.rgb * pow(u_dissipation, u_dt * 60.0);
  gl_FragColor.a = 1.0;
}
`;
