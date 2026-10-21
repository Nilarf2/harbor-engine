import type { PerspectiveCamera, Scene, Texture } from 'three/webgpu';
import type { SampleCounts } from 'three-gpu-pathtracer/webgpu';
import type { PathTracingView } from './native-view.js';

export interface StaticDenoiseFrame {
  color: Texture;
  scene: Scene;
  camera: PerspectiveCamera;
  signal: AbortSignal;
}
export interface StaticDenoiser {
  denoise(frame: StaticDenoiseFrame): Promise<Texture>;
  reset(): void;
  dispose(): void | Promise<void>;
}
export type RefinementState = 'idle' | 'sampling' | 'denoising' | 'complete' | 'error';
export interface RefinementInspection {
  state: RefinementState;
  targetSamples: 64 | 256;
  samples: SampleCounts | null;
  revision: number;
  denoised: boolean;
  error?: string;
}

/**
 * Static-image lifecycle only. The application freezes its whole simulation while
 * active and calls tick after rendering. No polling loop blocks input or the RAF.
 */
export class StaticRefinementController {
  private state: RefinementState = 'idle';
  private target: 64 | 256 = 64;
  private capturedRevision = -1;
  private generation = 0;
  private active = false;
  private disposed = false;
  private measuring = false;
  private counts: SampleCounts | null = null;
  private result: Texture | null = null;
  private aborter: AbortController | undefined;
  private error: Error | undefined;
  private previousMaxSamples = 0;
  private task: Promise<void> | undefined;

  constructor(readonly view: PathTracingView, readonly denoiser: StaticDenoiser, private onError?: (error: Error) => void) {}

  get outputTexture(): Texture { return this.result && this.view.revision === this.capturedRevision ? this.result : this.view.outputTexture; }

  start(options: { samples?: 64 | 256 } = {}): void {
    if (this.disposed) throw new Error('Static refinement controller disposed');
    if (options.samples !== undefined && options.samples !== 64 && options.samples !== 256) throw new RangeError('Static refinement supports 64 or 256 minimum samples');
    if (!this.active) this.previousMaxSamples = this.view.pathTracer.maxSamples;
    this.cancelTask(); this.active = true; this.target = options.samples ?? 64;
    this.view.pathTracer.maxSamples = this.target;
    this.view.reset(); this.capture();
  }

  private cancelTask(): void {
    this.generation++; this.aborter?.abort(); this.aborter = undefined;
    this.denoiser.reset(); this.result = null; this.counts = null; this.error = undefined;
  }

  private capture(): void {
    this.capturedRevision = this.view.revision; this.state = 'sampling';
  }

  cancel(): void {
    this.cancelTask();
    if (this.active) this.view.pathTracer.maxSamples = this.previousMaxSamples;
    this.active = false; this.state = 'idle';
  }

  tick(): void {
    if (this.disposed || !this.active) return;
    if (this.capturedRevision !== this.view.revision) { this.cancelTask(); this.capture(); }
    if (this.state !== 'sampling' || this.measuring) return;
    this.measuring = true;
    const generation = this.generation, revision = this.capturedRevision;
    void this.view.measureSamples().then(counts => {
      if (!this.active || this.disposed || generation !== this.generation || revision !== this.view.revision) return;
      this.counts = { ...counts };
      // Average samples cannot establish completion of a partially sampled image.
      if (counts.min >= this.target) this.beginDenoise(generation, revision);
    }).catch(error => this.fail(error, generation)).finally(() => { this.measuring = false; });
  }

  private beginDenoise(generation: number, revision: number): void {
    this.state = 'denoising'; this.aborter = new AbortController();
    const signal = this.aborter.signal;
    this.task = (async () => {
      try {
        const result = await this.denoiser.denoise({ color: this.view.outputTexture, scene: this.view.preparedScene, camera: this.view.camera, signal });
        if (!signal.aborted && this.active && !this.disposed && generation === this.generation && revision === this.view.revision) { this.result = result; this.state = 'complete'; }
      } catch (error) { if (!signal.aborted) this.fail(error, generation); }
    })();
  }

  private fail(reason: unknown, generation: number): void {
    if (!this.active || this.disposed || generation !== this.generation) return;
    this.error = reason instanceof Error ? reason : new Error(String(reason)); this.result = null; this.state = 'error';
    try { this.onError?.(this.error); } catch { /* An error display callback must not create an unhandled rejection. */ }
  }

  inspect(): RefinementInspection {
    return { state: this.state, targetSamples: this.target, samples: this.counts, revision: this.capturedRevision,
      denoised: Boolean(this.result && this.view.revision === this.capturedRevision), ...(this.error ? { error: this.error.message } : {}) };
  }

  async dispose(): Promise<void> {
    if (this.disposed) return; this.cancel(); this.disposed = true;
    await this.task; await this.denoiser.dispose();
  }
}
