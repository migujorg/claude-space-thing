// Headless Chromium + SwiftShader never completes WebGPU canvas presentation, so screenshot tests
// (?present=offscreen) render into the renderer's offscreen target and blit the displayed pixels into
// the visible canvas with a 2D context. Real browsers use the renderer directly.

import type { PointSourceBuffer, RendererPort } from './ports';
import type { RendererStats, SceneSnapshot, StarCatalog } from '../render/scene';
import { Renderer } from '../render/renderer';
import type { CometModelProduct } from '../data/schema';

export class OffscreenPresenter implements RendererPort {
  private blitting: Promise<void> | null = null;
  private dirty = false;

  private constructor(private readonly r: Renderer, private readonly canvas: HTMLCanvasElement) {}

  static async create(canvas: HTMLCanvasElement): Promise<OffscreenPresenter> {
    const gpuCanvas = document.createElement('canvas');
    const r = await Renderer.create(gpuCanvas, { presentation: 'offscreen' });
    return new OffscreenPresenter(r, canvas);
  }

  get stats(): RendererStats {
    return this.r.stats;
  }

  /** Forwarded when the renderer offers it (small-body field). */
  get gpuDevice(): GPUDevice | undefined {
    return (this.r as unknown as Partial<Pick<RendererPort, 'gpuDevice'>>).gpuDevice;
  }

  get setExtraPointSources(): ((src: PointSourceBuffer | null) => void) | undefined {
    const r = this.r as unknown as Partial<Pick<RendererPort, 'setExtraPointSources'>>;
    return r.setExtraPointSources ? (src) => r.setExtraPointSources!.call(this.r, src) : undefined;
  }

  setCometModel(model: CometModelProduct | null): void {
    this.r.setCometModel(model);
  }

  setStars(c: StarCatalog): void {
    this.r.setStars(c);
  }

  resize(w: number, h: number, dpr: number): void {
    this.r.resize(w, h, dpr);
  }

  render(s: SceneSnapshot): void {
    this.r.render(s);
    this.dirty = true;
    if (!this.blitting) this.blitting = this.blit().finally(() => (this.blitting = null));
  }

  /** The GPU finished the last frame and its pixels are in the visible canvas. */
  async frameDone(): Promise<void> {
    await this.gpuDevice?.queue.onSubmittedWorkDone();
    if (this.blitting) await this.blitting;
  }

  async settled(): Promise<void> {
    await this.r.settled();
    if (this.blitting) await this.blitting;
    this.dirty = true;
    await this.blit();
  }

  private async blit(): Promise<void> {
    while (this.dirty) {
      this.dirty = false;
      const px = await this.r.readPixels();
      if (this.canvas.width !== px.width || this.canvas.height !== px.height) {
        this.canvas.width = px.width;
        this.canvas.height = px.height;
      }
      this.canvas.getContext('2d')!.putImageData(new ImageData(px.data, px.width, px.height), 0, 0);
    }
  }
}
