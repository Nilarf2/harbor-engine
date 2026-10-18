import type { Disposer } from './types.js';

/** Owns synchronous cleanup. Each registration runs once, in reverse order. */
export class Scope {
  private cleanups = new Set<Disposer>();
  private closed = false;
  get disposed(): boolean { return this.closed; }
  get size(): number { return this.cleanups.size; }

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

  dispose(): void {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const cleanup of [...this.cleanups].reverse()) {
      try { cleanup(); } catch (error) { errors.push(error); }
    }
    this.cleanups.clear();
    if (errors.length) throw new AggregateError(errors, 'Scope cleanup failed');
  }
}
