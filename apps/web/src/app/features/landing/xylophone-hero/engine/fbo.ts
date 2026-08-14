import { FloatType, type RenderTargetOptions, RGBAFormat, WebGLRenderTarget } from 'three';
import type { FboHelper } from './fbo-helper';

/**
 * Ping-pong render target pair — adapted from Sujen Phea's WebGL Xylophone (MIT). GPGPU passes
 * can't read and write the same texture, so each step reads `read` and renders into `write`,
 * then `swap()`s them.
 */
export class Fbo {
  private fbo1: WebGLRenderTarget;
  private fbo2: WebGLRenderTarget;

  constructor(fboHelper: FboHelper, width: number, height: number, options?: RenderTargetOptions) {
    const config: RenderTargetOptions = {
      format: RGBAFormat,
      type: FloatType,
      generateMipmaps: false,
      depthBuffer: false,
      ...options,
    };

    this.fbo1 = fboHelper.createRenderTarget(width, height, config);
    this.fbo2 = fboHelper.createRenderTarget(width, height, config);
  }

  get read(): WebGLRenderTarget {
    return this.fbo1;
  }

  get write(): WebGLRenderTarget {
    return this.fbo2;
  }

  swap(): void {
    const temp = this.fbo1;
    this.fbo1 = this.fbo2;
    this.fbo2 = temp;
  }

  /** Disposing a render target releases its texture too — don't dispose the texture separately. */
  dispose(): void {
    this.fbo1.dispose();
    this.fbo2.dispose();
  }
}
