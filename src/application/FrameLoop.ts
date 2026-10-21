import type { FrameScheduler } from './types.js';

export interface FrameLoopOptions { maxDelta?: number; scheduler?: FrameScheduler; onError?: (error: Error) => void }

/** Variable-second application timeline, independent of World's fixed ticks. */
export class FrameLoop {
  private callbacks = new Set<(dt: number, time: number) => void>();
  private handle: number | undefined;
  private previous: number | undefined;
  private requested = false;
  private closed = false;
  private stepping = false;
  private elapsed = 0;
  private readonly maxDelta: number;
  private readonly scheduler: FrameScheduler | undefined;
  constructor(private readonly options: FrameLoopOptions = {}) {
    this.maxDelta = options.maxDelta ?? 0.1;
    if (!Number.isFinite(this.maxDelta) || this.maxDelta <= 0) throw new RangeError('maxDelta must be positive and finite');
    this.scheduler = options.scheduler ?? (typeof globalThis.requestAnimationFrame === 'function' ? {
      now: () => performance.now(), request: callback => globalThis.requestAnimationFrame(callback), cancel: handle => globalThis.cancelAnimationFrame(handle),
    } : undefined);
  }
  get time(): number { return this.elapsed; }
  get running(): boolean { return this.requested && !this.closed; }
  add(callback: (dt: number, time: number) => void): () => void {
    if (this.closed) throw new Error('Frame loop disposed');
    if (typeof callback !== 'function') throw new TypeError('Frame callback must be a function');
    this.callbacks.add(callback);
    return () => this.callbacks.delete(callback);
  }
  step(dt: number): void {
    if (this.closed) throw new Error('Frame loop disposed');
    if (!Number.isFinite(dt) || dt < 0 || !Number.isFinite(this.elapsed + dt)) throw new RangeError('Timestep must be finite and nonnegative');
    if (this.stepping) throw new Error('Frame stepping is not reentrant');
    this.elapsed += dt; this.stepping = true;
    try {
      for (const callback of [...this.callbacks]) {
        if (this.closed) break;
        if (this.callbacks.has(callback)) callback(dt, this.elapsed);
      }
    } finally { this.stepping = false; }
  }
  start(): void {
    if (this.closed) throw new Error('Frame loop disposed');
    if (this.requested) return;
    if (!this.scheduler) throw new Error('Starting a frame loop requires a browser or an injected scheduler');
    this.requested = true; this.previous = this.scheduler.now(); this.schedule();
  }
  private schedule(): void {
    if (!this.requested || this.closed || this.handle !== undefined) return;
    this.handle = this.scheduler!.request(now => {
      this.handle = undefined;
      if (!this.requested || this.closed) return;
      const dt = this.previous === undefined ? 0 : Math.min(Math.max((now - this.previous) / 1000, 0), this.maxDelta);
      this.previous = now;
      try { this.step(dt); }
      catch (error) {
        this.stop();
        if (this.options.onError) this.options.onError(error instanceof Error ? error : new Error(String(error)));
        else console.error('[Harbor] Frame failed', error);
        return;
      }
      this.schedule();
    });
  }
  stop(): void {
    this.requested = false; this.previous = undefined;
    if (this.handle !== undefined) this.scheduler?.cancel(this.handle);
    this.handle = undefined;
  }
  dispose(): void { if (this.closed) return; this.stop(); this.closed = true; this.callbacks.clear(); }
}
