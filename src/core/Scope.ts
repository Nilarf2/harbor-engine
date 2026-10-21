import type { Disposer } from './types.js';

/** Owns synchronous cleanup. Each registration runs once, in reverse order. */
export class Scope {
  private cleanups = new Set<Disposer>();
  private closed = false;
  private controller = new AbortController();
  private unlinkParent?: () => void;
  constructor(parentSignal?: AbortSignal) {
    if (parentSignal) {
      const abort = () => this.controller.abort(parentSignal.reason);
      if (parentSignal.aborted) abort();
      else {
        parentSignal.addEventListener('abort', abort, { once: true });
        this.unlinkParent = () => parentSignal.removeEventListener('abort', abort);
      }
    }
  }
  get disposed(): boolean { return this.closed; }
  get size(): number { return this.cleanups.size; }
  /** Aborted before cleanup begins, including when a cleanup later throws. */
  get signal(): AbortSignal { return this.controller.signal; }

  add(cleanup: Disposer): Disposer {
    if (typeof cleanup !== 'function') throw new TypeError('Cleanup must be a function');
    let live = true;
    const once = () => {
      if (!live) return;
      live = false;
      this.cleanups.delete(once);
      cleanup();
    };
    if (this.closed) once();
    else this.cleanups.add(once);
    return once;
  }

  /** Alias used by application lifetimes; identical ownership rules to add(). */
  defer(cleanup: Disposer): Disposer { return this.add(cleanup); }

  listen(target: EventTarget, type: string, listener: EventListenerOrEventListenerObject, options?: AddEventListenerOptions | boolean): Disposer {
    target.addEventListener(type, listener, options);
    return this.add(() => target.removeEventListener(type, listener, options));
  }

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    this.unlinkParent?.(); this.unlinkParent = undefined;
    this.controller.abort();
    const errors: unknown[] = [];
    for (const cleanup of [...this.cleanups].reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    this.cleanups.clear();
    if (errors.length) throw new AggregateError(errors, 'Scope cleanup failed');
  }
}
