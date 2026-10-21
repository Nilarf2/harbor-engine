import { Scope } from '../core/Scope.js';
import type { ApplicationScene, SceneFactory } from './types.js';

interface Candidate<State> { scene: ApplicationScene<State>; scope: Scope; controller: AbortController }
export interface SceneManagerOptions { onCleanupError?: (error: Error) => void }

/** Latest load wins; failed preparation/activation keeps the previous scene alive. */
export class SceneManager<Services extends object, State = unknown, Manifest extends { id: string } = { id: string }> {
  private definitions = new Map<string, SceneFactory<Services, State, Manifest>>();
  private pending?: AbortController;
  private generation = 0;
  private closed = false;
  private active?: Candidate<State>;
  private operations = new Set<Promise<boolean>>();
  private commitTail: Promise<void> = Promise.resolve();
  private disposal?: Promise<void>;
  private disposedScenes = new WeakMap<ApplicationScene<State>, Promise<void>>();
  private managedScenes = new WeakSet<ApplicationScene<State>>();
  constructor(private readonly services: Services, private readonly options: SceneManagerOptions = {}) {}
  get current(): ApplicationScene<State> | undefined { return this.active?.scene; }
  get loading(): boolean { return this.pending !== undefined; }
  get disposed(): boolean { return this.closed; }
  register(definition: SceneFactory<Services, State, Manifest>): void {
    if (this.closed) throw new Error('Scene manager disposed');
    const id = definition?.manifest?.id;
    if (typeof id !== 'string' || !id || typeof definition.load !== 'function') throw new TypeError('Scene factory needs an ID and a load function');
    if (this.definitions.has(id)) throw new Error(`Duplicate scene: ${id}`);
    this.definitions.set(id, definition);
  }
  list(): Manifest[] { return [...this.definitions.values()].map(definition => definition.manifest); }
  switchTo(id: string, state?: State): Promise<boolean> {
    if (this.closed) return Promise.reject(new Error('Scene manager disposed'));
    const definition = this.definitions.get(id);
    if (!definition) return Promise.reject(new Error(`Unknown scene: ${id}`));
    this.pending?.abort();
    const controller = this.pending = new AbortController(), generation = ++this.generation;
    const operation = this.load(definition, state, controller, generation);
    this.operations.add(operation);
    void operation.then(() => this.operations.delete(operation), () => this.operations.delete(operation));
    return operation;
  }
  private cleanup(candidate: Candidate<State>): Promise<void> {
    let promise = this.disposedScenes.get(candidate.scene);
    if (promise) return promise;
    candidate.controller.abort();
    promise = (async () => {
      const errors: unknown[] = [];
      try { await candidate.scene.dispose(); } catch (error) { errors.push(error); }
      try { candidate.scope.dispose(); } catch (error) { errors.push(error); }
      if (errors.length) throw new AggregateError(errors, `Scene ${candidate.scene.id} cleanup failed`);
    })();
    this.disposedScenes.set(candidate.scene, promise);
    return promise;
  }
  private async load(definition: SceneFactory<Services, State, Manifest>, state: State | undefined, controller: AbortController, generation: number): Promise<boolean> {
    // Parent cancellation reaches scope.signal immediately, while deferred asset
    // cleanup still waits until the candidate view has drained its GPU work.
    const scope = new Scope(controller.signal);
    let candidate: Candidate<State> | undefined;
    let committed = false;
    let failed = false, failure: unknown;
    const stale = () => this.closed || controller.signal.aborted || generation !== this.generation;
    try {
      const scene = await definition.load({ ...this.services, signal: scope.signal, scope });
      if (scene && typeof scene === 'object' && this.managedScenes.has(scene)) throw new Error('A scene factory must return a fresh instance');
      candidate = { scene, scope, controller };
      if (scene && typeof scene === 'object') this.managedScenes.add(scene);
      if (!scene || scene.id !== definition.manifest.id || ['enter', 'update', 'render', 'resize', 'snapshot', 'restore', 'diagnostics', 'dispose'].some(key => typeof (scene as unknown as Record<string, unknown>)[key] !== 'function')) throw new TypeError(`Invalid scene instance: ${definition.manifest.id}`);
      if (stale()) return false;
      if (state !== undefined) scene.restore(state);
      // Serialize commit and awaited GPU teardown while allowing independent loads.
      const previousCommit = this.commitTail;
      let release!: () => void;
      this.commitTail = new Promise<void>(resolve => { release = resolve; });
      await previousCommit;
      try {
        if (stale()) return false;
        if (scene === this.current) throw new Error('A scene factory must return a fresh instance');
        const result: unknown = scene.enter();
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') throw new TypeError('Scene enter must be synchronous');
        // Activation may synchronously request another scene or dispose the host.
        if (stale()) return false;
        const previous = this.active;
        this.active = candidate; committed = true;
        if (previous) {
          try { await this.cleanup(previous); }
          catch (error) {
            if (this.options.onCleanupError) this.options.onCleanupError(error instanceof Error ? error : new Error(String(error)));
            else throw error;
          }
        }
        return true;
      } finally { release(); }
    } catch (error) {
      if (stale() && !committed) return false;
      failed = true; failure = error;
      throw error;
    } finally {
      try {
        if (!committed) {
          if (candidate && typeof candidate.scene?.dispose === 'function') await this.cleanup(candidate);
          else scope.dispose();
        }
      } catch (cleanupError) {
        if (failed) throw new AggregateError([failure, cleanupError], `Scene ${definition.manifest.id} preparation and cleanup failed`);
        throw cleanupError;
      } finally { if (this.pending === controller) this.pending = undefined; }
    }
  }
  dispose(): Promise<void> {
    if (this.disposal) return this.disposal;
    this.closed = true; this.generation++; this.pending?.abort(); this.pending = undefined;
    this.disposal = (async () => {
      const errors: unknown[] = [];
      const results = await Promise.allSettled([...this.operations]);
      for (const result of results) if (result.status === 'rejected') errors.push(result.reason);
      const active = this.active; this.active = undefined;
      if (active) try { await this.cleanup(active); } catch (error) { errors.push(error); }
      this.definitions.clear();
      if (errors.length) throw new AggregateError(errors, 'Scene manager cleanup failed');
    })();
    return this.disposal;
  }
}
