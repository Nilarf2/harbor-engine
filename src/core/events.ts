import type { Disposer } from './types.js';

/** Listeners run synchronously in registration order; every listener is attempted. */
export class EventBus {
  private listeners = new Map<string, Set<(payload: unknown) => void>>();
  private closed = false;

  on<T>(type: string, listener: (payload: T) => void): Disposer {
    if (this.closed) throw new Error('Event bus disposed');
    if (!type || typeof type !== 'string') throw new TypeError('Event type must be a nonempty string');
    if (typeof listener !== 'function') throw new TypeError('Event listener must be a function');
    let group = this.listeners.get(type);
    if (!group) this.listeners.set(type, group = new Set());
    // A separate wrapper gives each subscription independent ownership.
    const wrapped = (payload: unknown) => listener(payload as T);
    group.add(wrapped);
    return () => {
      group.delete(wrapped);
      if (!group.size && this.listeners.get(type) === group) this.listeners.delete(type);
    };
  }

  emit(type: string, payload: unknown): void {
    if (this.closed) throw new Error('Event bus disposed');
    const group = this.listeners.get(type);
    if (!group) return;
    const errors: unknown[] = [];
    for (const listener of [...group]) {
      if (!group.has(listener)) continue;
      try { listener(payload); } catch (error) { errors.push(error); }
    }
    if (errors.length === 1) throw errors[0];
    if (errors.length) throw new AggregateError(errors, `Event ${type} failed`);
  }

  dispose(): void { this.closed = true; this.listeners.clear(); }
}
