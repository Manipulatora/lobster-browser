/**
 * WebGL extension lists for a persona, in Chrome's own registration order.
 *
 * WHY THIS EXISTS. `getSupportedExtensions()` is a high-entropy surface that a detector cross-checks
 * against the claimed GPU. Before this module the catalog supplied no extension list at all, so the
 * engine fell through to the HOST's list — which on any machine whose real GPU differs from the
 * persona's claimed one is a direct contradiction: an "NVIDIA GeForce RTX 4070" renderer string
 * beside an Intel iGPU's extension set.
 *
 * ORDER IS NOT A GUESS. Chrome returns extensions in REGISTRATION order — the literal sequence of
 * `RegisterExtension<T>()` calls in `webgl_rendering_context.cc` and `webgl2_rendering_context.cc`
 * — filtered by whether the driver supports each one. Order is therefore a property of the Chromium
 * BUILD, not of the GPU, and the arrays below were extracted mechanically from the 152.0.7977.42
 * source rather than typed from memory. That matters: an alphabetised list (the old
 * host-calibration behaviour) is a shape no real Chrome ever emits.
 *
 * MEMBERSHIP IS A JUDGEMENT, and it is the honest limitation here. Which extensions a driver
 * actually exposes varies, and this repository has no real-GPU corpus to sample from. What follows
 * encodes the differences that are structural and well established, and deliberately does NOT
 * invent per-model variation:
 *
 *   - The compressed-texture families are the main desktop/mobile divide. S3TC (BC1-3), RGTC (BC4-5)
 *     and BPTC (BC6H/BC7) are the desktop set; ASTC, ETC, ETC1 and PVRTC are the mobile set. A
 *     desktop discrete or integrated GPU exposes the former and not the latter.
 *   - APPLE SILICON IS THE EXCEPTION and the reason this is not a flat desktop/mobile split: Apple's
 *     GPUs are mobile-derived and support ASTC and ETC natively, while historically NOT exposing the
 *     S3TC/BPTC block formats. An M-series Mac therefore looks closer to a phone than to a PC here,
 *     and getting that backwards is exactly the kind of contradiction this list exists to avoid.
 *   - `EXT_disjoint_timer_query` is not exposed on the Metal backend, so macOS omits it.
 *   - PVRTC is PowerVR-only (iOS and some older Android). No desktop persona ever gets it.
 *
 * The engine intersects whatever is configured here with what the live backend can actually do
 * (`fingerprint/webgl-runtime-safety.patch`), so a persona can never advertise an extension the
 * machine cannot execute. That means on a software renderer the observed list is a SUBSET of this
 * one — correct behaviour, but also why a software-rendered run is not release evidence.
 */

import type { OsFamily } from '@lobster/shared-types';

/**
 * WebGL1 registration order, extracted from
 * `third_party/blink/renderer/modules/webgl/webgl_rendering_context.cc`
 * (`WebGLRenderingContext::RegisterContextExtensions`) at Chromium 152.0.7977.42.
 */
export const WEBGL1_REGISTRATION_ORDER = [
  'ANGLE_instanced_arrays',
  'EXT_blend_minmax',
  'EXT_clip_control',
  'EXT_color_buffer_half_float',
  'EXT_depth_clamp',
  'EXT_disjoint_timer_query',
  'EXT_float_blend',
  'EXT_frag_depth',
  'EXT_polygon_offset_clamp',
  'EXT_shader_texture_lod',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic',
  'EXT_texture_mirror_clamp_to_edge',
  'EXT_sRGB',
  'KHR_parallel_shader_compile',
  'OES_element_index_uint',
  'OES_fbo_render_mipmap',
  'OES_standard_derivatives',
  'OES_texture_float',
  'OES_texture_float_linear',
  'OES_texture_half_float',
  'OES_texture_half_float_linear',
  'OES_vertex_array_object',
  'WEBGL_blend_func_extended',
  'WEBGL_color_buffer_float',
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_etc1',
  'WEBGL_compressed_texture_pvrtc',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_depth_texture',
  'WEBGL_draw_buffers',
  'WEBGL_lose_context',
  'WEBGL_multi_draw',
  'WEBGL_polygon_mode',
] as const;

/**
 * WebGL2 registration order, from `webgl2_rendering_context.cc`
 * (`WebGL2RenderingContext::RegisterContextExtensions`) at the same revision. Note it is a genuinely
 * different list, not a superset: WebGL2 folds several WebGL1 extensions into core (instanced
 * arrays, VAOs, depth texture, draw buffers, float textures) so they correctly do NOT appear.
 */
export const WEBGL2_REGISTRATION_ORDER = [
  'EXT_clip_control',
  'EXT_color_buffer_float',
  'EXT_color_buffer_half_float',
  'EXT_conservative_depth',
  'EXT_depth_clamp',
  'EXT_disjoint_timer_query_webgl2',
  'EXT_float_blend',
  'EXT_polygon_offset_clamp',
  'EXT_render_snorm',
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'EXT_texture_filter_anisotropic',
  'EXT_texture_mirror_clamp_to_edge',
  'EXT_texture_norm16',
  'KHR_parallel_shader_compile',
  'NV_shader_noperspective_interpolation',
  'OES_draw_buffers_indexed',
  'OES_sample_variables',
  'OES_shader_multisample_interpolation',
  'OES_texture_float_linear',
  'OVR_multiview2',
  'WEBGL_blend_func_extended',
  'WEBGL_clip_cull_distance',
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_etc1',
  'WEBGL_compressed_texture_pvrtc',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
  'WEBGL_debug_renderer_info',
  'WEBGL_debug_shaders',
  'WEBGL_draw_instanced_base_vertex_base_instance',
  'WEBGL_lose_context',
  'WEBGL_multi_draw',
  'WEBGL_multi_draw_instanced_base_vertex_base_instance',
  'WEBGL_polygon_mode',
  'WEBGL_provoking_vertex',
  'WEBGL_render_shared_exponent',
  'WEBGL_shader_pixel_local_storage',
  'WEBGL_stencil_texturing',
] as const;

/** Block-compression formats a desktop PC GPU exposes and a mobile-derived one does not. */
const DESKTOP_BLOCK_FORMATS = new Set([
  'EXT_texture_compression_bptc',
  'EXT_texture_compression_rgtc',
  'WEBGL_compressed_texture_s3tc',
  'WEBGL_compressed_texture_s3tc_srgb',
]);

/** Compression formats from the mobile lineage. Apple Silicon has these; a PC GPU does not. */
const MOBILE_BLOCK_FORMATS = new Set([
  'WEBGL_compressed_texture_astc',
  'WEBGL_compressed_texture_etc',
  'WEBGL_compressed_texture_etc1',
]);

/** PowerVR only — iOS and some older Android parts. Never a desktop persona. */
const PVRTC = 'WEBGL_compressed_texture_pvrtc';

/** Not implemented on the Metal backend, so absent on every Mac. */
const METAL_UNSUPPORTED = new Set(['EXT_disjoint_timer_query', 'EXT_disjoint_timer_query_webgl2']);

export interface WebGlExtensionOptions {
  /** True when the renderer string names an Apple M-series GPU. */
  appleSilicon?: boolean;
}

function select(order: readonly string[], os: OsFamily, opts: WebGlExtensionOptions): string[] {
  const apple = Boolean(opts.appleSilicon);
  return order.filter((name) => {
    if (name === PVRTC) return false;
    if (MOBILE_BLOCK_FORMATS.has(name)) return apple;
    if (DESKTOP_BLOCK_FORMATS.has(name)) return !apple;
    if (os === 'macos' && METAL_UNSUPPORTED.has(name)) return false;
    return true;
  });
}

/** The WebGL1 extension list a persona on `os` should present, in Chrome's registration order. */
export function webgl1ExtensionsFor(os: OsFamily, opts: WebGlExtensionOptions = {}): string[] {
  return select(WEBGL1_REGISTRATION_ORDER, os, opts);
}

/** The WebGL2 extension list for the same persona. */
export function webgl2ExtensionsFor(os: OsFamily, opts: WebGlExtensionOptions = {}): string[] {
  return select(WEBGL2_REGISTRATION_ORDER, os, opts);
}

/** True when a renderer string names an Apple M-series GPU (which changes the compression set). */
export function isAppleSiliconRenderer(renderer: string): boolean {
  return /Apple M\d/.test(renderer);
}
