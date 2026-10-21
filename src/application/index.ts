import { Scope } from '../core/Scope.js';
import { FrameLoop } from './FrameLoop.js';
import { SceneManager } from './SceneManager.js';
import type { ApplicationHost, ApplicationOptions, ApplicationScene } from './types.js';
export { FrameLoop } from './FrameLoop.js';
export type { FrameLoopOptions } from './FrameLoop.js';
export { SceneManager } from './SceneManager.js';
export type { SceneManagerOptions } from './SceneManager.js';
export type * from './types.js';

export interface Application<Services extends object, State = unknown, Manifest extends { id: string } = { id: string }> {
  readonly manager: SceneManager<Services, State, Manifest>;
  readonly loop: FrameLoop;
  readonly current: ApplicationScene<State> | undefined;
  readonly running: boolean;
  readonly error: Error | undefined;
  start(): void;
  pause(): void;
  /** One application update with seconds, followed by at most one render. */
  step(seconds: number, render?: boolean): void;
  render(): void;
  resize(width?: number, height?: number): void;
  switchScene(id: string, state?: State): Promise<boolean>;
  snapshot(): State | undefined;
  inspect(): { running: boolean; loading: boolean; time: number; scene: Record<string, unknown> | undefined };
  /** Stops immediately; resolves after late candidates, scenes and shared services. */
  dispose(): Promise<void>;
}

function browserHost(): ApplicationHost {
  if (typeof window === 'undefined' || typeof window.requestAnimationFrame !== 'function') throw new Error('Application requires a browser or an injected host');
  const target = window, document = target.document;
  return {
    now: () => target.performance.now(), request: callback => target.requestAnimationFrame(callback), cancel: handle => target.cancelAnimationFrame(handle),
    get width() { return target.innerWidth; }, get height() { return target.innerHeight; }, get hidden() { return document.hidden; },
    listen(type, callback) {
      const eventTarget = type === 'visibilitychange' ? document : target;
      eventTarget.addEventListener(type, callback);
      return () => eventTarget.removeEventListener(type, callback);
    },
  };
}

/** Native-scene application host. It never replaces the caller's scene/materials/view. */
export function createApplication<Services extends object, State = unknown, Manifest extends { id: string } = { id: string }>(options: ApplicationOptions<Services, State, Manifest>): Application<Services, State, Manifest> {
  const host = options.host ?? browserHost(), scope = new Scope();
  let closed = false, requested = false, painting = true, error: Error | undefined, disposal: Promise<void> | undefined;
  const report = (value: unknown) => {
    error = value instanceof Error ? value : new Error(String(value));
    requested = false; loop.stop();
    if (options.onError) options.onError(error); else console.error('[Harbor] Application failed', error);
  };
  const manager = new SceneManager<Services, State, Manifest>(options.services, { onCleanupError: report });
  const loop = new FrameLoop({ maxDelta: options.maxFrameDelta ?? 0.1, scheduler: host, onError: report });
  const assertOpen = () => { if (closed) throw new Error('Application disposed'); };
  const resize = (width = host.width, height = host.height) => {
    assertOpen();
    if (![width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new RangeError('Application dimensions must be positive and finite');
    options.resizeServices?.(width, height); manager.current?.resize(width, height);
  };
  scope.add(loop.add((dt, time) => {
    if (closed || manager.loading) return;
    const scene = manager.current;
    scene?.update(dt, time);
    if (painting && !closed && manager.current === scene) scene?.render(time);
  }));
  const schedule = () => { loop.stop(); if (requested && !closed && !host.hidden) loop.start(); };
  try {
    for (const scene of options.scenes ?? []) manager.register(scene);
    scope.add(host.listen('visibilitychange', schedule));
    scope.add(host.listen('resize', () => { try { resize(); } catch (failure) { report(failure); } }));
  } catch (failure) { loop.dispose(); scope.dispose(); void manager.dispose(); throw failure; }
  const app: Application<Services, State, Manifest> = {
    manager, loop,
    get current() { return manager.current; }, get running() { return requested && loop.running && !closed; }, get error() { return error; },
    start() { assertOpen(); if (requested) return; requested = true; error = undefined; schedule(); },
    pause() { requested = false; loop.stop(); },
    step(seconds, render = true) {
      assertOpen();
      if (typeof render !== 'boolean') throw new TypeError('render must be boolean');
      painting = render;
      try { loop.step(seconds); } finally { painting = true; }
    },
    render() { assertOpen(); if (!manager.loading) manager.current?.render(loop.time); },
    resize,
    async switchScene(id, state) {
      assertOpen();
      const changed = await manager.switchTo(id, state);
      if (changed && !closed && !manager.loading && manager.current?.id === id) {
        resize(); manager.current.update(0, loop.time); manager.current.render(loop.time);
      }
      return changed;
    },
    snapshot: () => manager.current?.snapshot(),
    inspect: () => ({ running: app.running, loading: manager.loading, time: loop.time, scene: manager.current?.diagnostics() }),
    dispose() {
      if (disposal) return disposal;
      closed = true; requested = false; loop.dispose();
      const cleanupErrors: unknown[] = [];
      try { scope.dispose(); } catch (failure) { cleanupErrors.push(failure); }
      disposal = (async () => {
        try { await manager.dispose(); } catch (failure) { cleanupErrors.push(failure); }
        try { await options.disposeServices?.(); } catch (failure) { cleanupErrors.push(failure); }
        if (cleanupErrors.length) throw new AggregateError(cleanupErrors, 'Application cleanup failed');
      })();
      return disposal;
    },
  };
  if (options.autoStart !== false) app.start();
  return app;
}
