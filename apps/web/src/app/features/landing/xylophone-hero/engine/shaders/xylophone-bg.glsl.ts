/**
 * Fullscreen gradient rendered behind the bars — adapted from Sujen Phea's WebGL Xylophone (MIT).
 * Also what the frosted transmission samples (see xylophone-engine.ts's backdrop blur).
 */

export const xylophoneBgVert = `
varying vec2 v_uv;

void main() {
  v_uv = uv;

  // fullscreen quad in clip space — ignore the camera so the bg stays fixed on screen
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

export const xylophoneBgFrag = `
uniform vec3 u_color;

varying vec2 v_uv;

void main() {
  // Anti-diagonal ramp: bottom-right (u_color, dark/saturated) -> top-left (white, bright).
  // v_uv.y is 0 at the bottom of the quad and 1 at the top (three's default PlaneGeometry UVs),
  // so t reaches its extremes exactly at those two corners: 0 at (x=1,y=0), 1 at (x=0,y=1). The
  // other two corners (bottom-left, top-right) both land on the midpoint — an unavoidable property
  // of ANY single linear ramp across a diagonal, not a bug. A plain 0..1 mix (no offset) is what
  // makes bottom-right reach the true base colour and top-left reach true white; the previous
  // "t - 0.3" here overshot past u_color at one end and fell 30% short of white at the other.
  float t = smoothstep(0.0, 1.0, v_uv.y * 0.5 + (1.0 - v_uv.x) * 0.5);
  vec3 color = mix(u_color, vec3(1.0), t);

  gl_FragColor = vec4(color, 1.0);
}
`;
