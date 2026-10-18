// Adapted from Nilarf2/dragon-raja-grand-escape (MIT), © 2026 Nilarf2.
export interface AssetLoader<T> { load(url: string, signal: AbortSignal): Promise<T>; dispose(value: T): void }
export interface AssetHandle<T> { value: T; release(): void }
type Entry = {
  refs: number; controller: AbortController; ready: boolean; freed: boolean;
  value?: unknown; promise: Promise<unknown>; expired: Promise<never>; dispose(value: unknown): void;
};

function freeValue(entry: Entry): void {
  if (!entry.ready || entry.freed) return;
  entry.freed = true;
  const value = entry.value;
  entry.value = undefined;
  entry.dispose(value);
}

/** Shared in-flight requests, explicit ownership, and safe disposal of late completions. */
export class AssetManager {
  private entries = new Map<string, Entry>();
  private loaders = new Map<string, AssetLoader<unknown>>();
  private closed = false;
  register<T>(type: string, loader: AssetLoader<T>) {
    if (this.closed) throw new Error('Asset manager disposed');
    if (typeof type !== 'string' || !type || typeof loader?.load !== 'function' || typeof loader?.dispose !== 'function') throw new TypeError('Expected an asset type and loader');
    if (this.loaders.has(type)) throw new Error(`Duplicate asset loader: ${type}`);
    this.loaders.set(type, loader as AssetLoader<unknown>);
  }
  get size() { return this.entries.size; }
  async acquire<T>(type: string, url: string, signal?: AbortSignal): Promise<AssetHandle<T>> {
    if (this.closed) throw new Error('Asset manager disposed');
    signal?.throwIfAborted();
    const key = JSON.stringify([type, url]);
    let entry = this.entries.get(key);
    if (!entry) {
      const loader = this.loaders.get(type);
      if (!loader) throw new Error(`Unknown asset type: ${type}`);
      const controller = new AbortController();
      const expired = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true });
      });
      const e: Entry = { refs: 0, ready: false, freed: false, controller, expired, promise: Promise.resolve(), dispose: v => loader.dispose(v) };
      e.promise = Promise.resolve().then(() => loader.load(url, e.controller.signal)).then(value => {
        e.ready = true; e.value = value;
        if (e.refs === 0) freeValue(e);
        return value;
      }).catch(error => { if (this.entries.get(key) === e) this.entries.delete(key); throw error; });
      this.entries.set(key, e); entry = e;
    }
    const e = entry;
    e.refs++;
    let released = false;
    const release = () => {
      if (released) return; released = true;
      if (this.closed) return;
      if (--e.refs === 0) {
        if (this.entries.get(key) === e) this.entries.delete(key);
        e.controller.abort();
        freeValue(e);
      }
    };
    let onAbort: (() => void) | undefined;
    const abort = new Promise<never>((_, reject) => {
      if (!signal) return;
      onAbort = () => { release(); reject(signal.reason ?? new DOMException('Aborted', 'AbortError')); };
      signal.addEventListener('abort', onAbort, { once: true });
    });
    try {
      const value = await Promise.race([e.promise, e.expired, abort]) as T;
      signal?.throwIfAborted();
      if (this.closed || e.controller.signal.aborted) throw new DOMException('Asset lifetime ended', 'AbortError');
      return { value, release };
    } catch (error) { release(); throw error; }
    finally { if (onAbort) signal?.removeEventListener('abort', onAbort); }
  }
  dispose() {
    if (this.closed) return;
    this.closed = true;
    const errors: unknown[] = [];
    for (const e of this.entries.values()) {
      e.controller.abort();
      e.refs = 0;
      try { freeValue(e); } catch (error) { errors.push(error); }
    }
    this.entries.clear();
    this.loaders.clear();
    if (errors.length) throw new AggregateError(errors, 'Asset cleanup failed');
  }
}
