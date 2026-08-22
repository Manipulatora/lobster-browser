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

/** Explicit acknowledgement that a software-GPU host may run only provisional, non-release checks. */
export function allowProvisionalSoftwareGpu(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = (env.LOBSTER_ALLOW_SOFTWARE_GPU_CALIBRATION ?? '').trim().toLowerCase();
  return ['1', 'true', 'yes', 'on'].includes(raw);
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
/**
 * Permit the software GL fallback. This is a SAFETY NET, not a request for software rendering: with
 * it, ANGLE still prefers the real driver and only falls back when there is nothing to fall back
 * from.
 *
 * Without it, a host with no usable GPU does not get slow WebGL - it gets NONE. Measured on this
 * build, on a machine with no /dev/dri, with no GPU flags at all:
 *
 *     gpu.featureStatus.webgl        disabled_off
 *     canvas.getContext('webgl')     null
 *     canvas.getContext('webgl2')    null
 *     navigator.gpu                  undefined
 *
 * Two things follow, and the second is the serious one. Any 3D content simply fails to run. And a
 * browser that has no WebGL context at all is not a quieter fingerprint - it is a screaming one:
 * real Chrome on real hardware always has WebGL, so its absence is a headless/VM tell far louder
 * than any renderer string. It also makes the whole native WebGL moat inert - webgl-surfaces,
 * host-gpu-profile, webgl2-surfaces and webgpu-adapter all hook a context that never gets created.
 *
 * With the flag, on the same host, WebGL 1 and 2 both come back and the persona's renderer is what
 * the page reads - the software backend underneath stays invisible:
 *
 *     renderer  ANGLE (Intel, Intel(R) UHD Graphics 620 Direct3D11 vs_5_0 ps_5_0, D3D11)
 *
 * It is not on Chromium's bad-flags list (chrome/browser/ui/startup/bad_flags_prompt.cc), so unlike
 * --no-sandbox or --disable-blink-features it raises no "unsupported command-line flag" infobar.
 */
const SOFTWARE_GL_FALLBACK = '--enable-unsafe-swiftshader';

export function buildGpuArgs(opts: GpuArgsOptions = {}): string[] {
  const env = opts.env ?? process.env;
  const mode = opts.mode ?? resolveGpuMode(env);
  if (mode === 'gpu') {
    const backend = resolveAngleBackend(opts.angleBackend, env);
    if (backend === 'swiftshader') {
      return ['--use-gl=angle', '--use-angle=swiftshader', SOFTWARE_GL_FALLBACK];
    }
    return [
      '--use-gl=angle',
      `--use-angle=${backend}`,
      '--enable-gpu',
      '--ignore-gpu-blocklist',
      '--enable-features=Vulkan',
      // Even when the real driver is the intent, keep the software path PERMITTED. If ANGLE cannot
      // bring the GPU up - a container without /dev/dri, a blocklisted driver, a headless host - the
      // alternative is not "slower WebGL", it is NO WebGL at all. See the note on the constant.
      SOFTWARE_GL_FALLBACK,
    ];
  }
  if (mode === 'software') {
    return ['--use-gl=angle', '--use-angle=swiftshader', SOFTWARE_GL_FALLBACK];
  }
  return [SOFTWARE_GL_FALLBACK];
}

/** True when a WebGL renderer/vendor string indicates software rendering (a headless tell). */
export function isSoftwareRenderer(text: string | null | undefined): boolean {
  if (!text) return false;
  return /SwiftShader|llvmpipe|Software|Microsoft Basic Render|Mesa OffScreen/i.test(text);
}
