/**
 * GPU launch policy for Lobium and internal validation harnesses.
 *
 * WHY THIS EXISTS: the whole "Octo-class" claim rests on the deep GPU surfaces (WebGL
 * vendor/renderer, pixel farbling, caps/precision) being rendered by a REAL consumer GPU. In a
 * headless/container environment Chromium silently falls back to SwiftShader/llvmpipe (software),
 * which produces a `Google SwiftShader` / `llvmpipe` renderer string — a well-known headless tell and
 * the exact trap the production roadmap (RG-0/RG-1) warns about. Before this module the product launch
 * path passed NO GPU flags at all and the detector harness hard-coded `--enable-unsafe-swiftshader`,
 * so a real-GPU baseline was impossible to produce even on a GPU box.
 *
 * This helper centralizes the flag policy so both the product launcher and the detector harness make
 * the same, explicit choice: use the physical GPU (ANGLE over Vulkan/GL/Metal) or intentionally use
 * software (SwiftShader) for CI where no GPU exists.
 */

export type GpuMode = 'auto' | 'gpu' | 'software';

/** ANGLE backend that maps a GL context onto the platform driver. */
export type AngleBackend = 'vulkan' | 'gl' | 'gles' | 'metal' | 'd3d11' | 'swiftshader';

export interface GpuArgsOptions {
  /** Explicit mode. When omitted, resolved from `LOBSTER_GPU` (default `auto`). */
  mode?: GpuMode;
  /** ANGLE backend for `gpu` mode. When omitted, resolved from `LOBSTER_ANGLE_BACKEND` (default `vulkan`). */
  angleBackend?: AngleBackend;
  /** Env source (injectable for tests). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

const TRUE_GPU = new Set(['gpu', 'on', '1', 'true', 'yes', 'hardware', 'real']);
const SOFTWARE = new Set(['software', 'swiftshader', 'off', '0', 'false', 'no']);

/**
 * Resolve the GPU mode from the environment. `auto` (the default) emits no GL flags and lets Chromium
 * pick — preserving the historical behavior — so existing CI stays byte-identical unless opted in.
 */
export function resolveGpuMode(env: NodeJS.ProcessEnv = process.env): GpuMode {
  const raw = (env.LOBSTER_GPU ?? '').trim().toLowerCase();
  if (raw === '') return 'auto';
  if (TRUE_GPU.has(raw)) return 'gpu';
  if (SOFTWARE.has(raw)) return 'software';
  return 'auto';
}

function resolveAngleBackend(
  explicit: AngleBackend | undefined,
  env: NodeJS.ProcessEnv,
): AngleBackend {
  if (explicit) return explicit;
  const raw = (env.LOBSTER_ANGLE_BACKEND ?? '').trim().toLowerCase();
  const allowed: AngleBackend[] = ['vulkan', 'gl', 'gles', 'metal', 'd3d11', 'swiftshader'];
  return (allowed as string[]).includes(raw) ? (raw as AngleBackend) : 'vulkan';
}

/**
 * Build the Chromium GPU flags for the resolved mode.
 *
 * - `gpu`: force ANGLE onto the physical driver (default Vulkan, which is how NVIDIA is reachable in a
 *   headless Linux container) and ignore the GPU blocklist so newer/uncommon GPUs aren't demoted to
 *   software.
 * - `software`: force SwiftShader explicitly (CI/no-GPU) — deterministic software rendering.
 * - `auto`: no flags (historical default).
 */
export function buildGpuArgs(opts: GpuArgsOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? resolveGpuMode(env);
  if (mode === 'gpu') {
    const backend = resolveAngleBackend(opts.angleBackend, env);
    if (backend === 'swiftshader') {
      return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
    }
    return [
      '--use-gl=angle',
      `--use-angle=${backend}`,
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-features=Vulkan',
    ];
  }
  if (mode === 'software') {
    return ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
  }
  return [];
}

/** True when a WebGL renderer/vendor string indicates software rendering (a headless tell). */
export function isSoftwareRenderer(text: string | null | undefined): boolean {
  if (!text) return false;
  return /SwiftShader|llvmpipe|Software|Microsoft Basic Render|Mesa OffScreen/i.test(text);
}
