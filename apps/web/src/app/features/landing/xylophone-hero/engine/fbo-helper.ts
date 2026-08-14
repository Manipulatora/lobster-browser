import {
  ClampToEdgeWrapping,
  LinearFilter,
  type Material,
  RawShaderMaterial,
  type RenderTargetOptions,
  SRGBColorSpace,
  type ShaderMaterialParameters,
  UnsignedByteType,
  WebGLRenderer,
  WebGLRenderTarget,
} from 'three';
import { FullScreenQuad } from 'three/examples/jsm/postprocessing/Pass.js';

/**
 * GPGPU render helpers, scoped to one renderer instance rather than a process-wide singleton —
 * adapted from Sujen Phea's WebGL Xylophone (MIT). The source keeps this as static state shared
 * by the whole page; a component that can mount more than once (or unmount and remount, which
 * Angular does on route re-entry) needs one instance per renderer instead.
 */
export class FboHelper {
  private readonly fsQuad = new FullScreenQuad();
  private readonly precisionPrefix: string;

  constructor(private readonly renderer: WebGLRenderer) {
    this.precisionPrefix = `precision ${renderer.capabilities.precision} float;\n`;
  }

  render(material: Material, renderTarget: WebGLRenderTarget | null): void {
    this.fsQuad.material = material;
    this.renderer.setRenderTarget(renderTarget);
    this.fsQuad.render(this.renderer);
    this.renderer.setRenderTarget(null);
  }

  createRenderTarget(
    width: number,
    height: number,
    options?: RenderTargetOptions,
  ): WebGLRenderTarget {
    return new WebGLRenderTarget(width, height, {
      wrapS: ClampToEdgeWrapping,
      wrapT: ClampToEdgeWrapping,
      magFilter: LinearFilter,
      minFilter: LinearFilter,
      type: UnsignedByteType,
      anisotropy: 0,
      colorSpace: SRGBColorSpace,
      stencilBuffer: false,
      ...options,
    });
  }

  /**
   * `fragmentShaderPrefix` lets a caller demand a specific precision (some fluid passes need
   * `highp` to avoid visible quantisation; others are fine — and cheaper — at `mediump`). The
   * vertex shader always gets the renderer's own precision, since none of these passes do enough
   * vertex math for it to matter.
   */
  createRawShaderMaterial(options: {
    vertexShader: string;
    fragmentShader: string;
    uniforms: ShaderMaterialParameters['uniforms'];
    fragmentShaderPrefix: string;
    depthTest?: boolean;
    depthWrite?: boolean;
    defines?: Record<string, boolean>;
  }): RawShaderMaterial {
    return new RawShaderMaterial({
      uniforms: options.uniforms,
      depthTest: options.depthTest ?? false,
      depthWrite: options.depthWrite ?? false,
      ...(options.defines ? { defines: options.defines } : {}),
      vertexShader: this.precisionPrefix + options.vertexShader,
      fragmentShader: options.fragmentShaderPrefix + options.fragmentShader,
    });
  }

  dispose(): void {
    this.fsQuad.dispose();
  }
}
